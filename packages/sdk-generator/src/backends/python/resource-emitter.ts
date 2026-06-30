import type {
  ResourceDef,
  OperationDef,
  TypeRef,
  FieldDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython, emitPythonImportLine } from "../../utils/codegen.js";
import { pascalCase } from "../../utils/naming.js";
import {
  pythonParameterName,
  uniquePythonParameterNames,
  uniquePythonPydanticFieldNames,
} from "./identifiers.js";
import {
  emitPydanticModel,
  primitiveMapsToAny,
  typeRefToPython,
  typeRefsUseDatetime,
} from "./pydantic-emitter.js";
import { hoistInlineObjects } from "./inline-object-hoist.js";
import {
  pythonInlineResponseName,
  pythonResponseTypeExpr,
} from "./response-type.js";
import {
  collectTypedDictImports,
  emitTypedDictClass,
} from "./typeddict-emitter.js";

/**
 * Generate a Python resource file from a ResourceDef (and its children).
 *
 * ```python
 * class AgentResource:
 *     def __init__(self, http: HttpClient):
 *         self._http = http
 *
 *     async def list(self, **params) -> list[Agent]:
 *         return await self._http.request(f"/api/v1/agents", query=params)
 * ```
 */
export function emitPythonResourceFile(
  resource: ResourceDef,
  _apiPrefix: string,
  options?: { runtimeImportPath?: string; schemaImports?: Record<string, string> }
): string {
  const cb = new CodeBuilder("    ");
  const runtimeImport = options?.runtimeImportPath ?? "..runtime.http_client";

  // Emit all resources (children first, then parent)
  const allResources = flattenResourcesBottomUp(resource);

  // Inline-body inputs need TypedDicts. Build the list once so we can both
  // emit the classes and look up the right name when typing the param list.
  // Hoist nested inline objects out as sibling TypedDicts (children-first)
  // so the parent's field references are bare names instead of nested objs.
  const collectedInputs = collectInlineInputs(allResources);
  const inputEmitOrder: Array<{ kind: "typeddict"; name: string; fields: FieldDef[]; description?: string }> = [];
  for (const group of collectedInputs) {
    const hoist = hoistInlineObjects(group.fields, group.className, "typeddict");
    for (const child of hoist.hoisted) {
      inputEmitOrder.push({ kind: "typeddict", name: child.name, fields: child.fields, description: child.description });
    }
    inputEmitOrder.push({ kind: "typeddict", name: group.className, fields: hoist.fields, description: group.description });
  }
  const inputNameByOpId = new Map(
    collectedInputs.map((g) => [g.operationId, g.className] as const)
  );

  // Inline response schemas need Pydantic models so callers get attribute
  // access on the response object instead of dict[str, object].
  const collectedResponses = collectInlineResponses(allResources);
  const responseEmitOrder: Array<{ kind: "basemodel"; name: string; fields: FieldDef[]; description?: string }> = [];
  for (const group of collectedResponses) {
    const hoist = hoistInlineObjects(group.fields, group.name, "basemodel");
    for (const child of hoist.hoisted) {
      responseEmitOrder.push({ kind: "basemodel", name: child.name, fields: child.fields, description: child.description });
    }
    responseEmitOrder.push({ kind: "basemodel", name: group.name, fields: hoist.fields, description: group.description });
  }
  const responseNameByOpId = new Map(
    collectedResponses.map((g) => [g.operationId, g.name] as const)
  );

  // SSE event TypedDict unions for streaming ops that declare events.
  const streamingEventGroups = collectStreamingEventGroups(allResources);

  for (const line of generatedHeaderPython().trim().split("\n")) { cb.line(line); };
  cb.line();
  cb.line("from __future__ import annotations");
  cb.line();

  // Typing imports cover both the TypedDict (input) and BaseModel (response)
  // emit groups, including everything hoisted out of nested objects.
  const typingImports = collectTypedDictImports(
    inputEmitOrder.map((g) => ({ fields: g.fields }))
  );
  for (const group of responseEmitOrder) {
    for (const field of group.fields) {
      collectTypingFromTypeRef(field.type, typingImports);
    }
  }
  collectOperationTypingImports(allResources, typingImports, responseNameByOpId);
  const allFieldTypes = [
    ...inputEmitOrder.flatMap((g) => g.fields.map((f) => f.type)),
    ...responseEmitOrder.flatMap((g) => g.fields.map((f) => f.type)),
  ];
  if (typeRefsUseDatetime(allFieldTypes)) {
    cb.line("from datetime import datetime");
  }
  if (responseEmitOrder.length > 0) {
    const pydanticImports = ["BaseModel"];
    if (responseEmitOrder.some((group) => groupHasAliasedPydanticFields(group.fields))) {
      pydanticImports.push("ConfigDict", "Field");
    } else if (responseEmitOrder.some((group) => group.fields.some((field) => field.description))) {
      pydanticImports.push("Field");
    }
    cb.line(`from pydantic import ${pydanticImports.join(", ")}`);
  }
  if (typingImports.size > 0) {
    cb.line(`from typing import ${[...typingImports].sort().join(", ")}`);
  }
  cb.line(`from ${runtimeImport} import HttpClient, SyncHttpClient`);

  // Add type imports for schema refs used in operations + as $ref bodies
  if (options?.schemaImports) {
    const refs = collectSchemaRefs(allResources);
    // Group by module
    const byModule = new Map<string, string[]>();
    for (const ref of refs) {
      const mod = options.schemaImports[ref];
      if (mod) {
        const existing = byModule.get(mod) ?? [];
        existing.push(ref);
        byModule.set(mod, existing);
      }
    }
    for (const [mod, names] of [...byModule.entries()].sort()) {
      emitPythonImportLine(cb, mod, names.sort());
    }
  }

  cb.line();
  cb.line();

  // TypedDict input classes — emitted ahead of the resource classes so the
  // method signatures can reference them by name. Hoisted children come
  // before their parents in the emit order so forward refs never appear.
  for (const group of inputEmitOrder) {
    emitTypedDictClass(cb, group.name, group.fields, group.description);
    cb.line();
    cb.line();
  }

  // Pydantic response models — same idea, ahead of resource classes.
  for (const group of responseEmitOrder) {
    emitPydanticModel(cb, {
      name: group.name,
      fields: group.fields,
      description: group.description,
    });
    cb.line();
    cb.line();
  }

  // SSE event TypedDict unions — one discriminated member per declared event,
  // referenced by the streaming methods' return annotations.
  for (const group of streamingEventGroups) {
    for (const member of group.members) {
      cb.pyBlock(`class ${member.className}(TypedDict)`, () => {
        cb.line(`event: Literal[${JSON.stringify(member.eventName)}]`);
        cb.line(`data: ${typeRefToPythonResourceAnnotation(member.dataType)}`);
      });
      cb.line();
      cb.line();
    }

    const rhs =
      group.members.length === 1
        ? group.members[0]!.className
        // `A | B` rather than `Union[A, B]` (ruff UP007).
        : group.members.map((m) => m.className).join(" | ");
    cb.line(`${group.unionName} = ${rhs}`);
    cb.line();
    cb.line();
  }

  for (let i = 0; i < allResources.length; i++) {
    emitAsyncResourceClass(cb, allResources[i]!, inputNameByOpId, responseNameByOpId);
    cb.line();
    cb.line();
  }

  for (let i = 0; i < allResources.length; i++) {
    emitResourceClass(cb, allResources[i]!, inputNameByOpId, responseNameByOpId);
    if (i < allResources.length - 1) { cb.line(); cb.line(); }
  }

  return cb.toString();
}

