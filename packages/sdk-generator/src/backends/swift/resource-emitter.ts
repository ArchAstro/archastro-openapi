import type {
  FieldDef,
  OperationDef,
  ParamDef,
  ResourceDef,
  TypeRef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { pascalCase } from "../../utils/naming.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "./identifiers.js";
import { docLines, emitDocComment, emitSwiftStruct } from "./model-emitter.js";
import {
  swiftInlineInputName,
  swiftInlineResponseName,
  swiftResponseShape,
} from "./response-type.js";
import {
  responseAllowsNull,
  unwrapNullability,
} from "../python/response-type.js";
import {
  swiftQueryStringExpr,
  typeRefToSwift,
  unwrapOptional,
} from "./type-map.js";

/**
 * Generate a Swift resource file from a ResourceDef (and its children).
 *
 * ```swift
 * public final class AgentResource: Sendable {
 *     private let http: HttpClient
 *     public let schedules: ScheduleResource
 *
 *     public func list(page: Int? = nil) async throws -> AgentListResponse {
 *         var query: [(String, String)] = []
 *         if let page { query.append(("page", String(page))) }
 *         return try await http.request("/api/v1/agents", query: query)
 *     }
 * }
 * ```
 */
export function emitSwiftResourceFile(
  resource: ResourceDef,
  registry: SwiftNameRegistry
): string {
  const cb = new CodeBuilder("    ");
  const allResources = flattenResourcesBottomUp(resource);

  // Claim inline input/response struct names before emitting anything so
  // method signatures can reference them.
  claimResourceTypeNames(allResources, registry);

  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  // Inline request-body structs (hoisted children first).
  for (const resourceDef of allResources) {
    for (const op of resourceDef.operations) {
      if (!hasInlineBody(op)) continue;
      const rootName = registry.lookup(inputKey(op));
      const hoist = hoistInlineObjects(op.body!.fields!, rootName, "typeddict");
      for (const child of hoist.hoisted) {
        emitSwiftStruct(cb, child.name, child.fields, registry, {
          description: child.description,
        });
        cb.line();
      }
      emitSwiftStruct(cb, rootName, hoist.fields, registry, {
        description: op.summary ?? op.description,
      });
      cb.line();
    }
  }

  // Inline response structs.
  for (const resourceDef of allResources) {
    for (const op of resourceDef.operations) {
      if (!hasInlineResponse(op)) continue;
      const rootName = registry.lookup(responseKey(op));
      const fields = (op.returnType as Extract<TypeRef, { kind: "object" }>).fields;
      const hoist = hoistInlineObjects(fields, rootName, "basemodel");
      for (const child of hoist.hoisted) {
        emitSwiftStruct(cb, child.name, child.fields, registry, {
          description: child.description,
        });
        cb.line();
      }
      emitSwiftStruct(cb, rootName, hoist.fields, registry, {
        description: op.returnDescription ?? op.summary,
      });
      cb.line();
    }
  }

  for (let i = 0; i < allResources.length; i++) {
    emitResourceClass(cb, allResources[i]!, registry);
    if (i < allResources.length - 1) cb.line();
  }

  return cb.toString();
}

/**
 * Claim registry names for every inline input/response struct in a
 * resource tree, including nested hoisted structs. Called by the backend
 * before file emission so cross-file references resolve consistently.
 */
export function claimResourceTypeNames(
  resources: ResourceDef[],
  registry: SwiftNameRegistry
): void {
  for (const resource of resources) {
    for (const op of resource.operations) {
      if (hasInlineBody(op)) {
        registry.claim(
          inputKey(op),
          swiftInlineInputName(resource.className, op.name)
        );
      }
      if (hasInlineResponse(op)) {
        registry.claim(
          responseKey(op),
          swiftInlineResponseName(resource.className, op.name)
        );
      }
    }
    claimResourceTypeNames(resource.children, registry);
  }
}

export function inputKey(op: OperationDef): string {
  return `input:${op.operationId}`;
}

export function responseKey(op: OperationDef): string {
  return `response:${op.operationId}`;
}

export function hasInlineBody(op: OperationDef): boolean {
  return Boolean(op.body?.fields && op.body.fields.length > 0);
}

export function hasInlineResponse(op: OperationDef): boolean {
  return (
    !op.rawResponse &&
    op.returnType.kind === "object" &&
    op.returnType.fields.length > 0
  );
}

export function flattenResourcesBottomUp(resource: ResourceDef): ResourceDef[] {
  const result: ResourceDef[] = [];
  for (const child of resource.children) {
    result.push(...flattenResourcesBottomUp(child));
  }
  result.push(resource);
  return result;
}

// ─── Resource class ──────────────────────────────────────────────

function emitResourceClass(
  cb: CodeBuilder,
  resource: ResourceDef,
  registry: SwiftNameRegistry
): void {
  emitDocComment(cb, resource.description);
  cb.block(`public final class ${resource.className}: Sendable`, () => {
    cb.line("private let http: HttpClient");
    const childNames = uniqueSwiftMemberNames(resource.children.map((c) => c.name));
    for (let i = 0; i < resource.children.length; i++) {
      cb.line(`public let ${childNames[i]}: ${resource.children[i]!.className}`);
    }
    cb.line();
    cb.block("public init(http: HttpClient)", () => {
      cb.line("self.http = http");
      for (let i = 0; i < resource.children.length; i++) {
        cb.line(
          `self.${childNames[i]} = ${resource.children[i]!.className}(http: http)`
        );
      }
    });

    for (const op of resource.operations) {
      cb.line();
      emitOperation(cb, op, resource, registry);
    }
  });
}

// ─── Operations ──────────────────────────────────────────────────

export interface SwiftOperationNames {
  scope: string[];
  path: string[];
  body?: string;
  query: string[];
}

/**
 * Unique Swift parameter names for an operation, in declaration order
 * (scope, path, body="input", query). Mirrors the Python name builder so
 * the contract-tests emitter derives identical labels.
 */
export function buildOperationSwiftNames(
  op: OperationDef,
  resource: ResourceDef
): SwiftOperationNames {
  const entries: Array<{ kind: "scope" | "path" | "body" | "query"; name: string }> = [];
  for (const param of resource.scopeParams) entries.push({ kind: "scope", name: param.name });
  for (const param of op.pathParams) entries.push({ kind: "path", name: param.name });
  if (op.body) entries.push({ kind: "body", name: "input" });
  for (const param of op.queryParams) entries.push({ kind: "query", name: param.name });

  // "query" and "http" are locals in the generated method body.
  const unique = uniqueSwiftMemberNames(
    entries.map((e) => e.name),
    ["query", "http"]
  );
  const result: SwiftOperationNames = { scope: [], path: [], query: [] };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const name = unique[i]!;
    if (entry.kind === "scope") result.scope.push(name);
    else if (entry.kind === "path") result.path.push(name);
    else if (entry.kind === "body") result.body = name;
    else result.query.push(name);
  }
  return result;
}

