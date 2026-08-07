import type { TypeRef, FieldDef, BodyDef, SchemaDef } from "../../ast/types.js";

/** Languages the value/literal renderers can emit. */
export type ValueLang = "typescript" | "python" | "swift" | "go" | "elixir";

/**
 * Render a JSON value (e.g. an OpenAPI `example`) as a language literal.
 *
 * Handles strings, numbers, booleans, null, arrays, and nested objects so a
 * spec example like `{"name": "Acme", "tags": ["a"]}` becomes idiomatic TS,
 * Python, Swift, or Go source. Swift literals target `JSONValue`-typed
 * positions (dictionary/array/scalar literals all work via
 * ExpressibleBy…Literal); Go literals target `any`-typed positions, which is
 * what the runtime's `JSONOf` helper accepts.
 */
export function renderLiteral(value: unknown, lang: ValueLang): string {
  if (value === null) {
    if (lang === "elixir") return "nil";
    if (lang === "python") return "None";
    if (lang === "swift") return "JSONValue.null";
    if (lang === "go") return "nil";
    return "null";
  }
  if (typeof value === "string") return lang === "elixir" ? elixirString(value) : JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    if (lang === "python") return value ? "True" : "False";
    return String(value);
  }
  if (Array.isArray(value)) {
    if (lang === "go") {
      return `[]any{${value.map((v) => renderLiteral(v, lang)).join(", ")}}`;
    }
    return `[${value.map((v) => renderLiteral(v, lang)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => {
        const rendered = renderLiteral(v, lang);
        if (lang === "python" || lang === "swift" || lang === "go") {
          return `"${k}": ${rendered}`;
        }
        if (lang === "elixir") return `${elixirString(k)} => ${rendered}`;
        const key = isValidIdentifier(k) ? k : JSON.stringify(k);
        return `${key}: ${rendered}`;
      }
    );
    if (lang === "go") return `map[string]any{${entries.join(", ")}}`;
    if (lang === "elixir") return `%{${entries.join(", ")}}`;
    if (entries.length === 0) {
      return lang === "swift" ? "[:]" : "{}";
    }
    if (lang === "python") return `{${entries.join(", ")}}`;
    if (lang === "swift") return `[${entries.join(", ")}]`;
    return `{ ${entries.join(", ")} }`;
  }
  if (lang === "python") return "None";
  if (lang === "swift") return "JSONValue.null";
  if (lang === "go") return "nil";
  if (lang === "elixir") return "nil";
  return "undefined";
}

function elixirString(value: string): string {
  return JSON.stringify(value).replace(/#\{/g, "\\#{");
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
  lang: ValueLang = "typescript",
  example?: unknown
): string {
  if (example !== undefined) {
    return renderLiteral(example, lang);
  }
  const emptyDict = emptyDictLiteral(lang);
  switch (typeRef.kind) {
    case "primitive":
      return generatePrimitiveValue(typeRef.type, fieldName, lang);
    case "array":
      // Generate one element so Prism doesn't reject empty required arrays
      if (typeRef.items) {
        const itemVal = generateDummyValue(typeRef.items, undefined, lang);
        return lang === "go" ? `[]any{${itemVal}}` : `[${itemVal}]`;
      }
      return lang === "go" ? "[]any{}" : "[]";
    case "object":
      return generateObjectValue(typeRef.fields, lang);
    case "ref":
      return emptyDict;
    case "enum":
      return typeRef.values.length > 0
        ? renderLiteral(typeRef.values[0], lang)
        : renderLiteral("unknown", lang);
    case "union":
      return typeRef.variants.length > 0
        ? generateDummyValue(typeRef.variants[0]!, fieldName, lang)
        : nullLiteral(lang);
    case "nullable":
    case "optional":
      return generateDummyValue(typeRef.inner, fieldName, lang);
    case "map":
      return emptyDict;
    case "unknown":
      return emptyDict;
    case "void":
      return nullLiteral(lang);
  }
}

function nullLiteral(lang: ValueLang): string {
  if (lang === "python") return "None";
  if (lang === "swift") return "JSONValue.null";
  if (lang === "go") return "nil";
  if (lang === "elixir") return "nil";
  return "undefined";
}

/** Empty-object literal in a JSON-shaped (untyped) position. */
export function emptyDictLiteral(lang: ValueLang): string {
  if (lang === "swift") return "[:]";
  if (lang === "go") return "map[string]any{}";
  if (lang === "elixir") return "%{}";
  return "{}";
}

function generateObjectValue(fields: FieldDef[], lang: ValueLang): string {
  const emptyDict = emptyDictLiteral(lang);
  if (!fields || fields.length === 0) return emptyDict;

  const requiredFields = fields.filter((f) => f.required);
  if (requiredFields.length === 0) return emptyDict;

  if (lang === "python" || lang === "swift" || lang === "go" || lang === "elixir") {
    const entries = requiredFields.map(
      (f) => lang === "elixir"
        ? `${elixirString(f.name)} => ${generateDummyValue(f.type, f.name, lang)}`
        : `"${f.name}": ${generateDummyValue(f.type, f.name, lang)}`
    );
    if (lang === "python") return `{${entries.join(", ")}}`;
    if (lang === "go") return `map[string]any{${entries.join(", ")}}`;
    if (lang === "elixir") return `%{${entries.join(", ")}}`;
    return `[${entries.join(", ")}]`;
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
  lang: ValueLang = "typescript"
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
      return lang === "elixir" ? "~U[2024-01-01 00:00:00Z]" : '"2024-01-01T00:00:00Z"';
    default:
      return '"test-value"';
  }
}

/**
 * Heuristic: pick a sensible dummy string based on the field name.
 */
export function stringValueForField(fieldName?: string): string {
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
  lang: ValueLang,
  opts: ValueOptions = {}
): string {
  const emptyDict = emptyDictLiteral(lang);
  const fields = resolveBodyFields(body, schemas);
  if (fields.length === 0) return emptyDict;

  const selected = opts.includeOptional ? fields : fields.filter((f) => f.required);
  if (selected.length === 0) return emptyDict;

  const entries = selected.map((f) => {
    const value = generateDummyValue(
      f.type,
      f.name,
      lang,
      opts.useExamples ? f.example : undefined
    );
    if (lang === "python" || lang === "swift" || lang === "go") {
      return `"${f.name}": ${value}`;
    }
    if (lang === "elixir") return `${elixirString(f.name)} => ${value}`;
    return `${f.name}: ${value}`;
  });

  if (lang === "python") return `{${entries.join(", ")}}`;
  if (lang === "swift") return `[${entries.join(", ")}]`;
  if (lang === "go") return `map[string]any{${entries.join(", ")}}`;
  if (lang === "elixir") return `%{${entries.join(", ")}}`;
  return `{ ${entries.join(", ")} }`;
}

export function resolveBodyFields(
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
