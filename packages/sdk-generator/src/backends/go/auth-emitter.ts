import type {
  FieldDef,
  OperationDef,
  SchemaDef,
  SdkSpec,
  TypeRef,
} from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import {
  GoNameRegistry,
  goExportedName,
  goString,
  uniqueGoFieldNames,
  uniqueGoParamNames,
} from "./identifiers.js";
import { docLines, emitDocComment, emitPlainDocComment } from "./model-emitter.js";
import { renderGoFile } from "./type-map.js";

/**
 * Generate the Go AuthClient from auth-tagged operations.
 *
 * Token-returning operations map into a shared `AuthTokens` value whose
 * fields come from `x-sdk` role annotations. Non-token operations return the
 * raw `JSONValue` payload.
 */
export function emitGoAuthFile(
  packageName: string,
  spec: SdkSpec,
  registry: GoNameRegistry
): string {
  const authOps = spec.authOperations ?? [];
  if (authOps.length === 0) return "";

  const cb = new CodeBuilder("\t");
  const tokenFields = discoverTokenFields(authOps, spec.schemas);
  const tokensName = registry.claim("auth:AuthTokens", "AuthTokens");
  const methodNames = buildAuthMethodNames(authOps);

  if (tokenFields.length > 0) {
    const memberNames = goAuthTokenFieldNames(tokenFields);
    emitPlainDocComment(
      cb,
      `${tokensName}: tokens returned by authentication operations.`
    );
    cb.block(`type ${tokensName} struct`, () => {
      for (let i = 0; i < tokenFields.length; i++) {
        const type = tokenFields[i]!.role === "token_expiry" ? "int" : "string";
        cb.line(
          `${memberNames[i]} ${type} \`json:"${tokenFields[i]!.role},omitempty"\``
        );
      }
    });
    cb.line();
  }

  emitPlainDocComment(cb, "AuthClient: authentication and token-flow operations.");
  cb.block("type AuthClient struct", () => {
    cb.line("http *HTTPClient");
  });
  cb.line();
  cb.block("func newAuthClient(h *HTTPClient) *AuthClient", () => {
    cb.line("return &AuthClient{http: h}");
  });

  for (let i = 0; i < authOps.length; i++) {
    cb.line();
    emitAuthMethod(cb, authOps[i]!, methodNames[i]!, tokenFields, tokensName, spec.schemas);
  }

  return renderGoFile(packageName, ["context"], cb.toString());
}

interface TokenFieldInfo {
  role: string;
}

export interface GoAuthParam {
  name: string;
  originalName: string;
  required: boolean;
  description?: string;
}

/** Exported struct field names for the discovered token roles. */
function goAuthTokenFieldNames(tokenFields: TokenFieldInfo[]): string[] {
  return uniqueGoFieldNames(tokenFields.map((tf) => tf.role));
}