/** Swift method name for an operation. */
export function swiftMethodName(op: OperationDef): string {
  return uniqueSwiftMemberNames([op.name])[0]!;
}

/** Swift accessor for a resource segment in a chain (`agent_computers` → `agentComputers`). */
export function swiftAccessorName(resourceName: string): string {
  return uniqueSwiftMemberNames([resourceName])[0]!;
}

/** Return type of the generated Swift method, or undefined for Void. */
export function swiftReturnType(
  op: OperationDef,
  registry: SwiftNameRegistry
): string | undefined {
  const resolveRef = (s: string): string =>
    registry.has(`schema:${s}`) ? registry.lookup(`schema:${s}`) : s;
  switch (swiftResponseShape(op)) {
    case "void":
      return undefined;
    case "raw":
      return "RawResponse";
    case "model": {
      const inner = unwrapNullability(op.returnType);
      const name =
        inner.kind === "ref"
          ? resolveRef(inner.schema)
          : registry.lookup(responseKey(op));
      return responseAllowsNull(op.returnType) ? `${name}?` : name;
    }
    case "model_list": {
      const ret = unwrapNullability(op.returnType);
      if (ret.kind === "array" && ret.items.kind === "ref") {
        const list = `[${resolveRef(ret.items.schema)}]`;
        return responseAllowsNull(op.returnType) ? `${list}?` : list;
      }
      return "JSONValue";
    }
    case "untyped":
      return "JSONValue";
  }
}

