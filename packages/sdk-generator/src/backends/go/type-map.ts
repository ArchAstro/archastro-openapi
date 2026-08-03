import type { FieldDef, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";

/**
 * Map a TypeRef to a Go type expression (the *value* form — pointer-ness for
 * struct fields is layered on by {@link goFieldType}).
 *
 * - Inline enums map to `string`; Go has no literal types and a typed
 *   constant set would break decoding when the server adds values.
 * - Inline (non-discriminated) unions and unknown values map to the
 *   runtime's `JSONValue`.
 * - Freeform objects map to `map[string]JSONValue`.
 *
 * `resolveRef` rewrites schema names through the package name registry
 * (Go compiles the SDK as a single package).
 */
export function typeRefToGo(
  ref: TypeRef,
  resolveRef: (schema: string) => string = (s) => s,
  runtimePrefix = ""
): string {
  switch (ref.kind) {
    case "primitive":
      return primitiveToGo(ref.type, runtimePrefix);
    case "array":
      return `[]${typeRefToGo(ref.items, resolveRef, runtimePrefix)}`;
    case "object":
      return `map[string]${runtimePrefix}JSONValue`;
    case "ref":
      return resolveRef(ref.schema);
    case "enum":
      return "string";
    case "union":
      return `${runtimePrefix}JSONValue`;
    case "optional":
      return goPointer(typeRefToGo(ref.inner, resolveRef, runtimePrefix));
    case "nullable":
      return goPointer(typeRefToGo(ref.inner, resolveRef, runtimePrefix));
    case "map":
      return `map[string]${typeRefToGo(ref.valueType, resolveRef, runtimePrefix)}`;
    case "unknown":
      return `${runtimePrefix}JSONValue`;
    case "void":
      return "";
  }
}

function primitiveToGo(type: string, runtimePrefix = ""): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
      return "int";
    case "float":
      return "float64";
    case "boolean":
      return "bool";
    case "datetime":
      return `${runtimePrefix}Time`;
    default:
      return `${runtimePrefix}JSONValue`;
  }
}

/**
 * Wrap a Go type in a pointer unless it already carries a nil state.
 * Slices, maps, and pointers are nilable as-is; every other type (including
 * the runtime's `JSONValue` struct) needs the indirection so `omitempty`
 * can actually omit an absent field.
 */
export function goPointer(base: string): string {
  if (base === "" || base.startsWith("*") || base.startsWith("[]") || base.startsWith("map[")) {
    return base;
  }
  if (base === "any") return base;
  return `*${base}`;
}

/** True when a Go type expression already has a meaningful nil value. */
export function isNilable(base: string): boolean {
  return (
    base.startsWith("*") ||
    base.startsWith("[]") ||
    base.startsWith("map[") ||
    base === "any"
  );
}

/**
 * Go type for a struct field.
 *
 * Refs are always pointers: it keeps recursive schemas legal (a Go struct
 * cannot contain itself by value) and gives every nested model an absent
 * state. Non-required fields get the same indirection so `omitempty` can
 * distinguish "unset" from "zero".
 */
export function goFieldType(
  field: FieldDef,
  resolveRef: (schema: string) => string = (s) => s,
  runtimePrefix = ""
): string {
  let base = typeRefToGo(field.type, resolveRef, runtimePrefix);
  if (field.type.kind === "ref") base = goPointer(base);
  if (!field.required) base = goPointer(base);
  return base;
}

/** JSON struct tag for a field, including `omitempty` for optional fields. */
export function goJSONTag(field: FieldDef): string {
  const optional = !field.required || field.type.kind === "optional";
  return `\`json:"${field.name}${optional ? ",omitempty" : ""}"\``;
}

export function unwrapOptional(ref: TypeRef): TypeRef {
  let inner = ref;
  while (inner.kind === "optional") {
    inner = inner.inner;
  }
  return inner;
}

/**
 * Go expression converting a value into the string form a query parameter
 * takes on the wire. Strings pass straight through; everything else goes
 * via the runtime's `queryParam` helper (which JSON-encodes composites).
 */
export function goQueryStringExpr(ref: TypeRef, expr: string): string {
  const inner = unwrapOptional(ref);
  if (inner.kind === "enum") return expr;
  if (inner.kind === "primitive" && inner.type === "string") return expr;
  return `queryParam(${expr})`;
}

/**
 * Render a complete Go file: license/generated header, package clause, a
 * grouped import block, then the body.
 */
export function renderGoFile(
  packageName: string,
  imports: ReadonlyArray<string>,
  body: string
): string {
  const cb = new CodeBuilder("\t");
  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line(`package ${packageName}`);

  const sorted = [...new Set(imports)].sort();
  if (sorted.length === 1) {
    cb.line();
    cb.line(`import "${sorted[0]}"`);
  } else if (sorted.length > 1) {
    cb.line();
    cb.line("import (");
    cb.indent();
    for (const mod of sorted) cb.line(`"${mod}"`);
    cb.dedent();
    cb.line(")");
  }

  const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
  if (trimmedBody.length > 0) {
    cb.line();
    for (const line of trimmedBody.split("\n")) cb.line(line);
  }
  return cb.toString();
}
