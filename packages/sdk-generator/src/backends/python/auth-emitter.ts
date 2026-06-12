import type { SdkSpec, SchemaDef, OperationDef, FieldDef, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { pythonParameterName, uniquePythonParameterNames } from "./identifiers.js";

/**
 * Generate the AuthClient from auth-tagged operations in the AST.
 *
 * - Methods derive from the operations' actual params, types, and return schemas
 * - AuthTokens fields discovered from x-sdk annotations — no hardcoded fallbacks
 * - Optional params properly typed
 */
export function emitPythonAuthFile(spec: SdkSpec): string {
  const cb = new CodeBuilder("    ");

  const authOps = spec.authOperations ?? [];
  if (authOps.length === 0) return "";

  const tokenFields = discoverTokenFields(authOps, spec.schemas);

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();
  cb.line("from __future__ import annotations");
  cb.line();
  cb.line("from dataclasses import dataclass");
  cb.line();
  cb.line("from .runtime.http_client import HttpClient, SyncHttpClient");
  cb.line();
  cb.line();

  // AuthTokens — fields from x-sdk annotations
  if (tokenFields.length > 0) {
    cb.line("@dataclass");
    cb.pyBlock("class AuthTokens", () => {
      // All fields optional — API responses may omit fields at runtime
      for (const tf of tokenFields) {
        const pyType = tf.role === "token_expiry" ? "int | None" : "str | None";
        cb.line(`${pythonParameterName(tf.role)}: ${pyType} = None`);
      }
    });
    cb.line();
    cb.line();
  }

  cb.pyBlock("class AsyncAuthClient", () => {
    cb.pyBlock("def __init__(self, http: HttpClient)", () => {
      cb.line("self._http = http");
    });

    for (const op of authOps) {
      cb.line();
      emitAuthMethod(cb, op, tokenFields, spec.schemas);
    }
  });
  cb.line();
  cb.line();

  cb.pyBlock("class AuthClient", () => {
    cb.pyBlock("def __init__(self, http: SyncHttpClient)", () => {
      cb.line("self._http = http");
    });

    for (const op of authOps) {
      cb.line();
      emitSyncAuthMethod(cb, op, tokenFields, spec.schemas);
    }
  });

  return cb.toString();
}

interface TokenFieldInfo {
  role: string;
  required: boolean;
}

export interface AuthParam {
  name: string;
  originalName: string;
  required: boolean;
}

function discoverTokenFields(ops: OperationDef[], schemas: SchemaDef[]): TokenFieldInfo[] {
  const found = new Map<string, TokenFieldInfo>();
  for (const op of ops) {
    for (const field of getResponseFields(op.returnType, schemas)) {
      if (field.sdkRole && !found.has(field.sdkRole)) {
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
export function pyAuthMethodName(op: OperationDef): string {
  if (op.sdkName) return pythonParameterName(op.sdkName);

  const segments = op.path.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? op.name;
  const name = pythonParameterName(lastSegment);

  // Check for collision with any input parameter name
  const paramNames = new Set<string>();
  for (const p of op.queryParams) paramNames.add(pythonParameterName(p.name));
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) paramNames.add(pythonParameterName(f.name));
    }
  }

  if (paramNames.has(name) && segments.length >= 2) {
    return pythonParameterName(`${segments[segments.length - 2]}_${lastSegment}`);
  }
  return name;
}

function emitAuthMethod(
  cb: CodeBuilder,
  op: OperationDef,
  tokenFields: TokenFieldInfo[],
  schemas: SchemaDef[]
): void {
  const methodName = pyAuthMethodName(op);
  const params = extractPythonAuthInputParams(op);
  const responseFields = getResponseFields(op.returnType, schemas);
  const hasTokenReturn = responseFields.some((field) => Boolean(field.sdkRole));
  const returnType = hasTokenReturn ? "AuthTokens" : "dict";

  // Required params first, then optional
  const requiredParams = params.filter((p) => p.required);
  const optionalParams = params.filter((p) => !p.required);
  const sortedParams = [...requiredParams, ...optionalParams];

  const sig = sortedParams
    .map((p) => {
      if (p.required) return `${p.name}: str`;
      return `${p.name}: str | None = None`;
    })
    .join(", ");

  if (op.description) {
    cb.line(`# ${op.description.replace(/[^\x20-\x7E]/g, " ")}`);
  }

  const methodParams = sig ? `self, ${sig}` : "self";
  cb.pyBlock(`async def ${methodName}(${methodParams}) -> ${returnType}`, () => {
    // Build body, omitting None optionals
    if (sortedParams.length > 0) {
      cb.line("body: dict[str, object] = {}");
      for (const p of sortedParams) {
        if (p.required) {
          cb.line(`body["${p.originalName}"] = ${p.name}`);
        } else {
          cb.pyBlock(`if ${p.name} is not None`, () => {
            cb.line(`body["${p.originalName}"] = ${p.name}`);
          });
        }
      }
      cb.line();
    }

    cb.line("data = await self._http.request(");
    cb.indent();
    cb.line(`"${op.path}",`);
    cb.line(`method="${op.method}",`);
    if (sortedParams.length > 0) {
      cb.line("body=body,");
    }
    cb.dedent();
    cb.line(")");

    if (hasTokenReturn) {
      // Inline extraction using this operation's specific return type field names
      cb.line("return AuthTokens(");
      cb.indent();
      for (const tf of tokenFields) {
        const field = responseFields.find((f) => f.sdkRole === tf.role);
        if (field) {
          cb.line(`${pythonParameterName(tf.role)}=data.get("${field.name}"),`);
        } else {
          cb.line(`${pythonParameterName(tf.role)}=None,`);
        }
      }
      cb.dedent();
      cb.line(")");
    } else {
      cb.line("return data");
    }
  });
}

function emitSyncAuthMethod(
  cb: CodeBuilder,
  op: OperationDef,
  tokenFields: TokenFieldInfo[],
  schemas: SchemaDef[]
): void {
  const methodName = pyAuthMethodName(op);
  const params = extractPythonAuthInputParams(op);
  const responseFields = getResponseFields(op.returnType, schemas);
  const hasTokenReturn = responseFields.some((field) => Boolean(field.sdkRole));
  const returnType = hasTokenReturn ? "AuthTokens" : "dict";
  const requiredParams = params.filter((p) => p.required);
  const optionalParams = params.filter((p) => !p.required);
  const sortedParams = [...requiredParams, ...optionalParams];
  const sig = sortedParams
    .map((p) => {
      if (p.required) return `${p.name}: str`;
      return `${p.name}: str | None = None`;
    })
    .join(", ");
  const methodParams = sig ? `self, ${sig}` : "self";

  cb.pyBlock(`def ${methodName}(${methodParams}) -> ${returnType}`, () => {
    if (sortedParams.length > 0) {
      cb.line("body: dict[str, object] = {}");
      for (const p of sortedParams) {
        if (p.required) {
          cb.line(`body["${p.originalName}"] = ${p.name}`);
        } else {
          cb.pyBlock(`if ${p.name} is not None`, () => {
            cb.line(`body["${p.originalName}"] = ${p.name}`);
          });
        }
      }
      cb.line();
    }

    cb.line("data = self._http.request(");
    cb.indent();
    cb.line(`"${op.path}",`);
    cb.line(`method="${op.method}",`);
    if (sortedParams.length > 0) {
      cb.line("body=body,");
    }
    cb.dedent();
    cb.line(")");

    if (hasTokenReturn) {
      cb.line("return AuthTokens(");
      cb.indent();
      for (const tf of tokenFields) {
        const field = responseFields.find((f) => f.sdkRole === tf.role);
        if (field) {
          cb.line(`${pythonParameterName(tf.role)}=data.get("${field.name}"),`);
        } else {
          cb.line(`${pythonParameterName(tf.role)}=None,`);
        }
      }
      cb.dedent();
      cb.line(")");
    } else {
      cb.line("return data");
    }
  });
}

export function extractPythonAuthInputParams(op: OperationDef): AuthParam[] {
  const entries: Array<Omit<AuthParam, "name">> = [];

  for (const p of op.queryParams) {
    entries.push({
      originalName: p.name,
      required: p.required,
    });
  }

  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) {
        entries.push({
          originalName: f.name,
          required: f.required,
        });
      }
    }
  }

  if (entries.length === 0) {
    for (const p of op.pathParams) {
      entries.push({
        originalName: p.name,
        required: true,
      });
    }
  }

  const names = uniquePythonParameterNames(entries.map((entry) => entry.originalName));
  return entries.map((entry, index) => ({
    ...entry,
    name: names[index]!,
  }));
}