/** Swift type annotation for the body parameter. */
export function swiftBodyType(
  op: OperationDef,
  registry: SwiftNameRegistry
): string {
  if (hasInlineBody(op)) return registry.lookup(inputKey(op));
  if (op.body?.schema && op.body.schema !== "inline") {
    return registry.has(`schema:${op.body.schema}`)
      ? registry.lookup(`schema:${op.body.schema}`)
      : op.body.schema;
  }
  return "[String: JSONValue]";
}

function emitOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  registry: SwiftNameRegistry
): void {
  const names = buildOperationSwiftNames(op, resource);
  const params = buildParamList(op, resource, registry, names);
  const methodName = swiftMethodName(op);

  emitOperationDocs(cb, op, resource, names);

  if (op.streaming) {
    cb.block(
      `public func ${methodName}(${params}) -> AsyncThrowingStream<SSEEvent, any Error>`,
      () => {
        emitQueryBuilder(cb, op, names);
        const args = requestArgs(op, resource, names);
        cb.line(`return http.streamSSE(${args.join(", ")})`);
      }
    );
    return;
  }

  const returnType = swiftReturnType(op, registry);
  const signature = returnType
    ? `public func ${methodName}(${params}) async throws -> ${returnType}`
    : `public func ${methodName}(${params}) async throws`;

  cb.block(signature, () => {
    emitQueryBuilder(cb, op, names);
    const args = requestArgs(op, resource, names);
    const shape = swiftResponseShape(op);
    if (shape === "void") {
      cb.line(`try await http.requestVoid(${args.join(", ")})`);
    } else if (shape === "raw") {
      cb.line(`return try await http.requestRaw(${args.join(", ")})`);
    } else {
      cb.line(`return try await http.request(${args.join(", ")})`);
    }
  });
}

function requestArgs(
  op: OperationDef,
  resource: ResourceDef,
  names: SwiftOperationNames
): string[] {
  const args: string[] = [pathExpression(op, resource, names)];
  if (op.method !== "GET") args.push(`method: ${swiftString(op.method)}`);
  if (op.body) args.push(`body: ${names.body}`);
  if (op.queryParams.length > 0) args.push("query: query");
  return args;
}

function pathExpression(
  op: OperationDef,
  resource: ResourceDef,
  names: SwiftOperationNames
): string {
  const paramNames = new Map<string, string>();
  for (let i = 0; i < resource.scopeParams.length; i++) {
    paramNames.set(resource.scopeParams[i]!.name, names.scope[i]!);
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    paramNames.set(op.pathParams[i]!.name, names.path[i]!);
  }
  const interpolated = op.path.replace(/\{(\w+)\}/g, (_m, raw: string) => {
    const name = paramNames.get(raw) ?? uniqueSwiftMemberNames([raw])[0]!;
    return `\\(${name})`;
  });
  return `"${interpolated}"`;
}

function emitQueryBuilder(
  cb: CodeBuilder,
  op: OperationDef,
  names: SwiftOperationNames
): void {
  if (op.queryParams.length === 0) return;
  cb.line("var query: [(String, String)] = []");
  for (let i = 0; i < op.queryParams.length; i++) {
    const param = op.queryParams[i]!;
    const name = names.query[i]!;
    const wireKey = swiftString(param.wireName ?? param.name);
    emitQueryAppend(cb, param, name, wireKey);
  }
}

