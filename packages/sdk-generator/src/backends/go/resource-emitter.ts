import type {
  OperationDef,
  ParamDef,
  ResourceDef,
  TypeRef,
} from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import {
  GoNameRegistry,
  goExportedName,
  goString,
  uniqueGoFieldNames,
  uniqueGoParamNames,
} from "./identifiers.js";
import {
  docLines,
  emitDocComment,
  emitGoStruct,
  emitPlainDocComment,
  makeRefResolver,
} from "./model-emitter.js";
import {
  goInlineInputName,
  goInlineResponseName,
  goParamsStructName,
  goResponseShape,
} from "./response-type.js";
import {
  goFieldType,
  goQueryStringExpr,
  renderGoFile,
  unwrapOptional,
} from "./type-map.js";

/** Locals the generated method bodies own; parameters never take these. */
const METHOD_LOCALS = ["ctx", "r", "q", "err", "params", "input", "spec"];

/**
 * Generate a Go resource file from a ResourceDef (and its children).
 *
 * ```go
 * type AgentResource struct {
 *     http *HTTPClient
 *     Tools *AgentToolResource
 * }
 *
 * func (r *AgentResource) List(ctx context.Context, params AgentListParams) (*AgentListResponse, error) {
 *     q := url.Values{}
 *     if params.Page != nil {
 *         q.Add("page", queryParam(*params.Page))
 *     }
 *     return fetch[*AgentListResponse](r.http, ctx, requestSpec{Method: "GET", Path: "/api/v1/agents", Query: q})
 * }
 * ```
 */
