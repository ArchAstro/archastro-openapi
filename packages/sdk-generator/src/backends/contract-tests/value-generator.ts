import type { TypeRef, FieldDef, BodyDef, SchemaDef } from "../../ast/types.js";

/**
 * Render a JSON value (e.g. an OpenAPI `example`) as a language literal.
 *
 * Handles strings, numbers, booleans, null, arrays, and nested objects so a
 * spec example like `{"name": "Acme", "tags": ["a"]}` becomes idiomatic TS or
 * Python source.
 */
export function renderLiteral(
  value: unknown,
  lang: "typescript" | "python"
): string {
  if (value === null) return lang === "python" ? "None" : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    if (lang === "python") return value ? "True" : "False";
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => renderLiteral(v, lang)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => {
        const rendered = renderLiteral(v, lang);
        if (lang === "python") return `"${k}": ${rendered}`;
        const key = isValidIdentifier(k) ? k : JSON.stringify(k);
        return `${key}: ${rendered}`;
      }
    );
    if (entries.length === 0) return lang === "python" ? "{}" : "{}";
    return lang === "python"
      ? `{${entries.join(", ")}}`
      : `{ ${entries.join(", ")} }`;
  }
  return lang === "python" ? "None" : "undefined";
}

function isValidIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/**
 * Generate a value literal for a TypeRef.
 *
 * When an `example` is supplied (from the OpenAPI spec) it is rendered verbatim
 * — this is how docs samples use the same example values that appear in the
 * spec's JSON examples. Otherwise a name/type heuristic placeholder is used
 * (the behavior contract tests rely on).
 */
export function generateDummyValue(
  typeRef: TypeRef,
  fieldName?: string,
  lang: "typescript" | "python" = "typescript",
  example?: unknown
): string {
  if (example !== undefined) {
    return renderLiteral(example, lang);
  }
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

/** Options controlling how request-body / param literals are populated. */
export interface ValueOptions {
  /** Render the spec's `example` value for each field when available. */
  useExamples?: boolean;
  /** Include optional fields, not just required ones (docs samples want all). */
  includeOptional?: boolean;
}

/**
 * Generate a request body literal from a BodyDef.
 *
 * By default includes only required fields with heuristic placeholders (the
 * contract-test behavior). With `includeOptional` it emits every field, and
 * with `useExamples` it renders each field's spec `example` value.
 */
export function generateBodyLiteral(
  body: BodyDef,
  schemas: SchemaDef[],
  lang: "typescript" | "python",
  opts: ValueOptions = {}
): string {
  const fields = resolveBodyFields(body, schemas);
  if (fields.length === 0) return lang === "python" ? "{}" : "{}";

  const selected = opts.includeOptional ? fields : fields.filter((f) => f.required);
  if (selected.length === 0) return lang === "python" ? "{}" : "{}";

  const entries = selected.map((f) => {
    const value = generateDummyValue(
      f.type,
      f.name,
      lang,
      opts.useExamples ? f.example : undefined
    );
    return lang === "python" ? `"${f.name}": ${value}` : `${f.name}: ${value}`;
  });

  return lang === "python" ? `{${entries.join(", ")}}` : `{ ${entries.join(", ")} }`;
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