export function pyAsyncResourceClassName(className: string): string {
  return `Async${className}`;
}

function flattenResourcesBottomUp(resource: ResourceDef): ResourceDef[] {
  const result: ResourceDef[] = [];
  for (const child of resource.children) {
    result.push(...flattenResourcesBottomUp(child));
  }
  result.push(resource);
  return result;
}

interface InlineInputGroup {
  operationId: string;
  className: string;
  fields: FieldDef[];
  description?: string;
}

/**
 * Find every operation with an inline request body and assign it a stable
 * `{ResourceShortName}{OpName}Input` class name. The short name strips the
 * trailing "Resource" suffix from the className so we get e.g. `TeamCreateInput`
 * rather than `TeamResourceCreateInput`. The resource prefix avoids collisions
 * when sibling resources in the same file share an op name (e.g. multiple
 * `create` operations in `teams.py`).
 *
 * `body.fields` distinguishes inline bodies from $ref bodies — the frontend
 * only attaches `fields` when the schema was inline.
 */
interface InlineResponseGroup {
  operationId: string;
  name: string;
  fields: FieldDef[];
  description?: string;
}

/**
 * Find every operation whose response is an inline (non-$ref) object schema
 * and assign it a `{ResourceShortName}{OpName}Response` BaseModel name.
 * Empty objects (`{type: "object"}` with no properties) stay as
 * `dict[str, object]` — there is nothing to put on the model.
 */
