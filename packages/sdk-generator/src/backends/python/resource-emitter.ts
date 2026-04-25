import type {
  ResourceDef,
  OperationDef,
  TypeRef,
  FieldDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython, emitPythonImportLine } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import { typeRefToPython, typeRefsUseDatetime } from "./pydantic-emitter.js";
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
  const inlineInputs = collectInlineInputs(allResources);
  const inputNameByOpId = new Map(
    inlineInputs.map((g) => [g.operationId, g.className] as const)
  );

  for (const line of generatedHeaderPython().trim().split("\n")) { cb.line(line); };
  cb.line();
  cb.line("from __future__ import annotations");
  cb.line();

  const typingImports = collectTypedDictImports(inlineInputs);
  const inputFieldTypes = inlineInputs.flatMap((g) => g.fields.map((f) => f.type));
  if (typeRefsUseDatetime(inputFieldTypes)) {
    cb.line("from datetime import datetime");
  }
  if (typingImports.size > 0) {
    cb.line(`from typing import ${[...typingImports].sort().join(", ")}`);
  }
  cb.line(`from ${runtimeImport} import HttpClient`);

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
  // method signatures can reference them by name.
  for (const group of inlineInputs) {
    emitTypedDictClass(cb, group.className, group.fields, group.description);
    cb.line();
    cb.line();
  }

  for (let i = 0; i < allResources.length; i++) {
    emitResourceClass(cb, allResources[i]!, inputNameByOpId);
    if (i < allResources.length - 1) { cb.line(); cb.line(); }
  }

  return cb.toString();
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

function emitResourceClass(
  cb: CodeBuilder,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>
): void {
  cb.pyBlock(`class ${resource.className}`, () => {
    // __init__
    cb.pyBlock("def __init__(self, http: HttpClient)", () => {
      cb.line("self._http = http");
      for (const child of resource.children) {
        cb.line(`self.${child.name} = ${child.className}(http)`);
      }
    });

    // Operations
    for (const op of resource.operations) {
      cb.line();
      emitOperation(cb, op, resource, inputNameByOpId);
    }
  });
}

function emitOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>
): void {
  const params = buildParamList(op, resource, inputNameByOpId);
  const returnType = op.rawResponse ? "dict[str, str]" : typeRefToPython(op.returnType);
  const returnAnnotation = returnType;

  cb.pyBlock(
    `async def ${snakeCase(op.name)}(self${params ? ", " + params : ""}) -> ${returnAnnotation}`,
    () => {
      emitOperationDocstring(cb, op.summary, op.description);

      const pathExpr = buildPathExpression(op, resource);
      const optParts = buildRequestOptionParts(op);
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

function emitOperationDocstring(
  cb: CodeBuilder,
  summary?: string,
  description?: string
): void {
  const lines = [summary, description]
    .flatMap((text) => (text ?? "").split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  cb.line('"""');
  for (const line of lines) {
    cb.line(sanitizeComment(line));
  }
  cb.line('"""');
}

function buildParamList(
  op: OperationDef,
  resource: ResourceDef,
  inputNameByOpId: Map<string, string>
): string {
  const parts: string[] = [];

  // Scope params
  for (const sp of resource.scopeParams) {
    parts.push(`${snakeCase(sp.name)}: str`);
  }

  // Path params
  for (const pp of op.pathParams) {
    parts.push(`${snakeCase(pp.name)}: str`);
  }

  // Body param — typed via:
  //  - generated TypedDict (this module) when the body is inline
  //  - the named Pydantic model when the body is a $ref to a component schema
  if (op.body) {
    const inlineName = inputNameByOpId.get(op.operationId);
    if (inlineName) {
      parts.push(`input: ${inlineName}`);
    } else if (op.body.schema) {
      parts.push(`input: ${op.body.schema}`);
    } else {
      parts.push(`input: dict`);
    }
  }

  // Query params as **kwargs or typed dict
  if (op.queryParams.length > 0) {
    parts.push("**params");
  }

  return parts.join(", ");
}

function buildPathExpression(
  op: OperationDef,
  _resource: ResourceDef
): string {
  let path = op.path;
  path = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `{${snakeCase(name)}}`;
  });

  return `f"${path}"`;
}

function buildRequestOptionParts(op: OperationDef): string[] {
  const parts: string[] = [];

  if (op.method !== "GET") {
    parts.push(`method="${op.method}"`);
  }

  if (op.body) {
    parts.push("body=input");
  }

  if (op.queryParams.length > 0) {
    parts.push("query=params");
  }

  return parts;
}

/** Replace non-ASCII characters in comments to avoid Python SyntaxError. */
function sanitizeComment(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
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
