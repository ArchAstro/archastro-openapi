import type { SdkSpec, SchemaDef, OperationDef, FieldDef, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase } from "../../utils/naming.js";

/**
 * Generate the AuthClient from auth-tagged operations in the AST.
 *
 * - Methods are derived from the operations' actual params, types, and return schemas
 * - AuthTokens fields are discovered from x-sdk annotations — no hardcoded fallbacks
 * - Optional params are properly typed as optional
 */
export function emitAuthFile(spec: SdkSpec): string {
  const cb = new CodeBuilder();

  const authOps = spec.authOperations ?? [];
  if (authOps.length === 0) return "";

  // Discover token field mappings from x-sdk annotations on response schemas
  const tokenFields = discoverTokenFields(authOps, spec.schemas);

  cb.line(generatedHeader());
  cb.line(`import { HttpClient } from "./runtime/http-client.js";`);
  cb.line();

  // AuthTokens — fields derived from x-sdk annotations
  if (tokenFields.length > 0) {
    cb.block("export interface AuthTokens", () => {
      for (const tf of tokenFields) {
        const isExpiry = tf.role === "token_expiry";
        const tsType = isExpiry ? "number" : "string";
        // Token fields from API responses may be absent — always allow undefined
        cb.line(`${camelCase(tf.role)}: ${tsType} | undefined;`);
      }
    });
    cb.line();
  }

  // AuthClient
  cb.block("export class AuthClient", () => {
    cb.line("constructor(private http: HttpClient) {}");

    for (const op of authOps) {
      cb.line();
      emitAuthMethod(cb, op, tokenFields, spec.schemas);
    }
  });

  return cb.toString();
}

interface TokenFieldInfo {
  role: string;       // e.g., "access_token", "refresh_token", "token_expiry"
  required: boolean;
}

interface AuthParam {
  name: string;       // camelCase param name for the method signature
  originalName: string; // original snake_case name for the JSON body
  type: string;       // TypeScript type
  required: boolean;
}

function discoverTokenFields(ops: OperationDef[], schemas: SchemaDef[]): TokenFieldInfo[] {
  const found = new Map<string, TokenFieldInfo>();

  for (const op of ops) {
    for (const field of getResponseFields(op.returnType, schemas)) {
      if (!field.sdkRole) continue;
      if (!found.has(field.sdkRole)) {
        found.set(field.sdkRole, {
          role: field.sdkRole,
          required: field.required,
        });
      }
    }
  }

  return [...found.values()];
}

function getResponseFields(typeRef: TypeRef, schemas: SchemaDef[]): FieldDef[] {
  if (typeRef.kind === "object") return typeRef.fields;
  if (typeRef.kind === "ref") {
    const schema = schemas.find((s) => s.name === typeRef.schema);
    if (schema) return schema.fields;
  }
  return [];
}

/** Derive auth method name.
 *  Prefers explicit sdkName, falls back to path's last segment.
 *  If the name collides with a parameter name, prefix with the prior segment. */
export function authMethodName(op: OperationDef): string {
  if (op.sdkName) return camelCase(op.sdkName);

  const segments = op.path.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? op.name;
  const name = camelCase(lastSegment);

  // Check for collision with any input parameter name
  const paramNames = new Set<string>();
  for (const p of op.queryParams) paramNames.add(camelCase(p.name));
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) paramNames.add(camelCase(f.name));
    }
  }

  if (paramNames.has(name) && segments.length >= 2) {
    return camelCase(`${segments[segments.length - 2]}_${lastSegment}`);
  }
  return name;
}

function emitAuthMethod(
  cb: CodeBuilder,
  op: OperationDef,
  tokenFields: TokenFieldInfo[],
  schemas: SchemaDef[]
): void {
  const methodName = authMethodName(op);
  const params = extractInputParams(op);
  const hasTokenReturn = tokenFields.length > 0;
  const returnType = hasTokenReturn ? "AuthTokens" : "Record<string, unknown>";

  // Build signature — required params first, then optional
  const requiredParams = params.filter((p) => p.required);
  const optionalParams = params.filter((p) => !p.required);
  const sortedParams = [...requiredParams, ...optionalParams];

  const sig = sortedParams
    .map((p) => {
      const opt = p.required ? "" : "?";
      return `${p.name}${opt}: ${p.type}`;
    })
    .join(", ");

  if (op.description) {
    cb.line(`/** ${op.description} */`);
  }

  cb.block(`async ${methodName}(${sig}): Promise<${returnType}>`, () => {
    // Build body object from params
    if (sortedParams.length > 0) {
      cb.line("const body: Record<string, unknown> = {};");
      for (const p of sortedParams) {
        if (p.required) {
          cb.line(`body["${p.originalName}"] = ${p.name};`);
        } else {
          cb.line(
            `if (${p.name} !== undefined) body["${p.originalName}"] = ${p.name};`
          );
        }
      }
      cb.line();
    }

    cb.line("const data = await this.http.request<Record<string, unknown>>(");
    cb.indent();
    cb.line(`"${op.path}",`);
    cb.line(`{ method: "${op.method}"${sortedParams.length > 0 ? ", body" : ""} },`);
    cb.dedent();
    cb.line(");");

    if (hasTokenReturn) {
      // Inline extraction using this operation's specific return type field names
      const responseFields = getResponseFields(op.returnType, schemas);
      cb.block("return", () => {
        for (const tf of tokenFields) {
          const field = responseFields.find((f) => f.sdkRole === tf.role);
          const tsType = tf.role === "token_expiry" ? "number | undefined" : "string | undefined";
          if (field) {
            cb.line(`${camelCase(tf.role)}: data.${field.name} as ${tsType},`);
          } else {
            cb.line(`${camelCase(tf.role)}: undefined,`);
          }
        }
      });
    } else {
      cb.line("return data;");
    }
  });
}

function extractInputParams(op: OperationDef): AuthParam[] {
  const params: AuthParam[] = [];

  // Query params
  for (const p of op.queryParams) {
    params.push({
      name: camelCase(p.name),
      originalName: p.name,
      type: typeRefToTSSimple(p.type),
      required: p.required,
    });
  }

  // Body fields (skip sdk-annotated output fields)
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) {
        params.push({
          name: camelCase(f.name),
          originalName: f.name,
          type: typeRefToTSSimple(f.type),
          required: f.required,
        });
      }
    }
  }

  // Path params as fallback
  if (params.length === 0) {
    for (const p of op.pathParams) {
      params.push({
        name: camelCase(p.name),
        originalName: p.name,
        type: "string",
        required: true,
      });
    }
  }

  return params;
}

function typeRefToTSSimple(ref: TypeRef): string {
  switch (ref.kind) {
    case "primitive":
      switch (ref.type) {
        case "string":
        case "datetime":
          return "string";
        case "integer":
        case "float":
          return "number";
        case "boolean":
          return "boolean";
      }
      break;
    case "optional":
      return typeRefToTSSimple(ref.inner);
    default:
      return "string";
  }
  return "string";
}
