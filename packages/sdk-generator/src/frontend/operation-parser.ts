import type {
  HttpMethod,
  ParamDef,
  ErrorDef,
  TypeRef,
  FieldDef,
} from "../ast/types.js";
import { jsonSchemaToTypeRef } from "./schema-parser.js";

// ─── OpenAPI subset we consume ───────────────────────────────────

interface OpenApiSpec {
  paths?: Record<string, PathItem>;
}

interface PathItem {
  [method: string]: OperationObject | undefined;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  "x-sdk-pagination"?: { type: "offset" | "cursor" };
  "x-sdk-streaming"?: { type: "sse" };
  "x-auth"?: string[];
  "x-sdk-name"?: string;
  tags?: string[];
}

interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

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
  nullable?: boolean;
}

// ─── Parsed operation (flat, before resource grouping) ───────────

export interface ParsedOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  pathParams: ParamDef[];
  queryParams: ParamDef[];
  bodyFields?: FieldDef[];
  bodySchemaRef?: string;
  returnType: TypeRef;
  errors: ErrorDef[];
  paginationHint?: { type: "offset" | "cursor" };
  streamingHint?: { type: "sse" };
  rawResponse?: boolean;
  auth?: string[];
  sdkName?: string;
  tags?: string[];
}

const HTTP_METHODS: Set<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
]);

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse all operations from an OpenAPI spec into a flat list.
 * Filters out private operations (those without operationId are skipped).
 */
export function parseOperations(spec: OpenApiSpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  if (!spec.paths) return operations;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation) continue;

      const op = operation;
      const operationId =
        op.operationId ?? generateOperationId(method, path);

      operations.push({
        operationId,
        method: method.toUpperCase() as HttpMethod,
        path,
        summary: op.summary,
        description: op.description,
        deprecated: op.deprecated ?? false,
        pathParams: extractParams(op.parameters, "path"),
        queryParams: extractParams(op.parameters, "query"),
        ...extractBody(op.requestBody),
        ...extractSuccessResponse(op.responses),
        errors: extractErrors(op.responses),
        paginationHint: op["x-sdk-pagination"],
        streamingHint: op["x-sdk-streaming"],
        auth: op["x-auth"],
        sdkName: op["x-sdk-name"],
        tags: op.tags,
      });
    }
  }

  return operations;
}

// ─── Internal ────────────────────────────────────────────────────

function extractParams(
  params: ParameterObject[] | undefined,
  location: "path" | "query"
): ParamDef[] {
  if (!params) return [];

  return params
    .filter((p) => p.in === location)
    .map((p) => ({
      name: p.name,
      type: p.schema ? jsonSchemaToTypeRef(p.schema) : primitiveString(),
      required: location === "path" ? true : (p.required ?? false),
      description: p.description,
    }));
}

function extractBody(
  requestBody: RequestBodyObject | undefined
): { bodyFields?: FieldDef[]; bodySchemaRef?: string } {
  if (!requestBody?.content) return {};

  const jsonContent = requestBody.content["application/json"];
  if (!jsonContent?.schema) return {};

  const schema = jsonContent.schema;

  // If it's a $ref, return the ref name
  if (schema.$ref) {
    return { bodySchemaRef: extractRefName(schema.$ref) };
  }

  // If it's an inline object, parse the fields
  if (schema.type === "object" && schema.properties) {
    const requiredSet = new Set(schema.required ?? []);
    const fields: FieldDef[] = Object.entries(schema.properties).map(
      ([name, fieldSchema]) => {
        const isRequired = requiredSet.has(name);
        let type = jsonSchemaToTypeRef(fieldSchema);
        if (!isRequired && type.kind !== "optional") {
          type = { kind: "optional", inner: type };
        }
        return {
          name,
          type,
          required: isRequired,
          default: fieldSchema.default,
          description: fieldSchema.description,
        };
      }
    );
    return { bodyFields: fields };
  }

  return {};
}

function extractSuccessResponse(
  responses: Record<string, ResponseObject> | undefined
): { returnType: TypeRef; rawResponse?: boolean } {
  if (!responses) return { returnType: { kind: "void" } };

  // Look for 200 or 201 response
  const successResponse = responses["200"] ?? responses["201"];
  if (!successResponse?.content) return { returnType: { kind: "void" } };

  const jsonContent = successResponse.content["application/json"];
  if (jsonContent?.schema) {
    return { returnType: jsonSchemaToTypeRef(jsonContent.schema) };
  }

  if (Object.keys(successResponse.content).length > 0) {
    return {
      returnType: primitiveString(),
      rawResponse: true,
    };
  }

  return { returnType: { kind: "void" } };
}

function extractErrors(
  responses: Record<string, ResponseObject> | undefined
): ErrorDef[] {
  if (!responses) return [];

  const errors: ErrorDef[] = [];
  for (const [statusStr, response] of Object.entries(responses)) {
    const status = parseInt(statusStr, 10);
    if (isNaN(status) || status < 400) continue;
    errors.push({
      status,
      description: response.description ?? `HTTP ${status}`,
    });
  }
  return errors;
}

function generateOperationId(method: string, path: string): string {
  const segments = path
    .replace(/\{[^}]+\}/g, "")
    .split("/")
    .filter(Boolean);
  return `${method}_${segments.join("_")}`;
}

function extractRefName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1]!;
}

function primitiveString(): TypeRef {
  return { kind: "primitive", type: "string" };
}
