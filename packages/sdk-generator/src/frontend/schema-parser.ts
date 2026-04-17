import type {
  SchemaDef,
  FieldDef,
  TypeRef,
  TypeDef,
} from "../ast/types.js";

// ─── OpenAPI JSON Schema subset we consume ───────────────────────

interface JsonSchema {
  type?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  examples?: unknown[];
  pattern?: string;
  nullable?: boolean;
  "x-sdk"?: string;
}

interface OpenApiComponents {
  schemas?: Record<string, JsonSchema>;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse OpenAPI component schemas into SchemaDef[] and TypeDef[].
 *
 * Returns schemas (object models) and types (custom scalars) separately.
 */
export function parseSchemas(components: OpenApiComponents): {
  schemas: SchemaDef[];
  types: TypeDef[];
} {
  const schemas: SchemaDef[] = [];
  const types: TypeDef[] = [];

  if (!components.schemas) return { schemas, types };

  for (const [name, jsonSchema] of Object.entries(components.schemas)) {
    if (isScalarType(jsonSchema)) {
      types.push(parseTypeDef(name, jsonSchema));
    } else {
      schemas.push(parseSchemaDef(name, jsonSchema));
    }
  }

  // Annotate each schema with its ref dependencies
  for (const schema of schemas) {
    const deps = new Set<string>();
    for (const field of schema.fields) {
      collectRefsFromTypeRef(field.type, deps);
    }
    deps.delete(schema.name); // exclude self-references
    schema.refDeps = [...deps];
  }

  // Topological sort: schemas that are depended on come before dependents
  return { schemas: topoSortSchemas(schemas), types };
}

/**
 * Convert a JSON Schema into our TypeRef representation.
 */
export function jsonSchemaToTypeRef(schema: JsonSchema): TypeRef {
  if (schema.$ref) {
    return { kind: "ref", schema: extractRefName(schema.$ref) };
  }

  if (schema.enum) {
    return {
      kind: "enum",
      values: schema.enum.map(String),
    };
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf)!.map(jsonSchemaToTypeRef);
    // If one of the variants is null (nullable), wrap in optional
    const nonNull = variants.filter(
      (v) => !(v.kind === "primitive" && v.type === "string" && false)
    );
    return nonNull.length === 1 ? nonNull[0]! : { kind: "union", variants };
  }

  if (schema.allOf) {
    // Merge allOf into a single object schema
    const fields: FieldDef[] = [];
    for (const sub of schema.allOf) {
      const ref = jsonSchemaToTypeRef(sub);
      if (ref.kind === "object") {
        fields.push(...ref.fields);
      }
    }
    if (fields.length > 0) return { kind: "object", fields };
    // If allOf contains only refs, return the first one
    return jsonSchemaToTypeRef(schema.allOf[0]!);
  }

  if (schema.nullable) {
    const inner = jsonSchemaToTypeRef({ ...schema, nullable: undefined });
    return { kind: "optional", inner };
  }

  switch (schema.type) {
    case "string":
      if (schema.format === "date-time" || schema.format === "datetime") {
        return { kind: "primitive", type: "datetime" };
      }
      return { kind: "primitive", type: "string" };

    case "integer":
      return { kind: "primitive", type: "integer" };

    case "number":
      return { kind: "primitive", type: "float" };

    case "boolean":
      return { kind: "primitive", type: "boolean" };

    case "array":
      return {
        kind: "array",
        items: schema.items
          ? jsonSchemaToTypeRef(schema.items)
          : { kind: "unknown" },
      };

    case "object": {
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        return {
          kind: "map",
          keyType: { kind: "primitive", type: "string" },
          valueType: jsonSchemaToTypeRef(schema.additionalProperties),
        };
      }
      if (schema.properties) {
        return {
          kind: "object",
          fields: parseFields(schema),
        };
      }
      // A bare {"type": "object"} with no properties means a map with
      // unknown values (Record<string, unknown>), not z.unknown().
      // This also handles additionalProperties: true.
      return {
        kind: "map",
        keyType: { kind: "primitive", type: "string" },
        valueType: { kind: "unknown" },
      };
    }

