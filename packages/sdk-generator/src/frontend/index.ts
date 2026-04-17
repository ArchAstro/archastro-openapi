import type { SdkSpec, SchemaDef, ResourceDef, AuthConfig, AuthScheme, TokenFlow, VersionedResourceSet } from "../ast/types.js";
import type { FrontendConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";
import { parseSchemas } from "./schema-parser.js";
import { parseOperations } from "./operation-parser.js";
import { inferResourceTree } from "./resource-inferrer.js";
import { parseChannels } from "./channel-parser.js";

// ─── OpenAPI spec shape (top level) ─────────────────────────────

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  "x-channels"?: unknown[];
  "x-auth-schemes"?: Record<string, AuthScheme>;
  "x-token-flows"?: Record<string, TokenFlow>;
  "x-channel-auth"?: string[];
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse an OpenAPI 3.0 spec (with x-channels extension) into an SDK AST.
 *
 * This is the main entry point for the SDK generator frontend.
 *
 * @param spec  - Parsed OpenAPI JSON object
 * @param config - SDK generator configuration
 * @returns Complete SdkSpec AST
 */
export function parseOpenApiSpec(
  spec: OpenApiSpec,
  config: Partial<FrontendConfig> = {}
): SdkSpec {
  const cfg: FrontendConfig = {
    name: config.name ?? DEFAULT_CONFIG.name!,
    version: config.version ?? DEFAULT_CONFIG.version!,
    baseUrl: config.baseUrl ?? DEFAULT_CONFIG.baseUrl!,
    apiPrefix: config.apiPrefix ?? DEFAULT_CONFIG.apiPrefix!,
    apiBase: config.apiBase,
    defaultVersion: config.defaultVersion ?? DEFAULT_CONFIG.defaultVersion!,
    description: config.description,
    scopePrefix: config.scopePrefix,
    operationOverrides: config.operationOverrides,
    resourceOverrides: config.resourceOverrides,
    ignorePaths: config.ignorePaths,
  };

  // 1. Parse schemas and types from components
  const { schemas, types } = parseSchemas(
    (spec.components ?? {}) as Parameters<typeof parseSchemas>[0]
  );

  // 2. Parse operations from paths
  let operations = parseOperations(spec as never);

  // 3. Filter out ignored paths
  if (cfg.ignorePaths) {
    operations = operations.filter(
      (op) =>
        !cfg.ignorePaths!.some((pattern) => matchGlob(pattern, op.path))
    );
  }

  // 4. Extract auth-tagged operations before resource inference
  const authOps = operations.filter((op) => op.tags?.includes("auth"));
  const nonAuthOps = operations.filter((op) => !op.tags?.includes("auth"));

  // 5. Build versioned resource sets
  let versions: VersionedResourceSet[];
  let apiBase: string;
  let defaultVersion: string;

  if (cfg.apiBase) {
    // Multi-version mode: detect versions from path prefixes
    apiBase = cfg.apiBase;
    defaultVersion = cfg.defaultVersion!;

    const versionGroups = detectVersions(
      nonAuthOps.map((op) => op.path),
      apiBase
    );

    // If no versions detected, treat all ops as default version
    if (versionGroups.size === 0) {
      const { resources } = inferResourceTree(nonAuthOps, {
        apiPrefix: apiBase,
        scopePrefix: cfg.scopePrefix,
        operationOverrides: cfg.operationOverrides,
        resourceOverrides: cfg.resourceOverrides,
      });
      versions = [{ version: defaultVersion, apiPrefix: apiBase, resources }];
    } else {
      versions = [];
      // Sort versions so v1 < v2 < v10
      const sortedVersions = [...versionGroups.keys()].sort((a, b) => {
        const numA = parseInt(a.replace(/^v/, ""), 10);
        const numB = parseInt(b.replace(/^v/, ""), 10);
        return numA - numB;
      });

      for (const ver of sortedVersions) {
        const verPrefix = `${apiBase}/${ver}`;
        const verPaths = new Set(versionGroups.get(ver)!);
        const verOps = nonAuthOps.filter((op) => verPaths.has(op.path));

        const { resources } = inferResourceTree(verOps, {
          apiPrefix: verPrefix,
          scopePrefix: cfg.scopePrefix,
          operationOverrides: cfg.operationOverrides,
          resourceOverrides: cfg.resourceOverrides,
        });

        versions.push({ version: ver, apiPrefix: verPrefix, resources });
      }
    }
  } else {
    // Legacy single-version mode: use apiPrefix directly
    const prefix = cfg.apiPrefix ?? "";
    apiBase = prefix;
    defaultVersion = cfg.defaultVersion!;

    const { resources } = inferResourceTree(nonAuthOps, {
      apiPrefix: prefix,
      scopePrefix: cfg.scopePrefix,
      operationOverrides: cfg.operationOverrides,
      resourceOverrides: cfg.resourceOverrides,
    });

    versions = [{ version: defaultVersion, apiPrefix: prefix, resources }];
  }

  // Find the default version's resource set for backward compat fields
  const defaultVersionSet =
    versions.find((v) => v.version === defaultVersion) ?? versions[0]!;

  // 6. Parse channels
  const channels = parseChannels(
    spec["x-channels"] as Parameters<typeof parseChannels>[0]
  );

  // 7. Parse auth from x-auth-schemes and x-token-flows
  const auth: AuthConfig = {
    schemes: spec["x-auth-schemes"] ?? {},
    tokenFlows: spec["x-token-flows"] ?? {},
    channelAuth: spec["x-channel-auth"] ?? [],
  };

  // Convert auth ParsedOperations to OperationDefs
  const authOperations: import("../ast/types.js").OperationDef[] = authOps.map((op) => ({
    name: op.operationId,
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated,
    pathParams: op.pathParams,
    queryParams: op.queryParams,
    body: op.bodySchemaRef
      ? { schema: op.bodySchemaRef, contentType: "application/json" }
      : op.bodyFields
        ? { schema: "inline", contentType: "application/json", fields: op.bodyFields }
        : undefined,
    returnType: op.returnType,
    errors: op.errors,
    rawResponse: op.rawResponse,
    auth: op.auth,
    sdkName: op.sdkName,
    tags: op.tags,
  }));

  // 8. Group schemas by resource and break circular imports
  const schemaGroups = groupSchemasByResource(schemas, versions);

  return {
    name: cfg.name,
    version: cfg.version,
    description: cfg.description ?? spec.info.description,
    baseUrl: cfg.baseUrl,
    apiBase,
    defaultVersion,
    versions,
    // Backward compat: flat fields from the default version
    apiPrefix: defaultVersionSet.apiPrefix,
    auth,
    types,
    schemas,
    schemaGroups,
    resources: defaultVersionSet.resources,
    authOperations,
    channels,
  };
}

// ─── Version Detection ──────────────────────────────────────────

/**
 * Detect API versions from operation paths.
 *
 * Scans paths for the pattern `{apiBase}/v{N}/…` and groups them by version.
 * Returns a Map from version string (e.g., "v1") to the set of matching paths.
 */
export function detectVersions(
  paths: string[],
  apiBase: string
): Map<string, string[]> {
  const escaped = apiBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionPattern = new RegExp(`^${escaped}/(v\\d+)/`);
  const groups = new Map<string, string[]>();

  for (const path of paths) {
    const match = path.match(versionPattern);
    if (match) {
      const version = match[1]!;
      const existing = groups.get(version) ?? [];
      existing.push(path);
      groups.set(version, existing);
    }
  }

  return groups;
}

// Re-export sub-modules for direct use
export { parseSchemas, jsonSchemaToTypeRef } from "./schema-parser.js";
export { parseOperations } from "./operation-parser.js";
export type { ParsedOperation } from "./operation-parser.js";
export { inferResourceTree } from "./resource-inferrer.js";
export { parseChannels } from "./channel-parser.js";
export type { FrontendConfig } from "./config.js";

// ─── Internal ────────────────────────────────────────────────────

/**
 * Simple glob matching — supports trailing `*` and `**`.
 */
function matchGlob(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**") || pattern.endsWith("/*")) {
    const prefix = pattern.replace(/\/\*\*?$/, "");
    return path.startsWith(prefix);
  }
  return path === pattern;
}

// ─── Schema Grouping ────────────────────────────────────────────

/**
 * Group schemas by their closest matching API resource, then break any
 * circular import cycles between groups. Schemas that don't match any
 * resource go into the "common" group.
 *
 * This is used by all backends (TypeScript, Python, etc.) to decide which
 * file each schema goes into.
 */
function groupSchemasByResource(
  schemas: SchemaDef[],
  versions: VersionedResourceSet[]
): Record<string, SchemaDef[]> {
  const allResources = versions.flatMap((v) => flattenResources(v.resources));
  const resourceNames = new Set(allResources.map((r) => r.name));

  const groups: Record<string, SchemaDef[]> = {};
  for (const schema of schemas) {
    const group = findMatchingResource(schema.name, resourceNames) ?? "common";
    (groups[group] ??= []).push(schema);
  }

  breakCircularImports(groups);
  return groups;
}

function findMatchingResource(
  schemaName: string,
  resourceNames: Set<string>
): string | undefined {
  const lower = schemaName.toLowerCase();
  for (const name of resourceNames) {
    const singular = name.endsWith("s") ? name.slice(0, -1) : name;
    if (lower.startsWith(singular)) return name;
  }
  return undefined;
}

function flattenResources(resources: ResourceDef[]): ResourceDef[] {
  const result: ResourceDef[] = [];
  for (const r of resources) {
    result.push(r);
    result.push(...flattenResources(r.children));
  }
  return result;
}

/**
 * Detect cross-file circular imports and break them by merging groups.
 *
 * Python cannot handle circular imports between modules when imported names
 * are used at class-definition time (Pydantic models). TypeScript handles
 * them fine, but consistent grouping across backends prevents surprises.
 *
 * Strategy: build a file-level dep graph, find cycles, merge the smaller
 * group into the larger one, re-sort, repeat until acyclic.
 */
function breakCircularImports(groups: Record<string, SchemaDef[]>): void {
  let changed = true;
  while (changed) {
    changed = false;

    const schemaToGroup: Record<string, string> = {};
    for (const [groupName, schemas] of Object.entries(groups)) {
      for (const s of schemas) schemaToGroup[s.name] = groupName;
    }

    const fileDeps = new Map<string, Set<string>>();
    for (const [groupName, schemas] of Object.entries(groups)) {
      for (const schema of schemas) {
        for (const dep of schema.refDeps ?? []) {
          const depGroup = schemaToGroup[dep];
          if (depGroup && depGroup !== groupName) {
            let deps = fileDeps.get(groupName);
            if (!deps) { deps = new Set(); fileDeps.set(groupName, deps); }
            deps.add(depGroup);
          }
        }
      }
    }

    for (const [fileA, depsA] of fileDeps) {
      for (const fileB of depsA) {
        if (fileDeps.get(fileB)?.has(fileA)) {
          const countA = groups[fileA]?.length ?? 0;
          const countB = groups[fileB]?.length ?? 0;
          const [source, target] = countA <= countB ? [fileA, fileB] : [fileB, fileA];

          const merged = [...(groups[target] ?? []), ...(groups[source] ?? [])];
          groups[target] = topoSortSchemas(merged);
          delete groups[source];
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
}

function topoSortSchemas(schemas: SchemaDef[]): SchemaDef[] {
  const nameSet = new Set(schemas.map((s) => s.name));
  const byName = new Map(schemas.map((s) => [s.name, s]));
  const deps = new Map(
    schemas.map((s) => [
      s.name,
      new Set((s.refDeps ?? []).filter((d) => nameSet.has(d))),
    ])
  );

  const sorted: SchemaDef[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) return;
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    visiting.delete(name);
    visited.add(name);
    sorted.push(byName.get(name)!);
  }

  for (const schema of schemas) visit(schema.name);
  return sorted;
}