function collectInlineResponses(resources: ResourceDef[]): InlineResponseGroup[] {
  const groups: InlineResponseGroup[] = [];
  for (const resource of resources) {
    for (const op of resource.operations) {
      if (op.rawResponse) continue;
      if (
        op.returnType.kind === "object" &&
        op.returnType.fields.length > 0
      ) {
        groups.push({
          operationId: op.operationId,
          name: pythonInlineResponseName(resource.className, op.name),
          fields: op.returnType.fields,
          description: op.returnDescription ?? op.summary,
        });
      }
    }
  }
  return groups;
}

/** Mirror of pydantic-emitter's typing-import collector for inline TypeRefs. */
function collectTypingFromTypeRef(ref: TypeRef, imports: Set<string>): void {
  switch (ref.kind) {
    case "optional":
      imports.add("Optional");
      collectTypingFromTypeRef(ref.inner, imports);
      break;
    case "enum":
      if (ref.values.length > 0) imports.add("Literal");
      break;
    case "array":
      collectTypingFromTypeRef(ref.items, imports);
      break;
    case "union":
      for (const v of ref.variants) collectTypingFromTypeRef(v, imports);
      break;
    case "map":
      collectTypingFromTypeRef(ref.valueType, imports);
      break;
    case "object":
    case "unknown":
      imports.add("Any");
      break;
    case "primitive":
      if (primitiveMapsToAny(ref.type)) imports.add("Any");
      break;
  }
}

function collectOperationTypingImports(
  resources: ResourceDef[],
  imports: Set<string>,
  responseNameByOpId: Map<string, string>
): void {
  for (const resource of resources) {
    for (const op of resource.operations) {
      if (op.streaming) {
        imports.add("AsyncIterator");
        imports.add("Iterator");
        imports.add("Dict");
        imports.add("Any");
        if (op.streaming.events.length > 0) {
          imports.add("Literal");
          imports.add("TypedDict");
          if (op.streaming.events.length > 1) imports.add("Union");
          for (const e of op.streaming.events) {
            collectTypingFromTypeRef(e.dataType, imports);
          }
        }
      } else if (op.rawResponse) {
        imports.add("Dict");
      } else if (!responseNameByOpId.has(op.operationId)) {
        collectTypingFromResourceAnnotation(op.returnType, imports);
      }
      if (op.body?.fields) {
        for (const field of op.body.fields) {
          collectTypingFromTypeRef(field.type, imports);
        }
      } else if (op.body && !op.body.schema) {
        imports.add("Any");
        imports.add("Dict");
      }
      for (const param of op.queryParams) {
        collectTypingFromResourceAnnotation(param.type, imports);
      }
    }
  }
}

