import type {
  ResourceDef,
  OperationDef,
  ParamDef,
  BodyDef,
  TypeRef,
  PaginationConfig,
  StreamingConfig,
} from "../ast/types.js";
import type { ParsedOperation } from "./operation-parser.js";
import { camelCase, pascalCase, singularize } from "../utils/naming.js";

interface InferConfig {
  /** Path prefix to strip (e.g., "/protected/api/v1/developer") */
  apiPrefix?: string;
  /** Scope prefix after apiPrefix (e.g., "/apps/{app_id}") — params become scope params */
  scopePrefix?: string;
  /** Override operation names by operationId */
  operationOverrides?: Record<string, { name?: string; parent?: string }>;
  /** Override resource grouping */
  resourceOverrides?: Record<string, { parent?: string; name?: string }>;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Infer a nested resource tree from a flat list of parsed operations.
 *
 * 1. Strip apiPrefix and scopePrefix from paths
 * 2. Group operations by their resource path segments
 * 3. Build a tree of ResourceDef nodes
 * 4. Detect scope params from the prefix
 */
export function inferResourceTree(
  operations: ParsedOperation[],
  config: InferConfig = {}
): { resources: ResourceDef[]; scopeParams: ParamDef[] } {
  const apiPrefix = config.apiPrefix ?? "";
  const scopePrefix = config.scopePrefix ?? "";
  const fullPrefix = apiPrefix + scopePrefix;

  // Extract scope params from the prefix pattern
  const scopeParams = extractParamsFromPattern(scopePrefix);

  // Filter out auth-tagged operations — they're handled by the auth emitter
  const nonAuthOps = operations.filter(
    (op) => !op.tags?.includes("auth")
  );

  // First pass: collect all relative paths and their methods to detect actions
  const opsWithRelPaths: OperationWithRelPath[] = [];
  for (const op of nonAuthOps) {
    let relPath = op.path;
    if (fullPrefix && relPath.startsWith(fullPrefix)) {
      relPath = relPath.slice(fullPrefix.length);
    }
    if (!relPath.startsWith("/")) relPath = "/" + relPath;
    opsWithRelPaths.push({ ...op, relativePath: relPath });
  }

  // Detect action endpoints: paths where the last non-param segment only has POST
  // e.g., /agent_skills/{id}/deactivate (POST only) → action on parent, not child resource
  const actionPaths = detectActionPaths(opsWithRelPaths);

  // Group operations by their resource path (after stripping prefix)
  const groups = new Map<string, OperationWithRelPath[]>();

  for (const op of opsWithRelPaths) {
    const resourcePath = getResourcePath(op.relativePath, actionPaths);
    const existing = groups.get(resourcePath) ?? [];
    existing.push(op);
    groups.set(resourcePath, existing);
  }

  // Build flat resource map.
  // When two paths resolve to the same terminal name under the same parent
  // (e.g., /routines/{id}/runs and /routines/runs/{run}), merge their
  // operations into one resource. Different parents are kept separate.
  const resourceMap = new Map<string, ResourceDef>();
  // Key: "parentNonParamPath:name" → first resourcePath for that combo
  const mergeKey = new Map<string, string>();

  const usedClassNames = new Set<string>();

  // Process groups in deterministic order: shorter paths first (by segment
  // count), then alphabetically. This ensures top-level resources always
  // claim the simple class name before nested resources with the same
  // terminal segment, regardless of the order paths appear in the spec.
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aDepth = a[0].split("/").filter(Boolean).length;
    const bDepth = b[0].split("/").filter(Boolean).length;
    return aDepth - bDepth || a[0].localeCompare(b[0]);
  });

  for (const [resourcePath, ops] of sortedGroups) {
    const segments = resourcePath.split("/").filter(Boolean);
    const name = segments[segments.length - 1] ?? "root";
    let className = pascalCase(singularize(name)) + "Resource";

    // Disambiguate class names by walking backwards through ancestor
    // non-param segments, prepending one at a time until the name is
    // unique. This avoids leaking prefix segments (api, v1) into names
    // — we only go as far back as needed to resolve the collision.
    if (usedClassNames.has(className)) {
      const nonParamAncestors = segments
        .filter((s) => !isParamSegment(s))
        .slice(0, -1); // everything except the terminal segment
      for (let i = nonParamAncestors.length - 1; i >= 0; i--) {
        className = pascalCase(singularize(nonParamAncestors[i]!)) + className;
        if (!usedClassNames.has(className)) break;
      }
    }
    usedClassNames.add(className);

    // Collect path params that appear in the resource path itself (between segments)
    const resourcePathParams = extractParamsFromPattern(resourcePath);

    const allScopeParams = [...scopeParams, ...resourcePathParams].filter(
      (p, i, arr) => i === arr.findIndex((q) => q.name === p.name)
    );

    const operationDefs = ops.map((op) =>
      toOperationDef(op, resourcePath, allScopeParams, config)
    );

    // Build merge key: non-param ancestor segments + terminal name
    // e.g., /routines/{id}/runs → "routines:runs"
    // e.g., /routines/runs/{run} → "routines:runs"
    // e.g., /teams/{team}/members → "teams:members"
    // e.g., /threads/{thread}/members → "threads:members" (different!)
    const nonParamSegments = segments.filter((s) => !isParamSegment(s));
    const mk = nonParamSegments.join(":");

    // If a resource with the same merge key exists, merge operations
    const existingPath = mergeKey.get(mk);
    if (existingPath && resourceMap.has(existingPath)) {
      const existing = resourceMap.get(existingPath)!;
      existing.operations.push(...operationDefs);
      for (const sp of allScopeParams) {
        if (!existing.scopeParams.some((p) => p.name === sp.name)) {
          existing.scopeParams.push(sp);
        }
      }
      resourceMap.set(resourcePath, existing);
      continue;
    }

    const resource: ResourceDef = {
      name,
      className: applyResourceOverrides(name, className, config),
      path: resourcePath,
      scopeParams: allScopeParams,
      operations: operationDefs,
      children: [],
    };

    resourceMap.set(resourcePath, resource);
    mergeKey.set(mk, resourcePath);
  }

  // Build tree by nesting children under parents.
  // Track which resources have been placed to avoid duplicates from merged paths.
  const roots: ResourceDef[] = [];
  const placed = new Set<ResourceDef>();

  // Sort paths so parents come before children
  const sortedPaths = [...resourceMap.keys()].sort(
    (a, b) => a.split("/").length - b.split("/").length
  );

  for (const path of sortedPaths) {
    const resource = resourceMap.get(path)!;
    if (placed.has(resource)) continue;
    placed.add(resource);

    const parentPath = getParentResourcePath(path);

    if (parentPath && resourceMap.has(parentPath)) {
      const parent = resourceMap.get(parentPath)!;
      if (!parent.children.includes(resource)) {
        parent.children.push(resource);
      }
    } else if (parentPath) {
      // Parent path doesn't exist in the map — create intermediate empty
      // resources up the chain so the tree mirrors the URL hierarchy.
      // e.g., /ai/chat/models creates empty /ai and /ai/chat parents.
      ensureParentChain(parentPath, resource, resourceMap, roots, placed);
    } else {
      roots.push(resource);
    }
  }

  // Post-process: if a child resource name collides with an operation name
  // on the parent, prefix the child with the parent name.
  // e.g., teams has operation "join" AND child "join" → child becomes "team_join"
  resolveChildOperationCollisions(roots);

  return { resources: roots, scopeParams };
}

