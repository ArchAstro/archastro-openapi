import type {
  BodyDef,
  FieldDef,
  OperationDef,
  SchemaDef,
  TypeRef,
} from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";
import { GoNameRegistry, uniqueGoFieldNames } from "../go/identifiers.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import { goFieldType, typeRefToGo, unwrapOptional } from "../go/type-map.js";
import {
  goParamFieldNames,
  paramAsField,
  paramsKey,
} from "../go/resource-emitter.js";
import { generateDummyValue } from "./value-generator.js";

/**
 * How inline objects render in a typed position, mirroring what the SDK
 * emitters did with them:
 * - "hoisted": inline objects were pulled out into sibling structs (resource
 *   inline inputs, channel message inputs, push payloads) — build
 *   `pkg.{Parent}{Field}{…}` literals.
 * - "json": inline objects stayed `map[string]JSONValue` (schema model
 *   fields, query parameters, channel join params) — build map literals of
 *   `JSONOf(…)` values.
 */
type ObjectMode = "hoisted" | "json";

export interface GoValueContext {
  /** Import alias for the generated SDK package, e.g. "platform". */
  pkg: string;
  registry: GoNameRegistry;
  schemas: SchemaDef[];
}

/** Recursion state: hoisted struct shapes in scope, plus the cycle guard. */
interface Frame {
  /** Fields of each inline struct hoisted out of the current root. */
  hoisted: Map<string, ReadonlyArray<FieldDef>>;
  /** Schema/struct names already being constructed, to stop ref cycles. */
  seen: Set<string>;
}

function newFrame(): Frame {
  return { hoisted: new Map(), seen: new Set() };
}

/** Qualified Go type name for a spec schema (or a hoisted inline struct). */
export function goQualifiedRef(ctx: GoValueContext, schema: string): string {
  const name = ctx.registry.has(`schema:${schema}`)
    ? ctx.registry.lookup(`schema:${schema}`)
    : schema;
  return `${ctx.pkg}.${name}`;
}

/** Qualified Go type expression for a TypeRef in the contract-test package. */
export function goQualifiedType(ctx: GoValueContext, ref: TypeRef): string {
  return typeRefToGo(ref, (schema) => goQualifiedRef(ctx, schema), `${ctx.pkg}.`);
}

function qualifiedFieldType(ctx: GoValueContext, field: FieldDef): string {
  return goFieldType(field, (schema) => goQualifiedRef(ctx, schema), `${ctx.pkg}.`);
}

/**
 * Go dummy value for a *typed* position (struct literal field, typed method
 * parameter) — unlike `generateDummyValue`'s JSON-shaped output, this must
 * satisfy the exact Go type the SDK emitters generated.
 *
 * Datetimes become `isoTime(…)` calls (helper provided by the test support
 * file), refs become model literals, and hoisted inline objects become the
 * sibling struct the resource/channel emitter wrote out.
 */
export function goTypedValue(
  typeRef: TypeRef,
  fieldName: string | undefined,
  hoistName: string,
  ctx: GoValueContext,
  mode: ObjectMode = "hoisted",
  frame: Frame = newFrame()
): string {
  switch (typeRef.kind) {
    case "primitive":
      if (typeRef.type === "datetime") {
        return 'isoTime("2024-01-01T00:00:00Z")';
      }
      return generateDummyValue(typeRef, fieldName, "go");
    case "enum":
      return generateDummyValue(typeRef, fieldName, "go");
    case "optional":
      return goTypedValue(typeRef.inner, fieldName, hoistName, ctx, mode, frame);
    case "array": {
      const item = goTypedValue(
        typeRef.items,
        undefined,
        `${hoistName}Item`,
        ctx,
        mode,
        frame
      );
      return `${goQualifiedType(ctx, typeRef)}{${item}}`;
    }
    case "map":
      // An empty map, not nil: a nil map marshals to JSON null, which the
      // mock server rejects wherever the field is required.
      return `${goQualifiedType(ctx, typeRef)}{}`;
    case "object": {
      if (mode === "json" || typeRef.fields.length === 0) {
        return goJSONObjectLiteral(typeRef.fields, ctx);
      }
      return goStructLiteral(typeRef.fields, hoistName, ctx, frame, {
        typeName: `${ctx.pkg}.${hoistName}`,
        mode,
      });
    }
    case "ref": {
      const typeName = goQualifiedRef(ctx, typeRef.schema);
      if (frame.seen.has(typeRef.schema)) {
        return `${typeName}{}`;
      }
      const nested = new Set(frame.seen);
      nested.add(typeRef.schema);

      // A hoisted inline struct: its shape lives in this frame, not the spec.
      const hoistedFields = frame.hoisted.get(typeRef.schema);
      if (hoistedFields) {
        return goStructLiteral(
          hoistedFields,
          typeRef.schema,
          ctx,
          { hoisted: frame.hoisted, seen: nested },
          { typeName, mode: "hoisted", alreadyHoisted: true }
        );
      }

      const schema = ctx.schemas.find((s) => s.name === typeRef.schema);
      if (!schema || schema.unionType) {
        // Unresolvable or a union — an empty literal keeps the test
        // compiling and lets the compiler surface a real gap.
        return `${typeName}{}`;
      }
      // Schema model fields keep inline objects as map[string]JSONValue.
      return goStructLiteral(
        schema.fields,
        typeRef.schema,
        ctx,
        { hoisted: frame.hoisted, seen: nested },
        { typeName, mode: "json" }
      );
    }
    case "union":
    case "unknown":
      return `${ctx.pkg}.JSONOf(map[string]any{})`;
    case "void":
      return `${ctx.pkg}.JSONValue{}`;
  }
}