function collectTypingFromResourceAnnotation(ref: TypeRef, imports: Set<string>): void {
  switch (ref.kind) {
    case "optional":
      imports.add("Optional");
      collectTypingFromResourceAnnotation(ref.inner, imports);
      break;
    case "enum":
      if (ref.values.length > 0) imports.add("Literal");
      break;
    case "array":
      imports.add("List");
      collectTypingFromResourceAnnotation(ref.items, imports);
      break;
    case "union":
      for (const v of ref.variants) collectTypingFromResourceAnnotation(v, imports);
      break;
    case "map":
      imports.add("Dict");
      collectTypingFromResourceAnnotation(ref.valueType, imports);
      break;
    case "object":
      imports.add("Any");
      imports.add("Dict");
      break;
    case "unknown":
      imports.add("Any");
      break;
    case "primitive":
      if (primitiveMapsToAny(ref.type)) imports.add("Any");
      break;
  }
}

function groupHasAliasedPydanticFields(fields: FieldDef[]): boolean {
  const names = uniquePythonPydanticFieldNames(fields.map((field) => field.name));
  return fields.some((field, index) => names[index] !== field.name);
}

function collectInlineInputs(resources: ResourceDef[]): InlineInputGroup[] {
  const groups: InlineInputGroup[] = [];
  for (const resource of resources) {
    const shortName = resource.className.replace(/Resource$/, "");
    for (const op of resource.operations) {
      if (op.body?.fields && op.body.fields.length > 0) {
        groups.push({
          operationId: op.operationId,
          className: `${shortName}${pascalCase(op.name)}Input`,
          fields: op.body.fields,
          description: op.summary ?? op.description,
        });
      }
    }
  }
  return groups;
}

/** Name of the TypedDict union for a streaming op's events, e.g. `RunStreamEvent`. */
function streamEventUnionName(resource: ResourceDef, op: OperationDef): string {
  const shortName = resource.className.replace(/Resource$/, "");
  return `${shortName}${pascalCase(op.name)}Event`;
}

/** Return annotation for a streaming op: the typed event union, or a generic dict. */
function streamEventType(op: OperationDef, resource: ResourceDef): string {
  return op.streaming && op.streaming.events.length > 0
    ? streamEventUnionName(resource, op)
    : "Dict[str, Any]";
}

interface StreamingEventGroup {
  unionName: string;
  members: Array<{ className: string; eventName: string; dataType: TypeRef }>;
}

/**
 * For every streaming op that declares events, build a discriminated TypedDict
 * union: one `{event: Literal["name"], data: <DataType>}` member per event,
 * aliased as `{ResourceShort}{Op}Event`. Mirrors the TypeScript backend's
 * inline event union. Ops with no declared events stay `Dict[str, Any]`.
 */
function collectStreamingEventGroups(resources: ResourceDef[]): StreamingEventGroup[] {
  const groups: StreamingEventGroup[] = [];
  for (const resource of resources) {
    for (const op of resource.operations) {
      if (!op.streaming || op.streaming.events.length === 0) continue;
      const unionName = streamEventUnionName(resource, op);
      groups.push({
        unionName,
        members: op.streaming.events.map((e) => ({
          className: `${unionName}${pascalCase(e.event)}`,
          eventName: e.event,
          dataType: e.dataType,
        })),
      });
    }
  }
  return groups;
}

function emitAsyncResourceClass(
  cb: CodeBuilder,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>,
  responseNameByOpId: Map<string, string>
): void {
  cb.pyBlock(`class ${pyAsyncResourceClassName(resource.className)}`, () => {
    // __init__
    cb.pyBlock("def __init__(self, http: HttpClient)", () => {
      cb.line("self._http = http");
      for (const child of resource.children) {
        cb.line(
          `self.${pythonParameterName(child.name)} = ${pyAsyncResourceClassName(child.className)}(http)`
        );
      }
    });

    // Operations
    for (const op of resource.operations) {
      cb.line();
      emitOperation(cb, op, resource, inputNameByOpId, responseNameByOpId);
    }
  });
}

function emitResourceClass(
  cb: CodeBuilder,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>,
  responseNameByOpId: Map<string, string>
): void {
  cb.pyBlock(`class ${resource.className}`, () => {
    cb.pyBlock("def __init__(self, http: SyncHttpClient)", () => {
      cb.line("self._http = http");
      for (const child of resource.children) {
        cb.line(
          `self.${pythonParameterName(child.name)} = ${child.className}(http)`
        );
      }
    });

    for (const op of resource.operations) {
      cb.line();
      emitSyncOperation(cb, op, resource, inputNameByOpId, responseNameByOpId);
    }
  });
}

function emitOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>,
  responseNameByOpId: Map<string, string>
): void {
  if (op.streaming) {
    emitStreamingOperation(cb, op, resource, inputNameByOpId);
    return;
  }

  const pythonNames = buildOperationPythonNames(op, resource);
  const params = buildParamList(op, resource, inputNameByOpId, pythonNames);
  const responseName = responseNameByOpId.get(op.operationId);
  const returnType = op.rawResponse
    ? "Dict[str, str]"
    : (responseName ?? typeRefToPythonResourceAnnotation(op.returnType));
  const returnAnnotation = returnType;

  cb.pyBlock(
    `async def ${pythonParameterName(op.name)}(self${params ? ", " + params : ""}) -> ${returnAnnotation}`,
    () => {
      emitOperationDocstring(cb, op, resource, pythonNames);

      // Build the query dict ahead of the request call so optional params can
      // be omitted entirely (vs. sending `?key=null`). Required params land
      // unconditionally; optional params only when the kwarg is non-None.
      if (op.queryParams.length > 0) {
        cb.line("query: dict[str, object] = {}");
        for (let i = 0; i < op.queryParams.length; i++) {
          const qp = op.queryParams[i]!;
          const py = pythonNames.query[i]!;
          const wireKey = JSON.stringify(qp.wireName ?? qp.name);
          if (qp.required) {
            cb.line(`query[${wireKey}] = ${py}`);
          } else {
            cb.line(`if ${py} is not None:`);
            cb.line(`    query[${wireKey}] = ${py}`);
          }
        }
      }

      const pathExpr = buildPathExpression(op, resource, pythonNames);
      const optParts = buildRequestOptionParts(op, pythonNames, responseName);
      const requestMethod = op.rawResponse ? "request_raw" : "request";
      const prefix = returnAnnotation === "None"
        ? "await" : "return await";
      const allArgs = [pathExpr, ...optParts];
      const oneLiner = `${prefix} self._http.${requestMethod}(${allArgs.join(", ")})`;

      // 8 = two indent levels (class body + method body), 100 = ruff line-length
      if (oneLiner.length + 8 <= 100) {
        cb.line(oneLiner);
      } else {
        cb.line(`${prefix} self._http.${requestMethod}(`);
        for (const arg of allArgs) {
          cb.line(`    ${arg},`);
        }
        cb.line(")");
      }
    }
  );
}

// Emit an SSE streaming op as an async generator that yields parsed events.
// Targets the runtime's `stream_sse(path, ...)` async iterator (any method +
// body). Events are yielded as dicts; typed event models are a follow-up.
function emitStreamingOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>
): void {
  const pythonNames = buildOperationPythonNames(op, resource);
  const params = buildParamList(op, resource, inputNameByOpId, pythonNames);
  const eventType = streamEventType(op, resource);

  cb.pyBlock(
    `async def ${pythonParameterName(op.name)}(self${params ? ", " + params : ""}) -> AsyncIterator[${eventType}]`,
    () => {
      emitOperationDocstring(cb, op, resource, pythonNames);

      if (op.queryParams.length > 0) {
        cb.line("query: dict[str, object] = {}");
        for (let i = 0; i < op.queryParams.length; i++) {
          const qp = op.queryParams[i]!;
          const py = pythonNames.query[i]!;
          const wireKey = JSON.stringify(qp.wireName ?? qp.name);
          if (qp.required) {
            cb.line(`query[${wireKey}] = ${py}`);
          } else {
            cb.line(`if ${py} is not None:`);
            cb.line(`    query[${wireKey}] = ${py}`);
          }
        }
      }

      const pathExpr = buildPathExpression(op, resource, pythonNames);
      const parts: string[] = [pathExpr];
      if (op.method !== "GET") parts.push(`method="${op.method}"`);
      if (op.body) parts.push(`body=${pythonNames.body}`);
      if (op.queryParams.length > 0) parts.push("query=query");

      cb.pyBlock(`async for event in self._http.stream_sse(${parts.join(", ")})`, () => {
        cb.line("yield event");
      });
    }
  );
}

