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
    return this.generateTypeRef(typeRef, fieldName, new Set());
  }

  private generateTypeRef(typeRef: TypeRef, fieldName: string | undefined, seen: Set<string>): unknown {
    switch (typeRef.kind) {
      case "primitive":
        return primitiveValue(typeRef.type, fieldName);
      case "array":
        return this.containsSeenReference(typeRef.items, seen, new Set())
          ? []
          : [this.generateTypeRef(typeRef.items, undefined, seen)];
      case "object":
        return this.fromFields(typeRef.fields, seen);
      case "ref":
        return this.generateSchema(typeRef.schema, seen);
      case "enum":
        return typeRef.values[0] ?? "unknown";
      case "union":
        return typeRef.variants.length > 0
          ? this.generateTypeRef(typeRef.variants[0]!, fieldName, seen)
          : null;
      case "optional":
        return this.generateTypeRef(typeRef.inner, fieldName, seen);
      case "nullable":
        return null;
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
    return this.generateSchema(name, new Set());
  }

  private generateSchema(name: string, seen: Set<string>): unknown {
    const schema = this.schemas.get(name);
    if (!schema) return {};
    if (seen.has(name)) return {};
    const nextSeen = new Set(seen).add(name);
    return schema.unionType
      ? this.generateTypeRef(schema.unionType, name, nextSeen)
      : this.fromFields(schema.fields, nextSeen);
  }

  private fromFields(fields: FieldDef[], seen: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (!f.required) continue;
      out[f.name] = this.generateTypeRef(f.type, f.name, seen);
    }
    return out;
  }

  private containsSeenReference(
    typeRef: TypeRef,
    seen: Set<string>,
    exploring: Set<string>
  ): boolean {
    switch (typeRef.kind) {
      case "ref": {
        if (seen.has(typeRef.schema)) return true;
        if (exploring.has(typeRef.schema)) return false;
        const schema = this.schemas.get(typeRef.schema);
        if (!schema) return false;
        const nextExploring = new Set(exploring).add(typeRef.schema);
        return schema.unionType
          ? this.containsSeenReference(schema.unionType, seen, nextExploring)
          : schema.fields.some((field) =>
            this.containsSeenReference(field.type, seen, nextExploring)
          );
      }
      case "array":
        return this.containsSeenReference(typeRef.items, seen, exploring);
      case "object":
        return typeRef.fields.some((field) =>
          this.containsSeenReference(field.type, seen, exploring)
        );
      case "nullable":
      case "optional":
        return this.containsSeenReference(typeRef.inner, seen, exploring);
      case "union":
        return typeRef.variants.some((variant) =>
          this.containsSeenReference(variant, seen, exploring)
        );
      default:
        return false;
    }
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
