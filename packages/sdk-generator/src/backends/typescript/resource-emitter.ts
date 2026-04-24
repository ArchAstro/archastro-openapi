import type {
  ResourceDef,
  OperationDef,
  ParamDef,
  TypeRef,
} from "../../ast/types.js";
import {
  CodeBuilder,
  ImportTracker,
  generatedHeader,
} from "../../utils/codegen.js";
import { camelCase } from "../../utils/naming.js";

/**
 * Generate a TypeScript resource file from a ResourceDef (and its children).
 *
 * Output pattern matches the existing developer-platform-sdk:
 *
 * ```ts
 * export class TeamMembersResource {
 *   constructor(private http: HttpClient) {}
 *   async list(appId: string, teamId: string): Promise<{ data: TeamMember[] }> { ... }
 * }
 *
 * export class TeamsResource {
 *   readonly members: TeamMembersResource;
 *   constructor(private http: HttpClient) {
 *     this.members = new TeamMembersResource(http);
 *   }
 *   async list(appId: string, params?: ListTeamsParams): Promise<PaginatedResponse<Team>> { ... }
 * }
 * ```
 */
export function emitResourceFile(
  resource: ResourceDef,
  apiPrefix: string,
  options?: { runtimeImportPath?: string; schemaImports?: Record<string, string> }
): string {
  const cb = new CodeBuilder();
  const imports = new ImportTracker();

  imports.add(options?.runtimeImportPath ?? "../runtime/http-client.js", "HttpClient");

  // Collect all resources to emit (children first, then parent)
  const allResources = flattenResourcesBottomUp(resource);

  // Add type imports for schema refs used in operations
  if (options?.schemaImports) {
    const refs = collectSchemaRefs(allResources);
    for (const ref of refs) {
      const importPath = options.schemaImports[ref];
      if (importPath) {
        imports.addType(importPath, ref);
      }
    }
  }

  cb.line(generatedHeader());
  cb.line(imports.emit());

  for (let i = 0; i < allResources.length; i++) {
    emitResourceClass(cb, allResources[i]!, apiPrefix);
    if (i < allResources.length - 1) cb.line();
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

function emitResourceClass(
  cb: CodeBuilder,
  resource: ResourceDef,
  apiPrefix: string
): void {
  cb.block(`export class ${resource.className}`, () => {
    // Child resource properties
    for (const child of resource.children) {
      cb.line(`readonly ${child.name}: ${child.className};`);
    }

    // Constructor
    if (resource.children.length > 0) {
      cb.line();
      cb.block("constructor(private http: HttpClient)", () => {
        for (const child of resource.children) {
          cb.line(`this.${child.name} = new ${child.className}(http);`);
        }
      });
    } else {
      cb.line("constructor(private http: HttpClient) {}");
    }

    // Operations
    for (const op of resource.operations) {
      cb.line();
      emitOperation(cb, op, resource, apiPrefix);
    }
  });
}

function emitOperation(
  cb: CodeBuilder,
  op: OperationDef,
  resource: ResourceDef,
  _apiPrefix: string
): void {
  const params = buildParamList(op, resource);
  const returnType = typeRefToTS(op.returnType);
  const returnTypeStr = op.rawResponse
    ? "Promise<{ content: ArrayBuffer; mimeType: string }>"
    : op.returnType.kind === "void"
    ? "Promise<void>"
    : `Promise<${returnType}>`;

  emitOperationComment(cb, op.summary, op.description);
  if (op.deprecated) {
    cb.line(`/** @deprecated */`);
  }

  const awaitPrefix = op.returnType.kind === "void" && !op.rawResponse ? "await " : "return ";
  const methodSig = `async ${op.name}(${params}): ${returnTypeStr}`;

  cb.block(methodSig, () => {
    const pathExpr = buildPathExpression(op, resource);
    const options = buildRequestOptions(op);

    const requestMethod = op.rawResponse ? "requestRaw" : "request";

    if (options) {
      cb.line(`${awaitPrefix}this.http.${requestMethod}(${pathExpr}, ${options});`);
    } else {
      cb.line(`${awaitPrefix}this.http.${requestMethod}(${pathExpr});`);
    }
  });
}

function emitOperationComment(
  cb: CodeBuilder,
  summary?: string,
  description?: string
): void {
  const parts = [summary, description]
    .flatMap((text) => (text ?? "").split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);

  if (parts.length === 0) return;

  if (parts.length === 1) {
    cb.line(`/** ${parts[0]} */`);
    return;
  }

  cb.line("/**");
  for (const line of parts) {
    cb.line(` * ${line}`);
  }
  cb.line(" */");
}

function buildParamList(op: OperationDef, resource: ResourceDef): string {
  const parts: string[] = [];

  // Scope params (e.g., appId)
  for (const sp of resource.scopeParams) {
    parts.push(`${sp.name}: string`);
  }

  // Path params (e.g., teamId)
  for (const pp of op.pathParams) {
    parts.push(`${pp.name}: string`);
  }

  // Body param — use named type if it has a real schema ref, otherwise
  // emit an inline object type built from the parsed body fields.
  if (op.body) {
    parts.push(`input: ${bodyTypeString(op.body)}`);
  }

  // Query params as optional object
  if (op.queryParams.length > 0) {
    const queryType = buildQueryParamsType(op.queryParams);
    parts.push(`params?: ${queryType}`);
  }

  return parts.join(", ");
}

function buildQueryParamsType(params: ParamDef[]): string {
  const fields = params.map((p) => {
    const tsType = typeRefToTS(p.type);
    return `${p.name}?: ${tsType}`;
  });
  return `{ ${fields.join("; ")} }`;
}

function bodyTypeString(body: NonNullable<OperationDef["body"]>): string {
  // Inline bodies are given a synthesized `schema` name by the inferrer for
  // stability, but no corresponding type is generated — so when `fields`
  // are present we render the object literal directly.
  if (body.fields && body.fields.length > 0) {
    const shape = body.fields
      .map((f) => {
        const opt = f.required ? "" : "?";
        return `${f.name}${opt}: ${typeRefToTS(f.type)}`;
      })
      .join("; ");
    return `{ ${shape} }`;
  }

  // Otherwise the body is a named schema ref (e.g., CreateTeamInput). The
  // resource file's import block is populated by collectSchemaRefs, which
  // walks body refs too.
  if (body.schema && body.schema !== "inline") return body.schema;

  return "Record<string, unknown>";
}

function buildPathExpression(
  op: OperationDef,
  _resource: ResourceDef
): string {
  // Build the path with template literal interpolation
  // The public API paths come directly from the OpenAPI spec (e.g., /api/v1/agents/{agent})
  // The app is identified by the API key header, not by the URL.
  let path = op.path;
  path = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `\${${camelCase(name)}}`;
  });

  return `\`${path}\``;
}