/** `map[string]pkg.JSONValue{…}` literal covering required fields only. */
function goJSONObjectLiteral(
  fields: ReadonlyArray<FieldDef>,
  ctx: GoValueContext
): string {
  const entries = fields
    .filter((f) => f.required)
    .map(
      (f) =>
        `"${f.name}": ${ctx.pkg}.JSONOf(${generateDummyValue(f.type, f.name, "go")})`
    );
  return `map[string]${ctx.pkg}.JSONValue{${entries.join(", ")}}`;
}

interface StructLiteralOptions {
  /** Qualified Go type being constructed. */
  typeName: string;
  mode?: ObjectMode;
  /** Include optional fields, not just required ones. */
  includeOptional?: boolean;
  /** Set when `fields` already came out of a hoist pass. */
  alreadyHoisted?: boolean;
}

/**
 * `pkg.TypeName{Field: value, …}` literal.
 *
 * In "hoisted" mode the fields are run through the same
 * {@link hoistInlineObjects} pass the SDK emitter used, so field types (and
 * therefore pointer-ness) match the generated struct exactly.
 */
function goStructLiteral(
  fields: ReadonlyArray<FieldDef>,
  hoistRoot: string,
  ctx: GoValueContext,
  frame: Frame,
  opts: StructLiteralOptions
): string {
  const mode = opts.mode ?? "hoisted";
  let effective = fields;
  let nested = frame;

  if (mode === "hoisted" && !opts.alreadyHoisted) {
    const hoist = hoistInlineObjects(fields, hoistRoot, "typeddict");
    const hoisted = new Map(frame.hoisted);
    for (const group of hoist.hoisted) hoisted.set(group.name, group.fields);
    effective = hoist.fields;
    nested = { hoisted, seen: frame.seen };
  }

  const memberNames = uniqueGoFieldNames(effective.map((f) => f.name));
  const entries: string[] = [];
  for (let i = 0; i < effective.length; i++) {
    const field = effective[i]!;
    if (!field.required && !opts.includeOptional) continue;
    entries.push(`${memberNames[i]}: ${goFieldValue(field, hoistRoot, ctx, mode, nested)}`);
  }
  return `${opts.typeName}{${entries.join(", ")}}`;
}

/**
 * Value expression for one struct field, matching the pointer-ness the model
 * emitter gave that field. Pointer fields wrap through the runtime's generic
 * `Ptr` helper, which works for scalars and structs alike.
 */
function goFieldValue(
  field: FieldDef,
  hoistRoot: string,
  ctx: GoValueContext,
  mode: ObjectMode,
  frame: Frame
): string {
  const value = goTypedValue(
    field.type,
    field.name,
    `${hoistRoot}${pascalCase(field.name)}`,
    ctx,
    mode,
    frame
  );
  return qualifiedFieldType(ctx, field).startsWith("*")
    ? `${ctx.pkg}.Ptr(${value})`
    : value;
}

/**
 * Go expression for an operation's request-body argument. Inline bodies
 * build the generated input struct; `$ref` bodies build the model;
 * schemaless bodies fall back to a `map[string]JSONValue` literal.
 */
export function goBodyValue(
  body: BodyDef,
  inputStructName: string | undefined,
  ctx: GoValueContext
): string {
  if (body.fields && body.fields.length > 0 && inputStructName) {
    return goStructLiteral(body.fields, inputStructName, ctx, newFrame(), {
      typeName: `${ctx.pkg}.${inputStructName}`,
      mode: "hoisted",
    });
  }
  if (body.schema && body.schema !== "inline") {
    return goTypedValue(
      { kind: "ref", schema: body.schema },
      undefined,
      body.schema,
      ctx
    );
  }
  return `map[string]${ctx.pkg}.JSONValue{}`;
}

/**
 * Go expression for a hoisted inline struct built from a parameter list —
 * the shape channel message payloads take. Optional fields are included so
 * the harness sees the full declared payload, matching the Python and Swift
 * channel tests.
 */
export function goInlineStructValue(
  fields: ReadonlyArray<FieldDef>,
  structName: string,
  ctx: GoValueContext
): string {
  return goStructLiteral(fields, structName, ctx, newFrame(), {
    typeName: `${ctx.pkg}.${structName}`,
    mode: "hoisted",
    includeOptional: true,
  });
}

/**
 * Go expression for a value in an un-hoisted typed position — channel join
 * parameters, whose types come straight from the TypeRef.
 */
export function goPlainTypedValue(
  typeRef: TypeRef,
  fieldName: string,
  ctx: GoValueContext
): string {
  return goTypedValue(unwrapOptional(typeRef), fieldName, pascalCase(fieldName), ctx, "json");
}

/**
 * Go expression for an operation's query-parameter struct argument, filled
 * with the required parameters only (matching the Swift and Python contract
 * tests, which omit optional parameters).
 */
export function goParamsValue(op: OperationDef, ctx: GoValueContext): string {
  const typeName = `${ctx.pkg}.${ctx.registry.lookup(paramsKey(op))}`;
  const fieldNames = goParamFieldNames(op);
  const entries: string[] = [];
  for (let i = 0; i < op.queryParams.length; i++) {
    const param = op.queryParams[i]!;
    if (!param.required || param.type.kind === "optional") continue;
    const field = paramAsField(param);
    const value = goTypedValue(
      unwrapOptional(param.type),
      param.name,
      pascalCase(param.name),
      ctx,
      "json"
    );
    entries.push(
      `${fieldNames[i]}: ${qualifiedFieldType(ctx, field).startsWith("*") ? `${ctx.pkg}.Ptr(${value})` : value}`
    );
  }
  return `${typeName}{${entries.join(", ")}}`;
}