function resolveChildOperationCollisions(resources: ResourceDef[]): void {
  for (const resource of resources) {
    const opNames = new Set(resource.operations.map((o) => o.name));

    for (const child of resource.children) {
      if (opNames.has(child.name)) {
        const parentSingular = resource.name.endsWith("s")
          ? resource.name.slice(0, -1)
          : resource.name;
        child.name = `${parentSingular}_${child.name}`;
        child.className =
          pascalCase(parentSingular) +
          pascalCase(singularize(child.name.split("_").pop()!)) +
          "Resource";
      }
    }

    resolveChildOperationCollisions(resource.children);
  }
}

/**
 * Create intermediate empty resources up the parent chain and attach
 * the child. Ensures /ai/chat/models produces the tree ai → chat → models.
 */
function ensureParentChain(
  parentPath: string,
  child: ResourceDef,
  resourceMap: Map<string, ResourceDef>,
  roots: ResourceDef[],
  placed: Set<ResourceDef>
): void {
  // Walk up creating missing parents until we find an existing one or hit root
  let current = parentPath;
  let currentChild = child;

  while (current) {
    if (resourceMap.has(current)) {
      // Found an existing parent — attach and stop
      const parent = resourceMap.get(current)!;
      if (!parent.children.includes(currentChild)) {
        parent.children.push(currentChild);
      }
      return;
    }

    // Create empty intermediate resource
    const segments = current.split("/").filter(Boolean);
    const name = segments[segments.length - 1] ?? "root";
    const intermediate: ResourceDef = {
      name,
      className: pascalCase(singularize(name)) + "Resource",
      path: current,
      scopeParams: [],
      operations: [],
      children: [currentChild],
    };
    resourceMap.set(current, intermediate);
    placed.add(intermediate);

    currentChild = intermediate;
    current = getParentResourcePath(current) ?? "";
    if (!current) break;
  }

  // No existing parent found — the top intermediate becomes a root
  roots.push(currentChild);
}