function buildRequestOptions(op: OperationDef): string | null {
  const parts: string[] = [];

  if (op.method !== "GET") {
    parts.push(`method: "${op.method}"`);
  }

  if (op.body) {
    parts.push("body: input");
  }

  if (op.queryParams.length > 0) {
    // Cast must match HttpClient.request's `query` type
    // (Record<string, QueryValue>, where QueryValue allows primitive arrays).
    // A scalars-only cast would silently drop array-typed filters like
    // `kind?: string[]` at the boundary.
    parts.push(
      "query: params as Record<string, string | number | boolean | Array<string | number | boolean> | undefined>"
    );
  }

  if (parts.length === 0) return null;
  return `{ ${parts.join(", ")} }`;
}

/**
 * Convert TypeRef to TypeScript type string.
 */
export function typeRefToTS(ref: TypeRef): string {
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

    case "array":
      return `${typeRefToTS(ref.items)}[]`;

    case "object": {
      if (ref.fields.length === 0) return "Record<string, unknown>";
      const fields = ref.fields
        .map((f) => {
          const opt = f.required ? "" : "?";
          return `${f.name}${opt}: ${typeRefToTS(f.type)}`;
        })
        .join("; ");
      return `{ ${fields} }`;
    }

    case "ref":
      return ref.schema;

    case "enum":
      return ref.values.map((v) => `"${v}"`).join(" | ");

    case "union":
      return ref.variants.map(typeRefToTS).join(" | ");

    case "optional":
      return `${typeRefToTS(ref.inner)} | undefined`;

    case "map":
      return `Record<string, ${typeRefToTS(ref.valueType)}>`;

    case "unknown":
      return "unknown";

    case "void":
      return "void";
  }
}

/** Collect all schema ref names used in return types and request bodies. */
function collectSchemaRefs(resources: ResourceDef[]): Set<string> {
  const refs = new Set<string>();
  for (const resource of resources) {
    for (const op of resource.operations) {
      collectTypeRefs(op.returnType, refs);
      if (op.body) {
        if (op.body.fields && op.body.fields.length > 0) {
          for (const f of op.body.fields) collectTypeRefs(f.type, refs);
        } else if (op.body.schema && op.body.schema !== "inline") {
          refs.add(op.body.schema);
        }
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
