import type {
  FieldDef,
  SchemaDef,
  SdkSpec,
  TypeRef,
} from "@archastro/sdk-generator";

/**
 * Runtime fixture generator — walks a TypeRef (from the AST) and produces
 * a JavaScript value that satisfies the contract for validation purposes.
 *
 * Unlike backends/contract-tests/value-generator.ts (which emits source code),
 * this returns actual JS values for in-process use by the harness.
 */
export class FixtureGenerator {
  private schemas: Map<string, SchemaDef>;

  constructor(ast: SdkSpec) {
    this.schemas = new Map(ast.schemas.map((s) => [s.name, s]));
  }

  /** Generate a value for a TypeRef. */
  fromTypeRef(typeRef: TypeRef, fieldName?: string): unknown {
    switch (typeRef.kind) {
      case "primitive":
        return primitiveValue(typeRef.type, fieldName);
      case "array":
        return [this.fromTypeRef(typeRef.items)];
      case "object":
        return this.fromFields(typeRef.fields);
      case "ref":
        return this.fromSchemaName(typeRef.schema);
      case "enum":
        return typeRef.values[0] ?? "unknown";
      case "union":
        return typeRef.variants.length > 0
          ? this.fromTypeRef(typeRef.variants[0]!, fieldName)
          : null;
      case "optional":
        return this.fromTypeRef(typeRef.inner, fieldName);
      case "map":
        return {};
      case "unknown":
        return {};
      case "void":
        return null;
    }
  }

  /** Generate a value for a named schema from the AST. */
  fromSchemaName(name: string): unknown {
    const schema = this.schemas.get(name);
    if (!schema) return {};
    return this.fromFields(schema.fields);
  }

  private fromFields(fields: FieldDef[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (!f.required) continue;
      out[f.name] = this.fromTypeRef(f.type, f.name);
    }
    return out;
  }
}

function primitiveValue(
  type: "string" | "integer" | "float" | "boolean" | "datetime",
  fieldName?: string
): unknown {
  switch (type) {
    case "string":
      return stringForField(fieldName);
    case "integer":
      return 1;
    case "float":
      return 1.0;
    case "boolean":
      return true;
    case "datetime":
      return "2024-01-01T00:00:00Z";
  }
}

function stringForField(name?: string): string {
  if (!name) return "test-value";
  const lower = name.toLowerCase();
  if (lower === "name") return "test-name";
  if (lower === "email") return "test@example.com";
  if (lower.includes("url") || lower.includes("uri")) return "https://example.com";
  if (lower.includes("id")) return "test-id";
  if (lower.includes("content")) return "test content";
  if (lower.includes("token")) return "test-token";
  if (lower === "role") return "user";
  if (lower === "status") return "active";
  return "test-value";
}