// ─── Internal ────────────────────────────────────────────────────

interface OperationWithRelPath extends ParsedOperation {
  relativePath: string;
}

/**
 * Detect action endpoints — leaf paths with no sub-resources beneath them.
 *
 * A path like `/agents/{id}/export` or `/agents/{id}/deactivate` is an action
 * when no other path extends beneath it (e.g., no `/export/{id}` or `/export/sub`).
 * Collections always have sub-paths; actions never do.
 *
 * This detection is HTTP-method-agnostic — both `GET /agents/{id}/export` and
 * `POST /agents/{id}/deactivate` are actions on the parent resource.
 */
function detectActionPaths(ops: OperationWithRelPath[]): Set<string> {
  // Collect all naive resource paths (terminal non-param segments)
  const allNaivePaths = new Set<string>();
  for (const op of ops) {
    allNaivePaths.add(getResourcePathNaive(op.relativePath));
  }

  // Group by naive path to count methods per path
  const pathMethods = new Map<string, Set<string>>();
  for (const op of ops) {
    const rp = getResourcePathNaive(op.relativePath);
    const methods = pathMethods.get(rp) ?? new Set();
    methods.add(op.method);
    pathMethods.set(rp, methods);
  }

  // Collect all raw relative paths to check for trailing param variants
  const allRelativePaths = new Set(ops.map((op) => op.relativePath));

  // A path is an action candidate if:
  // 1. It has at least 2 non-param segments (nested under something)
  // 2. It has exactly one HTTP method — actions are single-method endpoints,
  //    while collections have multiple (e.g., GET list + POST create)
  // 3. No raw relative path extends beneath it (e.g., /sessions/{id}),
  //    which would make it a collection, not an action
  const candidates = new Map<string, string[]>();
  for (const rp of allNaivePaths) {
    const segments = rp.split("/").filter(Boolean);
    if (segments.length < 2) continue;

    // Actions have a single HTTP method; collections have multiple
    const methods = pathMethods.get(rp);
    if (methods && methods.size > 1) continue;

    // Check if any raw path extends beneath this naive path,
    // e.g., /agents/{id}/sessions/{session_id} extends /agents/{id}/sessions.
    // This means the terminal segment is a collection, not an action.
    const isCollection = [...allRelativePaths].some(
      (raw) => raw !== rp && raw.startsWith(rp + "/")
    );
    if (isCollection) continue;

    const existing = candidates.get(rp) ?? [];
    existing.push(rp);
    candidates.set(rp, existing);
  }

  // When both scoped (/parent/{id}/action) and unscoped (/parent/action) exist
  // with the same action name under the same parent, only fold the scoped one.
  // The unscoped one stays as a child resource to avoid duplicate method names.
  const actionPaths = new Set<string>();
  for (const [rp] of candidates) {
    const segments = rp.split("/").filter(Boolean);
    const actionName = segments[segments.length - 1]!;
    const hasParamBeforeAction = segments.slice(0, -1).some(isParamSegment);

    // Check if there's a conflicting path (same action name, same parent, different scoping)
    const scopedExists = [...candidates.keys()].some(
      (other) => other !== rp &&
        other.split("/").filter(Boolean).pop() === actionName &&
        other.split("/").filter(Boolean).some(isParamSegment) !== hasParamBeforeAction
    );

    if (scopedExists && !hasParamBeforeAction) {
      // This is the unscoped variant and a scoped one exists — don't fold
      continue;
    }

    actionPaths.add(rp);
  }

  return actionPaths;
}