// Sync variant of an SSE stream: a sync generator over the runtime's
// `stream_sse_sync(path, ...)` iterator.
function emitSyncStreamingOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>
): void {
  const pythonNames = buildOperationPythonNames(op, resource);
  const params = buildParamList(op, resource, inputNameByOpId, pythonNames);
  const eventType = streamEventType(op, resource);

  cb.pyBlock(
    `def ${pythonParameterName(op.name)}(self${params ? ", " + params : ""}) -> Iterator[${eventType}]`,
    () => {
      emitOperationDocstring(cb, op, resource, pythonNames);

      if (op.queryParams.length > 0) {
        cb.line("query: dict[str, object] = {}");
        for (let i = 0; i < op.queryParams.length; i++) {
          const qp = op.queryParams[i]!;
          const py = pythonNames.query[i]!;
          const wireKey = JSON.stringify(qp.wireName ?? qp.name);
          if (qp.required) {
            cb.line(`query[${wireKey}] = ${py}`);
          } else {
            cb.line(`if ${py} is not None:`);
            cb.line(`    query[${wireKey}] = ${py}`);
          }
        }
      }

      const pathExpr = buildPathExpression(op, resource, pythonNames);
      const parts: string[] = [pathExpr];
      if (op.method !== "GET") parts.push(`method="${op.method}"`);
      if (op.body) parts.push(`body=${pythonNames.body}`);
      if (op.queryParams.length > 0) parts.push("query=query");

      // `yield from` (not a for/yield loop) — ruff UP028, and equivalent for a
      // sync generator delegating to the iterator.
      cb.line(`yield from self._http.stream_sse_sync(${parts.join(", ")})`);
    }
  );
}

function emitSyncOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>,
  responseNameByOpId: Map<string, string>
): void {
  if (op.streaming) {
    emitSyncStreamingOperation(cb, op, resource, inputNameByOpId);
    return;
  }

  const pythonNames = buildOperationPythonNames(op, resource);
  const params = buildParamList(op, resource, inputNameByOpId, pythonNames);
  const responseName = responseNameByOpId.get(op.operationId);
  const returnType = op.rawResponse
    ? "Dict[str, str]"
    : (responseName ?? typeRefToPythonResourceAnnotation(op.returnType));
  const methodName = pythonParameterName(op.name);
  const returnAnnotation = returnType;

  cb.pyBlock(
    `def ${methodName}(self${params ? ", " + params : ""}) -> ${returnType}`,
    () => {
      emitOperationDocstring(cb, op, resource, pythonNames);

      if (op.queryParams.length > 0) {
        cb.line("query: dict[str, object] = {}");
        for (let i = 0; i < op.queryParams.length; i++) {
          const qp = op.queryParams[i]!;
          const py = pythonNames.query[i]!;
          const wireKey = JSON.stringify(qp.wireName ?? qp.name);
          if (qp.required) {
            cb.line(`query[${wireKey}] = ${py}`);
          } else {
            cb.line(`if ${py} is not None:`);
            cb.line(`    query[${wireKey}] = ${py}`);
          }
        }
      }

      const pathExpr = buildPathExpression(op, resource, pythonNames);
      const optParts = buildRequestOptionParts(op, pythonNames, responseName);
      const requestMethod = op.rawResponse ? "request_raw" : "request";
      const prefix = returnAnnotation === "None" ? "" : "return ";
      const allArgs = [pathExpr, ...optParts];
      const oneLiner = `${prefix}self._http.${requestMethod}(${allArgs.join(", ")})`;

      if (oneLiner.length + 8 <= 100) {
        cb.line(oneLiner);
      } else {
        cb.line(`${prefix}self._http.${requestMethod}(`);
        for (const arg of allArgs) {
          cb.line(`    ${arg},`);
        }
        cb.line(")");
      }
    }
  );
}

