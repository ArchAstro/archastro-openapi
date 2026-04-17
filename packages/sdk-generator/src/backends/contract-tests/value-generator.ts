import type { TypeRef, FieldDef, BodyDef, SchemaDef } from "../../ast/types.js";

/**
 * Generate a dummy value literal for a TypeRef.
 *
 * Used to synthesize valid request bodies and path params for contract tests.
 */
export function generateDummyValue(
  typeRef: TypeRef,
  fieldName?: string,
  lang: "typescript" | "python" = "typescript"
): string {
  switch (typeRef.kind) {
    case "primitive":
      return generatePrimitiveValue(typeRef.type, fieldName, lang);
    case "array":
      // Generate one element so Prism doesn't reject empty required arrays
      if (typeRef.items) {
        const itemVal = generateDummyValue(typeRef.items, undefined, lang);
        return `[${itemVal}]`;
      }
      return lang === "python" ? "[]" : "[]";
    case "object":
      return generateObjectValue(typeRef.fields, lang);
    case "ref":
      return lang === "python" ? "{}" : "{}";
    case "enum":
      return typeRef.values.length > 0
        ? `"${typeRef.values[0]}"`
        : `"unknown"`;
    case "union":
      return typeRef.variants.length > 0
        ? generateDummyValue(typeRef.variants[0]!, fieldName, lang)
        : lang === "python" ? "None" : "undefined";
    case "optional":
      return generateDummyValue(typeRef.inner, fieldName, lang);
    case "map":
      return lang === "python" ? "{}" : "{}";
    case "unknown":
      return lang === "python" ? "{}" : "{}";
    case "void":
      return lang === "python" ? "None" : "undefined";
  }
}

function generateObjectValue(
  fields: FieldDef[],
  lang: "typescript" | "python"
): string {
  if (!fields || fields.length === 0) return lang === "python" ? "{}" : "{}";

  const requiredFields = fields.filter((f) => f.required);
  if (requiredFields.length === 0) return lang === "python" ? "{}" : "{}";

  if (lang === "python") {
    const entries = requiredFields.map(
      (f) => `"${f.name}": ${generateDummyValue(f.type, f.name, "python")}`
    );
    return `{${entries.join(", ")}}`;
  } else {
    const entries = requiredFields.map(
      (f) => `${f.name}: ${generateDummyValue(f.type, f.name, "typescript")}`
    );
    return `{ ${entries.join(", ")} }`;
  }
}

function generatePrimitiveValue(
  type: string,
  fieldName?: string,
  lang: "typescript" | "python" = "typescript"
): string {
  switch (type) {
    case "string":
      return stringValueForField(fieldName);
    case "integer":
      return "1";
    case "float":
      return "1.0";
    case "boolean":
      return lang === "python" ? "True" : "true";
    case "datetime":
      return '"2024-01-01T00:00:00Z"';
    default:
      return '"test-value"';
  }
}

/**
 * Heuristic: pick a sensible dummy string based on the field name.
 */
function stringValueForField(fieldName?: string): string {
  if (!fieldName) return '"test-value"';

  const lower = fieldName.toLowerCase();

  if (lower === "name") return '"test-name"';
  if (lower === "email") return '"test@example.com"';
  if (lower.includes("url") || lower.includes("uri")) return '"https://example.com"';
  if (lower === "password") return '"Password1234!"';
  if (lower === "description" || lower === "identity") return '"test description"';
  if (lower === "kind" || lower === "type") return '"test"';
  if (lower.includes("mime")) return '"application/json"';
  if (lower.includes("content") && !lower.includes("type")) return '"test content"';
  if (lower.includes("token")) return '"test-token"';
  if (lower.includes("key")) return '"test-key"';
  if (lower.includes("id")) return '"test-id"';
  if (lower === "provider") return '"test-provider"';
  if (lower === "model") return '"test-model"';
  if (lower === "role") return '"user"';
  if (lower === "status") return '"active"';
  if (lower.includes("cron")) return '"0 * * * *"';
  if (lower === "timezone") return '"UTC"';

  return '"test-value"';
}

/**
 * Generate a request body literal from a BodyDef.
 *
 * Only includes required fields. If the body is a schema ref,
 * resolves it from the schemas list.
 */
export function generateBodyLiteral(
  body: BodyDef,
  schemas: SchemaDef[],
  lang: "typescript" | "python"
): string {
  const fields = resolveBodyFields(body, schemas);
  if (fields.length === 0) return lang === "python" ? "{}" : "{}";

  // Only include required fields
  const requiredFields = fields.filter((f) => f.required);
  if (requiredFields.length === 0) return lang === "python" ? "{}" : "{}";

  if (lang === "python") {
    const entries = requiredFields.map(
      (f) => `"${f.name}": ${generateDummyValue(f.type, f.name, "python")}`
    );
    return `{${entries.join(", ")}}`;
  } else {
    const entries = requiredFields.map(
      (f) => `${f.name}: ${generateDummyValue(f.type, f.name, "typescript")}`
    );
    return `{ ${entries.join(", ")} }`;
  }
}

function resolveBodyFields(
  body: BodyDef,
  schemas: SchemaDef[]
): FieldDef[] {
  // Inline fields available directly
  if (body.fields && body.fields.length > 0) {
    return body.fields;
  }

  // Try to resolve from schemas by ref name
  if (body.schema && body.schema !== "inline") {
    const schema = schemas.find((s) => s.name === body.schema);
    if (schema) {
      return schema.fields;
    }
  }

  return [];
}