function emitQueryAppend(
  cb: CodeBuilder,
  param: ParamDef,
  name: string,
  wireKey: string
): void {
  const bare = name.replace(/`/g, "");
  const optional =
    !param.required ||
    param.type.kind === "optional";
  const inner = unwrapOptional(param.type);

  const appendLines = (expr: string): void => {
    if (inner.kind === "array") {
      cb.block(`for item in ${expr}`, () => {
        cb.line(
          `query.append((${wireKey}, ${swiftQueryStringExpr(inner.items, "item")}))`
        );
      });
    } else {
      cb.line(`query.append((${wireKey}, ${swiftQueryStringExpr(inner, expr)}))`);
    }
  };

  if (optional) {
    cb.block(`if let ${bare} = ${name}`, () => appendLines(bare));
  } else {
    appendLines(name);
  }
}

function buildParamList(
  op: OperationDef,
  _resource: ResourceDef,
  registry: SwiftNameRegistry,
  names: SwiftOperationNames
): string {
  const parts: string[] = [];

  for (const name of names.scope) parts.push(`${name}: String`);
  for (const name of names.path) parts.push(`${name}: String`);

  if (op.body) {
    parts.push(`${names.body}: ${swiftBodyType(op, registry)}`);
  }

  const resolveRef = (s: string): string =>
    registry.has(`schema:${s}`) ? registry.lookup(`schema:${s}`) : s;
  const withIndex = op.queryParams.map((param, index) => ({ param, index }));
  const required = withIndex.filter(
    ({ param }) =>
      param.required &&
      param.type.kind !== "optional"
  );
  const optional = withIndex.filter(
    ({ param }) =>
      !param.required ||
      param.type.kind === "optional"
  );
  for (const { param, index } of required) {
    parts.push(`${names.query[index]}: ${typeRefToSwift(param.type, resolveRef)}`);
  }
  for (const { param, index } of optional) {
    const base = typeRefToSwift(unwrapOptional(param.type), resolveRef);
    parts.push(`${names.query[index]}: ${base}? = nil`);
  }

  return parts.join(", ");
}

// ─── Docs ────────────────────────────────────────────────────────

function emitOperationDocs(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  names: SwiftOperationNames
): void {
  const summary = docLines(op.summary);
  const description = docLines(op.description);
  const params: Array<[string, string]> = [];

  for (let i = 0; i < resource.scopeParams.length; i++) {
    const param = resource.scopeParams[i]!;
    if (param.description) {
      params.push([names.scope[i]!.replace(/`/g, ""), docLines(param.description).join(" ")]);
    }
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    const param = op.pathParams[i]!;
    if (param.description) {
      params.push([names.path[i]!.replace(/`/g, ""), docLines(param.description).join(" ")]);
    }
  }
  if (op.body) {
    params.push([names.body!.replace(/`/g, ""), "Request body."]);
  }
  for (let i = 0; i < op.queryParams.length; i++) {
    const param = op.queryParams[i]!;
    if (param.description) {
      params.push([names.query[i]!.replace(/`/g, ""), docLines(param.description).join(" ")]);
    }
  }

  const lines: string[] = [...summary];
  if (description.length > 0 && summary.length > 0) lines.push("");
  lines.push(...description.filter((l) => !summary.includes(l)));

  if (params.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("- Parameters:");
    for (const [name, doc] of params) {
      lines.push(`  - ${name}: ${doc}`);
    }
  }
  if (op.returnDescription) {
    if (lines.length > 0 && params.length === 0) lines.push("");
    lines.push(`- Returns: ${docLines(op.returnDescription).join(" ")}`);
  }

  for (const line of lines) {
    cb.line(line === "" ? "///" : `/// ${line}`);
  }
}

// Re-export for the contract-tests emitter.
export { pascalCase };
export type { FieldDef };