function emitOperationDocstring(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  pythonNames: OperationPythonNames
): void {
  const lines = [op.summary, op.description]
    .flatMap(docLines);

  const args: Array<[string, string]> = [];
  for (let i = 0; i < resource.scopeParams.length; i++) {
    const param = resource.scopeParams[i]!;
    if (param.description) args.push([pythonNames.scope[i]!, param.description]);
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    const param = op.pathParams[i]!;
    if (param.description) args.push([pythonNames.path[i]!, param.description]);
  }
  if (op.body) {
    args.push([pythonNames.body ?? "input", "Request body."]);
    for (const field of op.body.fields ?? []) {
      if (field.description) {
        args.push([`${pythonNames.body ?? "input"}.${field.name}`, field.description]);
      }
    }
  }
  for (let i = 0; i < op.queryParams.length; i++) {
    const param = op.queryParams[i]!;
    if (param.description) args.push([pythonNames.query[i]!, param.description]);
  }

  if (args.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Args:");
    for (const [name, description] of args) {
      lines.push(`    ${name}: ${sanitizeComment(description)}`);
    }
  }

  if (op.returnDescription) {
    if (lines.length > 0) lines.push("");
    lines.push("Returns:");
    lines.push(`    ${sanitizeComment(op.returnDescription)}`);
  }

  if (lines.length === 0) return;

  cb.line('"""');
  for (const line of lines) {
    cb.line(line === "" ? "" : sanitizeDocstringLine(line));
  }
  cb.line('"""');
}

function docLines(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface OperationPythonNames {
  scope: string[];
  path: string[];
  body?: string;
  query: string[];
}

function buildOperationPythonNames(
  op: OperationDef,
  resource: ResourceDef
): OperationPythonNames {
  const entries: Array<
    | { kind: "scope"; index: number; name: string }
    | { kind: "path"; index: number; name: string }
    | { kind: "body"; name: string }
    | { kind: "query"; index: number; name: string }
  > = [];

  resource.scopeParams.forEach((param, index) => {
    entries.push({ kind: "scope", index, name: param.name });
  });
  op.pathParams.forEach((param, index) => {
    entries.push({ kind: "path", index, name: param.name });
  });
  if (op.body) {
    entries.push({ kind: "body", name: "input" });
  }
  op.queryParams.forEach((param, index) => {
    entries.push({ kind: "query", index, name: param.name });
  });

  const uniqueNames = uniquePythonParameterNames(entries.map((entry) => entry.name));
  const result: OperationPythonNames = { scope: [], path: [], query: [] };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const name = uniqueNames[i]!;
    switch (entry.kind) {
      case "scope":
        result.scope[entry.index] = name;
        break;
      case "path":
        result.path[entry.index] = name;
        break;
      case "body":
        result.body = name;
        break;
      case "query":
        result.query[entry.index] = name;
        break;
    }
  }
  return result;
}

function buildParamList(
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>,
  pythonNames: OperationPythonNames
): string {
  const parts: string[] = [];

  // Scope params
  for (let i = 0; i < resource.scopeParams.length; i++) {
    parts.push(`${pythonNames.scope[i]}: str`);
  }

  // Path params
  for (let i = 0; i < op.pathParams.length; i++) {
    parts.push(`${pythonNames.path[i]}: str`);
  }

  // Body param — typed via:
  //  - generated TypedDict (this module) when the body is inline
  //  - the named Pydantic model when the body is a $ref to a component schema
  if (op.body) {
    const inlineName = inputNameByOpId.get(op.operationId);
    if (inlineName) {
      parts.push(`${pythonNames.body}: ${inlineName}`);
    } else if (op.body.schema) {
      parts.push(`${pythonNames.body}: ${op.body.schema}`);
    } else {
      parts.push(`${pythonNames.body}: Dict[str, Any]`);
    }
  }

  // Query params split into required positional and optional keyword-only.
  // Required ones precede the `*` separator; optional ones follow with
  // `T | None = None` defaults so callers can omit any combination.
  const queryParams = op.queryParams.map((param, index) => ({
    param,
    name: pythonNames.query[index]!,
  }));
  const required = queryParams.filter(({ param }) => param.required);
  const optional = queryParams.filter(({ param }) => !param.required);
  for (const { param, name } of required) {
    parts.push(`${name}: ${typeRefToPythonResourceAnnotation(param.type)}`);
  }
  if (optional.length > 0) {
    parts.push("*");
    for (const { param, name } of optional) {
      parts.push(
        `${name}: ${typeRefToPythonResourceAnnotation(param.type)} | None = None`
      );
    }
  }

  return parts.join(", ");
}