export function emitGoResourceFile(
  packageName: string,
  resource: ResourceDef,
  registry: GoNameRegistry
): string {
  const cb = new CodeBuilder("\t");
  const imports = new Set<string>(["context"]);
  const allResources = flattenResourcesBottomUp(resource);

  // Names must exist before any signature references them.
  claimResourceTypeNames(allResources, registry);

  // Inline request-body structs (hoisted children first).
  for (const resourceDef of allResources) {
    for (const op of resourceDef.operations) {
      if (!hasInlineBody(op)) continue;
      const rootName = registry.lookup(inputKey(op));
      const hoist = hoistInlineObjects(op.body!.fields!, rootName, "typeddict");
      for (const child of hoist.hoisted) {
        emitGoStruct(cb, child.name, child.fields, registry, {
          description: child.description,
        });
        cb.line();
      }
      emitGoStruct(cb, rootName, hoist.fields, registry, {
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
        emitGoStruct(cb, child.name, child.fields, registry, {
          description: child.description,
        });
        cb.line();
      }
      emitGoStruct(cb, rootName, hoist.fields, registry, {
        description: op.returnDescription ?? op.summary,
      });
      cb.line();
    }
  }

  // Query-parameter option structs.
  for (const resourceDef of allResources) {
    for (const op of resourceDef.operations) {
      if (op.queryParams.length === 0) continue;
      emitParamsStruct(cb, op, resourceDef, registry);
      cb.line();
    }
  }

  for (let i = 0; i < allResources.length; i++) {
    emitResourceStruct(cb, allResources[i]!, registry, imports);
    if (i < allResources.length - 1) cb.line();
  }

  return renderGoFile(packageName, [...imports], cb.toString());
}

/**
 * Claim registry names for every inline input/response/params struct in a
 * resource tree. Called by the backend before file emission so cross-file
 * references resolve consistently.
 */
export function claimResourceTypeNames(
  resources: ResourceDef[],
  registry: GoNameRegistry
): void {
  for (const resource of resources) {
    for (const op of resource.operations) {
      if (hasInlineBody(op)) {
        registry.claim(inputKey(op), goInlineInputName(resource.className, op.name));
      }
      if (hasInlineResponse(op)) {
        registry.claim(
          responseKey(op),
          goInlineResponseName(resource.className, op.name)
        );
      }
      if (op.queryParams.length > 0) {
        registry.claim(
          paramsKey(op),
          goParamsStructName(resource.className, op.name)
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

export function paramsKey(op: OperationDef): string {
  return `params:${op.operationId}`;
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

/** Unexported constructor name for a resource struct. */
export function goResourceConstructor(className: string): string {
  return `new${className}`;
}

// ─── Member naming ───────────────────────────────────────────────

export interface GoResourceMembers {
  /** Exported field name per child resource, in declaration order. */
  childFields: string[];
  /** Exported method name per operation, in declaration order. */
  methodNames: string[];
}

/**
 * Exported member names for one resource. Go forbids a method and a field
 * sharing a name on the same type, so child accessors and operation methods
 * are uniquified together — and both the resource emitter and the
 * contract-tests emitter derive names from this one function.
 */
export function buildResourceMembers(resource: ResourceDef): GoResourceMembers {
  const names = uniqueGoFieldNames([
    ...resource.children.map((c) => c.name),
    ...resource.operations.map((o) => o.name),
  ]);
  return {
    childFields: names.slice(0, resource.children.length),
    methodNames: names.slice(resource.children.length),
  };
}

/** Exported method name for one operation on its resource. */
export function goMethodName(op: OperationDef, resource: ResourceDef): string {
  const index = resource.operations.indexOf(op);
  const members = buildResourceMembers(resource);
  return members.methodNames[index] ?? goExportedName(op.name);
}

export interface GoOperationNames {
  scope: string[];
  path: string[];
  body?: string;
  /** Params struct argument name, when the operation has query parameters. */
  params?: string;
}

/**
 * Unexported Go parameter names for an operation, in declaration order
 * (scope, path, body, params). Shared with the contract-tests emitter so
 * generated call sites always line up with generated signatures.
 */
export function buildOperationGoNames(
  op: OperationDef,
  resource: ResourceDef
): GoOperationNames {
  const entries: Array<{ kind: "scope" | "path"; name: string }> = [];
  for (const param of resource.scopeParams) entries.push({ kind: "scope", name: param.name });
  for (const param of op.pathParams) entries.push({ kind: "path", name: param.name });

  const unique = uniqueGoParamNames(
    entries.map((e) => e.name),
    METHOD_LOCALS
  );
  const result: GoOperationNames = { scope: [], path: [] };
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "scope") result.scope.push(unique[i]!);
    else result.path.push(unique[i]!);
  }
  if (op.body) result.body = "input";
  if (op.queryParams.length > 0) result.params = "params";
  return result;
}

// ─── Params struct ───────────────────────────────────────────────

function emitParamsStruct(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  registry: GoNameRegistry
): void {
  const name = registry.lookup(paramsKey(op));
  const resolveRef = makeRefResolver(registry);
  const fieldNames = goParamFieldNames(op);

  emitPlainDocComment(
    cb,
    `${name}: query parameters for ${resource.className}.${goMethodName(op, resource)}.`
  );
  cb.block(`type ${name} struct`, () => {
    for (let i = 0; i < op.queryParams.length; i++) {
      const param = op.queryParams[i]!;
      emitDocComment(cb, fieldNames[i]!, param.description);
      cb.line(`${fieldNames[i]} ${goFieldType(paramAsField(param), resolveRef)}`);
    }
  });
}

/** Exported field names for an operation's params struct. */
export function goParamFieldNames(op: OperationDef): string[] {
  return uniqueGoFieldNames(op.queryParams.map((p) => p.name));
}

/** Treat a query parameter as a struct field for type/tag derivation. */
export function paramAsField(param: ParamDef) {
  return {
    name: param.wireName ?? param.name,
    type: param.type,
    required:
      param.required &&
      param.type.kind !== "optional",
    description: param.description,
  };
}

// ─── Resource struct ─────────────────────────────────────────────

function emitResourceStruct(
  cb: CodeBuilder,
  resource: ResourceDef,
  registry: GoNameRegistry,
  imports: Set<string>
): void {
  const members = buildResourceMembers(resource);

  emitDocComment(cb, resource.className, resource.description);
  cb.block(`type ${resource.className} struct`, () => {
    cb.line("http *HTTPClient");
    for (let i = 0; i < resource.children.length; i++) {
      emitDocComment(cb, members.childFields[i]!, resource.children[i]!.description);
      cb.line(`${members.childFields[i]} *${resource.children[i]!.className}`);
    }
  });
  cb.line();

  const ctor = goResourceConstructor(resource.className);
  cb.block(`func ${ctor}(h *HTTPClient) *${resource.className}`, () => {
    cb.line(`return &${resource.className}{`);
    cb.indent();
    cb.line("http: h,");
    for (let i = 0; i < resource.children.length; i++) {
      cb.line(
        `${members.childFields[i]}: ${goResourceConstructor(resource.children[i]!.className)}(h),`
      );
    }
    cb.dedent();
    cb.line("}");
  });

  for (let i = 0; i < resource.operations.length; i++) {
    cb.line();
    emitOperation(cb, resource.operations[i]!, resource, members.methodNames[i]!, registry, imports);
  }
}

// ─── Operations ──────────────────────────────────────────────────

function emitOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  methodName: string,
  registry: GoNameRegistry,
  imports: Set<string>
): void {
  const names = buildOperationGoNames(op, resource);
  const signature = buildSignature(op, resource, methodName, names, registry);
  const needsURL = op.pathParams.length > 0 || resource.scopeParams.length > 0;
  if (needsURL || op.queryParams.length > 0) imports.add("net/url");

  emitOperationDocs(cb, op, resource, methodName, names);
  cb.block(signature, () => {
    emitQueryBuilder(cb, op, names, registry);
    const spec = requestSpecLiteral(op, resource, names);
    if (op.streaming) {
      cb.line(`return r.http.streamSSE(ctx, ${spec})`);
      return;
    }
    switch (goResponseShape(op)) {
      case "void":
        cb.line(`return r.http.requestVoid(ctx, ${spec})`);
        return;
      case "raw":
        cb.line(`return r.http.requestRaw(ctx, ${spec})`);
        return;
      default:
        cb.line(`return fetch[${goReturnType(op, registry)}](r.http, ctx, ${spec})`);
    }
  });
}

/** Go return type of the generated method, excluding the trailing error. */
export function goReturnType(
  op: OperationDef,
  registry: GoNameRegistry
): string {
  const resolveRef = makeRefResolver(registry);
  if (op.streaming) return "*SSEStream";
  switch (goResponseShape(op)) {
    case "void":
      return "";
    case "raw":
      return "*RawResponse";
    case "model":
      if (op.returnType.kind === "ref") return `*${resolveRef(op.returnType.schema)}`;
      return `*${registry.lookup(responseKey(op))}`;
    case "model_list": {
      const ret = op.returnType;
      if (ret.kind === "array" && ret.items.kind === "ref") {
        return `[]${resolveRef(ret.items.schema)}`;
      }
      return "JSONValue";
    }
    case "untyped":
      return "JSONValue";
  }
}

/** Go type of the generated method's request-body parameter. */
export function goBodyType(op: OperationDef, registry: GoNameRegistry): string {
  if (hasInlineBody(op)) return registry.lookup(inputKey(op));
  if (op.body?.schema && op.body.schema !== "inline") {
    return registry.has(`schema:${op.body.schema}`)
      ? registry.lookup(`schema:${op.body.schema}`)
      : op.body.schema;
  }
  return "map[string]JSONValue";
}

function buildSignature(
  op: OperationDef,
  resource: ResourceDef,
  methodName: string,
  names: GoOperationNames,
  registry: GoNameRegistry
): string {
  const parts = ["ctx context.Context"];
  for (const name of names.scope) parts.push(`${name} string`);
  for (const name of names.path) parts.push(`${name} string`);
  if (names.body) parts.push(`${names.body} ${goBodyType(op, registry)}`);
  if (names.params) parts.push(`${names.params} ${registry.lookup(paramsKey(op))}`);

  const returnType = goReturnType(op, registry);
  const results = returnType === "" ? "error" : `(${returnType}, error)`;
  return `func (r *${resource.className}) ${methodName}(${parts.join(", ")}) ${results}`;
}

function requestSpecLiteral(
  op: OperationDef,
  resource: ResourceDef,
  names: GoOperationNames
): string {
  const fields = [`Method: ${goString(op.method)}`, `Path: ${pathExpression(op, resource, names)}`];
  if (op.body) fields.push(`Body: ${names.body}`);
  if (op.queryParams.length > 0) fields.push("Query: q");
  return `requestSpec{${fields.join(", ")}}`;
}

function pathExpression(
  op: OperationDef,
  resource: ResourceDef,
  names: GoOperationNames
): string {
  const paramNames = new Map<string, string>();
  for (let i = 0; i < resource.scopeParams.length; i++) {
    paramNames.set(resource.scopeParams[i]!.name, names.scope[i]!);
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    paramNames.set(op.pathParams[i]!.name, names.path[i]!);
  }

  const parts: string[] = [];
  let literal = "";
  const pattern = /\{(\w+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(op.path)) !== null) {
    literal += op.path.slice(lastIndex, match.index);
    if (literal.length > 0) {
      parts.push(goString(literal));
      literal = "";
    }
    const raw = match[1]!;
    const name = paramNames.get(raw) ?? uniqueGoParamNames([raw], METHOD_LOCALS)[0]!;
    parts.push(`url.PathEscape(${name})`);
    lastIndex = match.index + match[0].length;
  }
  literal += op.path.slice(lastIndex);
  if (literal.length > 0 || parts.length === 0) parts.push(goString(literal));

  return parts.join(" + ");
}

function emitQueryBuilder(
  cb: CodeBuilder,
  op: OperationDef,
  names: GoOperationNames,
  registry: GoNameRegistry
): void {
  if (op.queryParams.length === 0) return;
  const fieldNames = goParamFieldNames(op);
  cb.line("q := url.Values{}");
  for (let i = 0; i < op.queryParams.length; i++) {
    emitQueryAppend(
      cb,
      op.queryParams[i]!,
      `${names.params}.${fieldNames[i]}`,
      registry
    );
  }
}

function emitQueryAppend(
  cb: CodeBuilder,
  param: ParamDef,
  accessor: string,
  registry: GoNameRegistry
): void {
  const wireKey = goString(param.wireName ?? param.name);
  const inner = unwrapOptional(param.type);
  // Dereference exactly when the params struct declared a pointer — slices,
  // maps, and JSONValue-typed parameters carry their own absent state.
  const pointer = goFieldType(
    paramAsField(param),
    makeRefResolver(registry)
  ).startsWith("*");

  const append = (ref: TypeRef, expr: string): void => {
    if (ref.kind === "array") {
      cb.block(`for _, item := range ${expr}`, () => {
        cb.line(`q.Add(${wireKey}, ${goQueryStringExpr(ref.items, "item")})`);
      });
    } else {
      cb.line(`q.Add(${wireKey}, ${goQueryStringExpr(ref, expr)})`);
    }
  };

  if (pointer) {
    const valueType = inner.kind === "nullable" ? inner.inner : inner;
    if (param.required && inner.kind === "nullable") {
      cb.line(`if ${accessor} == nil {`);
      cb.indent();
      cb.line(`q.Add(${wireKey}, "null")`);
      cb.dedent();
      cb.line("} else {");
      cb.indent();
      append(valueType, `*${accessor}`);
      cb.dedent();
      cb.line("}");
    } else {
      cb.block(`if ${accessor} != nil`, () =>
        append(valueType, `*${accessor}`)
      );
    }
  } else {
    append(inner, accessor);
  }
}

// ─── Docs ────────────────────────────────────────────────────────

function emitOperationDocs(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  methodName: string,
  names: GoOperationNames
): void {
  const summary = docLines(op.summary);
  const description = docLines(op.description).filter((l) => !summary.includes(l));

  const lines: string[] = [];
  if (summary.length > 0) lines.push(...summary);
  if (description.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...description);
  }

  const params: Array<[string, string]> = [];
  for (let i = 0; i < resource.scopeParams.length; i++) {
    const param = resource.scopeParams[i]!;
    if (param.description) params.push([names.scope[i]!, docLines(param.description).join(" ")]);
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    const param = op.pathParams[i]!;
    if (param.description) params.push([names.path[i]!, docLines(param.description).join(" ")]);
  }
  if (params.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const [name, doc] of params) lines.push(`${name}: ${doc}`);
  }
  if (op.returnDescription) {
    if (lines.length > 0) lines.push("");
    lines.push(`Returns: ${docLines(op.returnDescription).join(" ")}`);
  }

  if (lines.length === 0) return;
  cb.line(`// ${methodName}: ${lines[0]}`);
  for (const line of lines.slice(1)) {
    cb.line(line === "" ? "//" : `// ${line}`);
  }
}
