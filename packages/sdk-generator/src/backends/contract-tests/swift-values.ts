import type {
  BodyDef,
  FieldDef,
  SchemaDef,
  TypeRef,
} from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";
import { uniqueSwiftMemberNames } from "../swift/identifiers.js";
import { generateDummyValue, resolveBodyFields } from "./value-generator.js";

/**
 * How inline objects render in a typed position:
 * - "hoisted": inline objects were hoisted into sibling structs (resource
 *   inline inputs / channel payloads) — build `{Parent}{Field}(…)` inits.
 * - "json": inline objects stayed `[String: JSONValue]` (schema model
 *   fields) — build JSON dictionary literals.
 */
type ObjectMode = "hoisted" | "json";

/**
 * Swift dummy values for *typed* positions (struct initializers, typed
 * method parameters) — unlike `generateDummyValue`'s JSON-literal output,
 * these must satisfy the generated Swift types: hoisted inline objects
 * become struct initializers, refs become model initializers, and
 * datetimes become `isoDate(...)` calls (helper provided by the test
 * support module).
 *
 * Hoisted-name derivation mirrors `hoistInlineObjects` exactly:
 * `{Parent}{FieldPascal}`, `…Item` for array items, `…Value` for map values.
 */
export function swiftTypedValue(
  typeRef: TypeRef,
  fieldName: string | undefined,
  hoistName: string,
  schemas: SchemaDef[],
  mode: ObjectMode = "hoisted",
  seenSchemas: Set<string> = new Set()
): string {
  switch (typeRef.kind) {
    case "primitive":
      if (typeRef.type === "datetime") {
        return 'isoDate("2024-01-01T00:00:00Z")';
      }
      return generateDummyValue(typeRef, fieldName, "swift");
    case "enum":
      return generateDummyValue(typeRef, fieldName, "swift");
    case "nullable":
    case "optional":
      return swiftTypedValue(typeRef.inner, fieldName, hoistName, schemas, mode, seenSchemas);
    case "array": {
      const item = swiftTypedValue(
        typeRef.items,
        undefined,
        `${hoistName}Item`,
        schemas,
        mode,
        seenSchemas
      );
      return `[${item}]`;
    }
    case "map":
      return "[:]";
    case "object": {
      if (typeRef.fields.length === 0) return "[:]";
      if (mode === "json") {
        return generateDummyValue(typeRef, fieldName, "swift");
      }
      return swiftStructInit(typeRef.fields, hoistName, schemas, seenSchemas);
    }
    case "ref": {
      const schema = schemas.find((s) => s.name === typeRef.schema);
      if (!schema || schema.unionType || seenSchemas.has(typeRef.schema)) {
        // Unresolvable or cyclic — fall back to an empty init and let the
        // compiler surface a real gap if the schema has required fields.
        return `${typeRef.schema}()`;
      }
      const seen = new Set(seenSchemas);
      seen.add(typeRef.schema);
      // Schema model fields keep inline objects as [String: JSONValue].
      return swiftStructInit(schema.fields, typeRef.schema, schemas, seen, {
        typeName: typeRef.schema,
        mode: "json",
      });
    }
    case "union":
    case "unknown":
      return "[:]";
    case "void":
      return "JSONValue.null";
  }
}

/**
 * `TypeName(field: value, …)` initializer covering required fields only.
 * `hoistRoot` doubles as the type name unless overridden.
 */
function swiftStructInit(
  fields: ReadonlyArray<FieldDef>,
  hoistRoot: string,
  schemas: SchemaDef[],
  seenSchemas: Set<string>,
  opts: { typeName?: string; mode?: ObjectMode } = {}
): string {
  const typeName = opts.typeName ?? hoistRoot;
  const mode = opts.mode ?? "hoisted";
  const memberNames = uniqueSwiftMemberNames(fields.map((f) => f.name));
  const required: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field.required) continue;
    const value = swiftTypedValue(
      field.type,
      field.name,
      `${hoistRoot}${pascalCase(field.name)}`,
      schemas,
      mode,
      seenSchemas
    );
    required.push(`${memberNames[i]}: ${value}`);
  }
  return `${typeName}(${required.join(", ")})`;
}

/**
 * Swift expression for an operation's request body argument. Inline bodies
 * build the generated input struct; $ref bodies build the model; schemaless
 * bodies fall back to a `[String: JSONValue]` literal.
 */
export function swiftBodyValue(
  body: BodyDef,
  inputStructName: string | undefined,
  schemas: SchemaDef[]
): string {
  if (body.fields && body.fields.length > 0 && inputStructName) {
    return swiftStructInit(body.fields, inputStructName, schemas, new Set(), {
      typeName: inputStructName,
    });
  }
  if (body.schema && body.schema !== "inline") {
    return swiftTypedValue(
      { kind: "ref", schema: body.schema },
      undefined,
      body.schema,
      schemas
    );
  }
  const fields = resolveBodyFields(body, schemas);
  if (fields.length === 0) return "[:]";
  const required = fields.filter((f) => f.required);
  if (required.length === 0) return "[:]";
  const entries = required.map(
    (f) => `"${f.name}": ${generateDummyValue(f.type, f.name, "swift")}`
  );
  return `[${entries.join(", ")}]`;
}
