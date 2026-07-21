import type { SchemaDef, TypeRef } from "../../ast/types.js";

/**
 * Map a TypeRef to a Swift type annotation.
 *
 * - Inline enums map to `String` — Swift has no literal types, and a raw
 *   enum would break decoding when the server adds values.
 * - Inline (non-discriminated) unions and unknown values map to the
 *   runtime's `JSONValue`.
 * - Freeform objects map to `[String: JSONValue]`.
 *
 * `resolveRef` lets callers rewrite schema names through the global name
 * registry (Swift is a single-namespace module).
 */
export function typeRefToSwift(
  ref: TypeRef,
  resolveRef: (schema: string) => string = (s) => s
): string {
  switch (ref.kind) {
    case "primitive":
      return primitiveToSwift(ref.type);
    case "array":
      return `[${typeRefToSwift(ref.items, resolveRef)}]`;
    case "object":
      return "[String: JSONValue]";
    case "ref":
      return resolveRef(ref.schema);
    case "enum":
      return "String";
    case "union":
      return "JSONValue";
    case "optional":
      return `${typeRefToSwift(ref.inner, resolveRef)}?`;
    case "map":
      return `[String: ${typeRefToSwift(ref.valueType, resolveRef)}]`;
    case "unknown":
      return "JSONValue";
    case "void":
      return "Void";
  }
}

function primitiveToSwift(type: string): string {
  switch (type) {
    case "string":
      return "String";
    case "integer":
      return "Int";
    case "float":
      return "Double";
    case "boolean":
      return "Bool";
    case "datetime":
      return "Date";
    default:
      return "JSONValue";
  }
}

export function isOptionalType(ref: TypeRef): boolean {
  return ref.kind === "optional";
}

export function unwrapOptional(ref: TypeRef): TypeRef {
  return ref.kind === "optional" ? ref.inner : ref;
}

/**
 * Swift expression converting a typed value into a `JSONValue`, for channel
 * join/message payload dictionaries. `expr` is the source expression.
 */
export function swiftToJSONValueExpr(ref: TypeRef, expr: string): string {
  const inner = unwrapOptional(ref);
  switch (inner.kind) {
    case "primitive":
      switch (inner.type) {
        case "string":
          return `.string(${expr})`;
        case "integer":
          return `.int(${expr})`;
        case "float":
          return `.double(${expr})`;
        case "boolean":
          return `.bool(${expr})`;
        case "datetime":
          return `.string(JSONCoding.isoString(from: ${expr}))`;
        default:
          return expr;
      }
    case "enum":
      return `.string(${expr})`;
    case "array": {
      const itemExpr = swiftToJSONValueExpr(inner.items, "$0");
      if (itemExpr === "$0") return `.array(${expr})`;
      return `.array(${expr}.map { ${itemExpr} })`;
    }
    case "map":
    case "object": {
      const valueExpr = swiftToJSONValueExpr(
        inner.kind === "map" ? inner.valueType : { kind: "unknown" },
        "$0"
      );
      if (valueExpr === "$0") return `.object(${expr})`;
      return `.object(${expr}.mapValues { ${valueExpr} })`;
    }
    default:
      // unknown / union already are JSONValue
      return expr;
  }
}

/**
 * Swift expression that stringifies a query parameter value for the wire.
 * `expr` is the (non-optional) source expression. Arrays are handled by
 * the caller (repeat-key), so this covers scalars only.
 */
export function swiftQueryStringExpr(ref: TypeRef, expr: string): string {
  const inner = unwrapOptional(ref);
  switch (inner.kind) {
    case "primitive":
      switch (inner.type) {
        case "string":
          return expr;
        case "integer":
        case "float":
          return `String(${expr})`;
        case "boolean":
          return `${expr} ? "true" : "false"`;
        case "datetime":
          return `JSONCoding.isoString(from: ${expr})`;
        default:
          return `${expr}.queryString`;
      }
    case "enum":
      return expr;
    case "map":
    case "object":
      // Typed as [String: JSONValue] — wrap before JSON-encoding.
      return `JSONValue.object(${expr}).queryString`;
    default:
      // Unions and unknown are JSONValue already — JSON-encode compactly.
      return `${expr}.queryString`;
  }
}

/** True if any TypeRef (recursively) uses the datetime primitive. */
export function typeRefsUseDate(types: ReadonlyArray<TypeRef>): boolean {
  return types.some(typeRefUsesDate);
}

function typeRefUsesDate(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "primitive":
      return ref.type === "datetime";
    case "array":
      return typeRefUsesDate(ref.items);
    case "object":
      return ref.fields.some((f) => typeRefUsesDate(f.type));
    case "optional":
      return typeRefUsesDate(ref.inner);
    case "union":
      return ref.variants.some(typeRefUsesDate);
    case "map":
      return typeRefUsesDate(ref.valueType);
    default:
      return false;
  }
}

/**
 * Schemas that participate in a by-value containment cycle (direct or
 * optional-wrapped refs — arrays and dictionaries box their elements, so
 * refs through them are fine). Swift structs cannot recursively contain
 * themselves; these are emitted as final classes instead.
 */
export function findValueCycleSchemas(schemas: SchemaDef[]): Set<string> {
  const edges = new Map<string, Set<string>>();
  const names = new Set(schemas.map((s) => s.name));

  const collect = (ref: TypeRef, out: Set<string>): void => {
    if (ref.kind === "ref" && names.has(ref.schema)) out.add(ref.schema);
    else if (ref.kind === "optional") collect(ref.inner, out);
  };

  for (const schema of schemas) {
    const out = new Set<string>();
    for (const field of schema.fields) collect(field.type, out);
    edges.set(schema.name, out);
  }

  const inCycle = new Set<string>();
  const color = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (n: string): void => {
    color.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (color.get(m) === 1) {
        const start = stack.indexOf(m);
        for (const x of stack.slice(start)) inCycle.add(x);
      } else if (!color.has(m)) {
        dfs(m);
      }
    }
    stack.pop();
    color.set(n, 2);
  };

  for (const schema of schemas) {
    if (!color.has(schema.name)) dfs(schema.name);
  }
  return inCycle;
}