/** Get resource path without action folding (used for action detection). */
function getResourcePathNaive(path: string): string {
  const segments = path.split("/").filter(Boolean);
  while (segments.length > 0 && isParamSegment(segments[segments.length - 1]!)) {
    segments.pop();
  }
  return "/" + segments.join("/");
}

/**
 * Extract the resource path from a URL path by removing trailing param segments.
 * Action paths are folded into their parent resource.
 *
 * "/teams/{team_id}/members/{user_id}" → "/teams/{team_id}/members"
 * "/teams/{team_id}" → "/teams"
 * "/agent_skills/{id}/deactivate" → "/agent_skills" (action folded into parent)
 */
function getResourcePath(path: string, actionPaths: Set<string>): string {
  const segments = path.split("/").filter(Boolean);
  // Walk backwards, dropping param segments until we hit a non-param
  while (segments.length > 0 && isParamSegment(segments[segments.length - 1]!)) {
    segments.pop();
  }
  const naive = "/" + segments.join("/");

  // If this is an action path, fold into the parent resource
  if (actionPaths.has(naive)) {
    segments.pop(); // drop the action segment
    while (segments.length > 0 && isParamSegment(segments[segments.length - 1]!)) {
      segments.pop();
    }
    return "/" + segments.join("/");
  }

  return naive;
}

/**
 * Get the parent resource path.
 *
 * "/teams/{team_id}/members" → "/teams"
 * "/teams" → null
 */
function getParentResourcePath(resourcePath: string): string | null {
  const segments = resourcePath.split("/").filter(Boolean);
  if (segments.length <= 1) return null;

  // Walk backwards: drop last non-param segment and any params before the previous resource
  // "/teams/{team_id}/members" → segments = ["teams", "{team_id}", "members"]
  // Remove "members" → ["teams", "{team_id}"]
  // Remove "{team_id}" → ["teams"]
  // Result: "/teams"
  segments.pop(); // remove child resource name
  while (segments.length > 0 && isParamSegment(segments[segments.length - 1]!)) {
    segments.pop();
  }

  if (segments.length === 0) return null;
  return "/" + segments.join("/");
}

function isParamSegment(s: string): boolean {
  return s.startsWith("{") && s.endsWith("}");
}

/**
 * Extract param names from a path pattern like "/apps/{app_id}/teams/{team_id}".
 */
function extractParamsFromPattern(pattern: string): ParamDef[] {
  const matches = pattern.matchAll(/\{(\w+)\}/g);
  return [...matches].map(([, name]) => ({
    name: camelCase(name!),
    type: { kind: "primitive" as const, type: "string" as const },
    required: true,
  }));
}

/**
 * Map HTTP method + path shape to a conventional operation name.
 *
 * For action endpoints (/resource/{id}/action_name), uses the action
 * segment name (e.g., "deactivate", "invoke", "export") regardless of
 * HTTP method — instead of generic "create", "list", etc.
 */