    default:
      return { kind: "unknown" };
  }
}

// ─── Internal ────────────────────────────────────────────────────

function isScalarType(schema: JsonSchema): boolean {
  return (
    schema.type !== "object" &&
    schema.type !== "array" &&
    !schema.properties &&
    !schema.allOf &&
    !schema.anyOf &&
    !schema.oneOf
  );
}

function parseTypeDef(name: string, schema: JsonSchema): TypeDef {
  let baseType: TypeDef["baseType"] = "string";
  switch (schema.type) {
    case "integer":
      baseType = "integer";
      break;
    case "number":
      baseType = "float";
      break;
    case "boolean":
      baseType = "boolean";
      break;
    case "string":
      if (schema.format === "date-time") baseType = "datetime";
      else baseType = "string";
      break;
  }

  return {
    name,
    baseType,
    description: schema.description,
    examples: schema.examples as string[] | undefined,
    pattern: schema.pattern,
  };
}

function parseSchemaDef(name: string, schema: JsonSchema): SchemaDef {
  // Handle allOf by merging schemas
  let merged = schema;
  if (schema.allOf) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const sub of schema.allOf) {
      if (sub.properties) Object.assign(properties, sub.properties);
      if (sub.required) required.push(...sub.required);
    }
    merged = { ...schema, type: "object", properties, required };
  }

  return {
    name,
    description: merged.description ?? schema.description,
    fields: parseFields(merged),
  };
}

function parseFields(schema: JsonSchema): FieldDef[] {
  if (!schema.properties) return [];

  const requiredSet = new Set(schema.required ?? []);
  const fields: FieldDef[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    const isRequired = requiredSet.has(fieldName);
    let type = jsonSchemaToTypeRef(fieldSchema);

    // Wrap non-required fields in optional if not already
    if (!isRequired && type.kind !== "optional") {
      type = { kind: "optional", inner: type };
    }

    fields.push({
      name: fieldName,
      type,
      required: isRequired,
      default: fieldSchema.default,
      description: fieldSchema.description,
      sdkRole: fieldSchema["x-sdk"] as string | undefined,
    });
  }

  return fields;
}

function extractRefName(ref: string): string {
  // "#/components/schemas/Team" → "Team"
  const parts = ref.split("/");
  return parts[parts.length - 1]!;
}

// ─── Ref dependency collection & topological sort ────────────────

function collectRefsFromTypeRef(ref: TypeRef, deps: Set<string>): void {
  switch (ref.kind) {
    case "ref":
      deps.add(ref.schema);
      break;
    case "array":
      collectRefsFromTypeRef(ref.items, deps);
      break;
    case "object":
      for (const f of ref.fields) collectRefsFromTypeRef(f.type, deps);
      break;
    case "optional":
      collectRefsFromTypeRef(ref.inner, deps);
      break;
    case "union":
      for (const v of ref.variants) collectRefsFromTypeRef(v, deps);
      break;
    case "map":
      collectRefsFromTypeRef(ref.valueType, deps);
      break;
  }
}

/**
 * Topological sort of schemas so referenced schemas come before dependents.
 * Preserves original order for schemas with no inter-dependencies.
 * Breaks cycles gracefully (circular refs keep their original order).
 */
function topoSortSchemas(schemas: SchemaDef[]): SchemaDef[] {
  const nameSet = new Set(schemas.map((s) => s.name));
  const byName = new Map(schemas.map((s) => [s.name, s]));
  const deps = new Map(
    schemas.map((s) => [
      s.name,
      new Set((s.refDeps ?? []).filter((d) => nameSet.has(d))),
    ])
  );

  const sorted: SchemaDef[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) return; // break cycles
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(byName.get(name)!);
  }

  for (const schema of schemas) {
    visit(schema.name);
  }

  return sorted;
}