function discoverTokenFields(
  ops: OperationDef[],
  schemas: SchemaDef[]
): TokenFieldInfo[] {
  const found = new Map<string, TokenFieldInfo>();
  for (const op of ops) {
    for (const field of getResponseFields(op.returnType, schemas)) {
      if (field.sdkRole && !found.has(field.sdkRole)) {
        found.set(field.sdkRole, { role: field.sdkRole });
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

/**
 * Base method name for an auth operation — explicit `x-sdk-name`, else the
 * path's last segment, prefixed with the prior segment when it collides
 * with a parameter name. Mirrors the Python/Swift rule so method names line
 * up across SDKs.
 */
function authMethodBaseName(op: OperationDef): string {
  if (op.sdkName) return op.sdkName;

  const segments = op.path.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? op.name;

  const paramNames = new Set<string>();
  for (const p of op.queryParams) paramNames.add(goExportedName(p.name));
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) paramNames.add(goExportedName(f.name));
    }
  }

  if (paramNames.has(goExportedName(lastSegment)) && segments.length >= 2) {
    return `${segments[segments.length - 2]}_${lastSegment}`;
  }
  return lastSegment;
}

/**
 * Exported method names for every auth operation, uniquified together —
 * they all live in `AuthClient`'s method set.
 */
export function buildAuthMethodNames(ops: OperationDef[]): string[] {
  return uniqueGoFieldNames(ops.map(authMethodBaseName));
}

export function extractGoAuthInputParams(op: OperationDef): GoAuthParam[] {
  const entries: Array<Omit<GoAuthParam, "name">> = [];

  for (const p of op.queryParams) {
    entries.push({
      originalName: p.name,
      required: p.required,
      description: p.description,
    });
  }
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) {
        entries.push({
          originalName: f.name,
          required: f.required,
          description: f.description,
        });
      }
    }
  }
  if (entries.length === 0) {
    for (const p of op.pathParams) {
      entries.push({
        originalName: p.name,
        required: true,
        description: p.description,
      });
    }
  }

  // Required parameters come first: Go has no default arguments, so the
  // optional tail is what callers pass nil for.
  const sorted = [
    ...entries.filter((e) => e.required),
    ...entries.filter((e) => !e.required),
  ];
  const names = uniqueGoParamNames(
    sorted.map((e) => e.originalName),
    ["ctx", "a", "body", "data", "err"]
  );
  return sorted.map((entry, index) => ({ ...entry, name: names[index]! }));
}

function emitAuthMethod(
  cb: CodeBuilder,
  op: OperationDef,
  methodName: string,
  tokenFields: TokenFieldInfo[],
  tokensName: string,
  schemas: SchemaDef[]
): void {
  const params = extractGoAuthInputParams(op);
  const responseFields = getResponseFields(op.returnType, schemas);
  const hasTokenReturn = responseFields.some((f) => Boolean(f.sdkRole));
  const returnType = hasTokenReturn ? `*${tokensName}` : "JSONValue";
  const zero = hasTokenReturn ? "nil" : "JSONValue{}";

  const sig = ["ctx context.Context"];
  for (const p of params) {
    sig.push(`${p.name} ${p.required ? "string" : "*string"}`);
  }

  emitDocComment(
    cb,
    methodName,
    [op.summary, op.description].flatMap(docLines).join("\n")
  );
  cb.block(
    `func (a *AuthClient) ${methodName}(${sig.join(", ")}) (${returnType}, error)`,
    () => {
      if (params.length > 0) {
        cb.line("body := map[string]JSONValue{}");
        for (const p of params) {
          if (p.required) {
            cb.line(`body[${goString(p.originalName)}] = JSONOf(${p.name})`);
          } else {
            cb.block(`if ${p.name} != nil`, () => {
              cb.line(`body[${goString(p.originalName)}] = JSONOf(*${p.name})`);
            });
          }
        }
      }

      const specFields = [
        `Method: ${goString(op.method)}`,
        `Path: ${goString(op.path)}`,
      ];
      if (params.length > 0) specFields.push("Body: body");
      cb.line(
        `data, err := fetch[JSONValue](a.http, ctx, requestSpec{${specFields.join(", ")}})`
      );
      cb.block("if err != nil", () => {
        cb.line(`return ${zero}, err`);
      });

      if (!hasTokenReturn) {
        cb.line("return data, nil");
        return;
      }

      const memberNames = goAuthTokenFieldNames(tokenFields);
      cb.line(`return &${tokensName}{`);
      cb.indent();
      for (let i = 0; i < tokenFields.length; i++) {
        const tf = tokenFields[i]!;
        const field = responseFields.find((f) => f.sdkRole === tf.role);
        const accessor = tf.role === "token_expiry" ? "IntValue()" : "StringValue()";
        const value = field
          ? `data.Get(${goString(field.name)}).${accessor}`
          : tf.role === "token_expiry"
            ? "0"
            : '""';
        cb.line(`${memberNames[i]}: ${value},`);
      }
      cb.dedent();
      cb.line("}, nil");
    }
  );
}