function inferOperationName(
  method: string,
  relativePath: string,
  resourcePath: string,
  _config: InferConfig
): string {
  const segments = relativePath.split("/").filter(Boolean);
  const hasTrailingParam = segments.length > 0 && isParamSegment(segments[segments.length - 1]!);
  const isCollectionPath = relativePath === resourcePath || !hasTrailingParam;

  // Check if this is an action endpoint: the relative path extends beyond the
  // resource path with a non-param terminal segment (e.g., /agents/{id}/deactivate
  // where resourcePath is /agents, or /agents/{id}/export where resourcePath is /agents)
  const resourceSegments = resourcePath.split("/").filter(Boolean);
  const extraSegments = segments.slice(resourceSegments.length).filter((s) => !isParamSegment(s));
  if (extraSegments.length > 0) {
    // Use the action name: "deactivate", "invoke", "export", etc.
    return camelCase(extraSegments[extraSegments.length - 1]!);
  }

  switch (method) {
    case "GET":
      return isCollectionPath ? "list" : "get";
    case "POST":
      return isCollectionPath ? "create" : "create";
    case "PUT":
      return "replace";
    case "PATCH":
      return "update";
    case "DELETE":
      return isCollectionPath ? "remove" : "delete";
    default:
      return method.toLowerCase();
  }
}

function toOperationDef(
  op: OperationWithRelPath,
  resourcePath: string,
  scopeParams: ParamDef[],
  config: InferConfig
): OperationDef {
  // Check for operationId-based overrides
  const override = config.operationOverrides?.[op.operationId];
  const name =
    override?.name ??
    (op.sdkName
      ? camelCase(op.sdkName)
      : inferOperationName(op.method, op.relativePath, resourcePath, config));

  // Filter out scope params from pathParams (they're on the resource, not the operation)
  const scopeParamNames = new Set(scopeParams.map((p) => p.name));
  const pathParams = op.pathParams.filter(
    (p) => !scopeParamNames.has(camelCase(p.name))
  );

  // Build body def
  let body: BodyDef | undefined;
  if (op.bodySchemaRef) {
    body = {
      schema: op.bodySchemaRef,
      contentType: "application/json",
    };
  } else if (op.bodyFields && op.bodyFields.length > 0) {
    body = {
      schema: pascalCase(name) + "Input",
      contentType: "application/json",
      fields: op.bodyFields,
    };
  }

  // Detect pagination from response shape or hints
  let pagination: PaginationConfig | undefined;
  if (op.paginationHint) {
    pagination = { style: op.paginationHint.type };
  } else if (name === "list") {
    pagination = detectPaginationFromReturnType(op.returnType);
  }

  // Detect streaming
  let streaming: StreamingConfig | undefined;
  if (op.streamingHint) {
    streaming = { style: "sse", events: [] };
  }

  return {
    name,
    operationId: op.operationId,
    method: op.method,
    path: op.path,  // Use the full path from the OpenAPI spec, not the stripped relative path
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated,
    pathParams: pathParams.map((p) => ({ ...p, name: camelCase(p.name) })),
    queryParams: op.queryParams.map((p) => ({
      ...p,
      name: camelCase(p.name),
    })),
    body,
    returnType: op.returnType,
    errors: op.errors,
    pagination,
    streaming,
    rawResponse: op.rawResponse,
    auth: op.auth,
    tags: op.tags,
  };
}

function detectPaginationFromReturnType(
  returnType: TypeRef
): PaginationConfig | undefined {
  if (returnType.kind !== "object") return undefined;

  const fieldNames = new Set(returnType.fields.map((f) => f.name));

  // Offset pagination: has page, page_size, total_entries or similar
  if (fieldNames.has("page") && fieldNames.has("page_size")) {
    return { style: "offset" };
  }

  // Cursor pagination: has before_cursor / after_cursor
  if (fieldNames.has("before_cursor") || fieldNames.has("after_cursor")) {
    return { style: "cursor" };
  }

  return undefined;
}

function applyResourceOverrides(
  name: string,
  defaultClassName: string,
  config: InferConfig
): string {
  const override = config.resourceOverrides?.[name];
  if (override?.name) {
    return pascalCase(singularize(override.name)) + "Resource";
  }
  return defaultClassName;
}
