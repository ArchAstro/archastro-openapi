import type {
  FieldDef,
  OperationDef,
  SchemaDef,
  SdkSpec,
  TypeRef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "./identifiers.js";
import { docLines, emitDocComment } from "./model-emitter.js";

/**
 * Generate the Swift AuthClient from auth-tagged operations.
 *
 * Token-returning operations map into a shared `AuthTokens` value whose
 * fields come from x-sdk role annotations. Non-token operations return the
 * raw `JSONValue` payload.
 */
export function emitSwiftAuthFile(
  spec: SdkSpec,
  registry: SwiftNameRegistry
): string {
  const authOps = spec.authOperations ?? [];
  if (authOps.length === 0) return "";

  const cb = new CodeBuilder("    ");
  const tokenFields = discoverTokenFields(authOps, spec.schemas);
  const tokensName = registry.claim("auth:AuthTokens", "AuthTokens");

  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  if (tokenFields.length > 0) {
    const memberNames = uniqueSwiftMemberNames(tokenFields.map((tf) => tf.role));
    cb.line("/// Tokens returned by authentication operations.");
    cb.block(`public struct ${tokensName}: Sendable`, () => {
      for (let i = 0; i < tokenFields.length; i++) {
        const type = tokenFields[i]!.role === "token_expiry" ? "Int?" : "String?";
        cb.line(`public var ${memberNames[i]}: ${type}`);
      }
      cb.line();
      const params = tokenFields.map((tf, i) => {
        const type = tf.role === "token_expiry" ? "Int?" : "String?";
        return `${memberNames[i]}: ${type} = nil`;
      });
      cb.line(`public init(${params.join(", ")}) {`);
      cb.indent();
      for (const member of memberNames) cb.line(`self.${member} = ${member}`);
      cb.dedent();
      cb.line("}");
    });
    cb.line();
  }

  cb.block("public final class AuthClient: Sendable", () => {
    cb.line("private let http: HttpClient");
    cb.line();
    cb.block("public init(http: HttpClient)", () => {
      cb.line("self.http = http");
    });

    for (const op of authOps) {
      cb.line();
      emitAuthMethod(cb, op, tokenFields, tokensName, spec.schemas);
    }
  });

  return cb.toString();
}

interface TokenFieldInfo {
  role: string;
}

export interface SwiftAuthParam {
  name: string;
  originalName: string;
  required: boolean;
  description?: string;
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
 * Auth method name — explicit sdkName, else the path's last segment,
 * prefixed with the prior segment on parameter-name collision. Mirrors
 * the Python rule so cross-language method names line up.
 */
export function swiftAuthMethodName(op: OperationDef): string {
  if (op.sdkName) return uniqueSwiftMemberNames([op.sdkName])[0]!;

  const segments = op.path.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? op.name;
  const name = uniqueSwiftMemberNames([lastSegment])[0]!;

  const paramNames = new Set<string>();
  for (const p of op.queryParams) paramNames.add(uniqueSwiftMemberNames([p.name])[0]!);
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole) paramNames.add(uniqueSwiftMemberNames([f.name])[0]!);
    }
  }

  if (paramNames.has(name) && segments.length >= 2) {
    return uniqueSwiftMemberNames([
      `${segments[segments.length - 2]}_${lastSegment}`,
    ])[0]!;
  }
  return name;
}

export function extractSwiftAuthInputParams(op: OperationDef): SwiftAuthParam[] {
  const entries: Array<Omit<SwiftAuthParam, "name">> = [];

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

  const names = uniqueSwiftMemberNames(entries.map((e) => e.originalName));
  return entries.map((entry, index) => ({ ...entry, name: names[index]! }));
}

function emitAuthMethod(
  cb: CodeBuilder,
  op: OperationDef,
  tokenFields: TokenFieldInfo[],
  tokensName: string,
  schemas: SchemaDef[]
): void {
  const methodName = swiftAuthMethodName(op);
  const params = extractSwiftAuthInputParams(op);
  const responseFields = getResponseFields(op.returnType, schemas);
  const hasTokenReturn = responseFields.some((f) => Boolean(f.sdkRole));
  const returnType = hasTokenReturn ? tokensName : "JSONValue";

  const requiredParams = params.filter((p) => p.required);
  const optionalParams = params.filter((p) => !p.required);
  const sorted = [...requiredParams, ...optionalParams];

  const sig = sorted
    .map((p) => (p.required ? `${p.name}: String` : `${p.name}: String? = nil`))
    .join(", ");

  emitDocComment(cb, [op.summary, op.description].flatMap(docLines).join("\n"));
  cb.block(
    `public func ${methodName}(${sig}) async throws -> ${returnType}`,
    () => {
      if (sorted.length > 0) {
        cb.line("var body: [String: JSONValue] = [:]");
        for (const p of sorted) {
          if (p.required) {
            cb.line(`body[${swiftString(p.originalName)}] = .string(${p.name})`);
          } else {
            cb.block(`if let ${p.name.replace(/`/g, "")} = ${p.name}`, () => {
              cb.line(
                `body[${swiftString(p.originalName)}] = .string(${p.name.replace(/`/g, "")})`
              );
            });
          }
        }
      }

      const args = [swiftString(op.path), `method: ${swiftString(op.method)}`];
      if (sorted.length > 0) args.push("body: body");
      cb.line(`let data: JSONValue = try await http.request(${args.join(", ")})`);

      if (hasTokenReturn) {
        const memberNames = uniqueSwiftMemberNames(tokenFields.map((tf) => tf.role));
        cb.line(`return ${tokensName}(`);
        cb.indent();
        for (let i = 0; i < tokenFields.length; i++) {
          const tf = tokenFields[i]!;
          const field = responseFields.find((f) => f.sdkRole === tf.role);
          const accessor = tf.role === "token_expiry" ? "intValue" : "stringValue";
          const value = field
            ? `data[${swiftString(field.name)}]?.${accessor}`
            : "nil";
          const comma = i < tokenFields.length - 1 ? "," : "";
          cb.line(`${memberNames[i]}: ${value}${comma}`);
        }
        cb.dedent();
        cb.line(")");
      } else {
        cb.line("return data");
      }
    }
  );
}