function buildPathExpression(
  op: OperationDef,
  resource: ResourceDef,
  pythonNames: OperationPythonNames
): string {
  const pathNames = new Map<string, string>();
  for (let i = 0; i < resource.scopeParams.length; i++) {
    pathNames.set(resource.scopeParams[i]!.name, pythonNames.scope[i]!);
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    pathNames.set(op.pathParams[i]!.name, pythonNames.path[i]!);
  }
  let path = op.path;
  path = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `{${pathNames.get(name) ?? pythonParameterName(name)}}`;
  });

  return `f"${path}"`;
}

function buildRequestOptionParts(
  op: OperationDef,
  pythonNames: OperationPythonNames,
  inlineResponseName: string | undefined
): string[] {
  const parts: string[] = [];

  if (op.method !== "GET") {
    parts.push(`method="${op.method}"`);
  }

  if (op.body) {
    parts.push(`body=${pythonNames.body}`);
  }

  if (op.queryParams.length > 0) {
    parts.push("query=query");
  }

  const responseTypeExpr = pythonResponseTypeExpr(op, inlineResponseName);
  if (responseTypeExpr) {
    parts.push(`response_type=${responseTypeExpr}`);
  }

  return parts;
}

function typeRefToPythonResourceAnnotation(ref: TypeRef): string {
  switch (ref.kind) {
    case "primitive":
      return typeRefToPython(ref);
    case "array":
      return `List[${typeRefToPythonResourceAnnotation(ref.items)}]`;
    case "object":
      return "Dict[str, Any]";
    case "ref":
      return ref.schema;
    case "enum":
      return typeRefToPython(ref);
    case "union":
      return ref.variants.map(typeRefToPythonResourceAnnotation).join(" | ");
    case "optional":
      return `Optional[${typeRefToPythonResourceAnnotation(ref.inner)}]`;
    case "map":
      return `Dict[str, ${typeRefToPythonResourceAnnotation(ref.valueType)}]`;
    case "unknown":
      return "Any";
    case "void":
      return "None";
  }
}

/** Replace non-ASCII characters in comments to avoid Python SyntaxError. */
function sanitizeComment(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeDocstringLine(line: string): string {
  const leading = line.match(/^ */)?.[0] ?? "";
  const body = line.slice(leading.length);
  return `${leading}${sanitizeComment(body)}`;
}

/** Collect all schema ref names used in return types or $ref bodies. */
function collectSchemaRefs(resources: ResourceDef[]): Set<string> {
  const refs = new Set<string>();
  for (const resource of resources) {
    for (const op of resource.operations) {
      collectTypeRefs(op.returnType, refs);
      // $ref bodies need a cross-module import; inline bodies (which carry
      // `fields`) get a TypedDict emitted in this same file.
      if (op.body?.schema && !op.body.fields) {
        refs.add(op.body.schema);
      }
      // $ref event payloads (data:) need the model imported too.
      if (op.streaming) {
        for (const e of op.streaming.events) collectTypeRefs(e.dataType, refs);
      }
    }
  }
  return refs;
}

function collectTypeRefs(ref: TypeRef, out: Set<string>): void {
  switch (ref.kind) {
    case "ref":
      out.add(ref.schema);
      break;
    case "array":
      collectTypeRefs(ref.items, out);
      break;
    case "object":
      for (const f of ref.fields) collectTypeRefs(f.type, out);
      break;
    case "optional":
      collectTypeRefs(ref.inner, out);
      break;
    case "union":
      for (const v of ref.variants) collectTypeRefs(v, out);
      break;
  }
}
