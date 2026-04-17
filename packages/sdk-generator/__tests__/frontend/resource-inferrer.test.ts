import { describe, it, expect } from "vitest";
import { inferResourceTree } from "../../src/frontend/resource-inferrer.js";
import type { ParsedOperation } from "../../src/frontend/operation-parser.js";

/** Helper to build a minimal ParsedOperation. */
function op(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  operationId?: string
): ParsedOperation {
  return {
    operationId: operationId ?? `${method.toLowerCase()}_${path.replace(/[/{}]/g, "_")}`,
    method,
    path,
    deprecated: false,
    pathParams: [],
    queryParams: [],
    returnType: { kind: "unknown" },
    errors: [],
  };
}

/**
 * Collect every className in the resource tree (including nested children).
 */
function allClassNames(resources: { className: string; children: any[] }[]): string[] {
  const names: string[] = [];
  for (const r of resources) {
    names.push(r.className);
    names.push(...allClassNames(r.children));
  }
  return names;
}

/** Deterministic shuffle using a simple seed. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i]!, result[j]!] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Build a collection resource: GET (list) + POST (create) so that action
 * detection does not fold them into the parent resource.
 */
function collection(path: string, prefix?: string): ParsedOperation[] {
  const id = (prefix ? prefix + "_" : "") + path.replace(/[/{}]/g, "_");
  return [
    op("GET", path, `list_${id}`),
    op("POST", path, `create_${id}`),
  ];
}

describe("inferResourceTree – class name disambiguation", () => {
  const allOps: ParsedOperation[] = [
    ...collection("/agents"),
    op("GET", "/agents/{agent}", "get_agent"),
    ...collection("/agents/{agent}/agent_installations", "nested"),
    ...collection("/agent_installations"),
    op("GET", "/agent_installations/{installation}", "get_agent_installation"),
    op("DELETE", "/agent_installations/{installation}", "delete_agent_installation"),
  ];

  it("top-level resource gets simple name, nested gets prefixed name", () => {
    const { resources } = inferResourceTree(allOps);
    const names = allClassNames(resources);

    expect(names).toContain("AgentInstallationResource");
    expect(names).toContain("AgentAgentInstallationResource");

    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("produces identical classNames regardless of operation order", () => {
    const baseline = allClassNames(inferResourceTree(allOps).resources).sort();

    for (let seed = 1; seed <= 10; seed++) {
      const shuffled = seededShuffle(allOps, seed);
      const names = allClassNames(inferResourceTree(shuffled).resources).sort();
      expect(names).toEqual(baseline);
    }
  });

  it("does not leak prefix segments into disambiguated class names", () => {
    // Without apiPrefix configured, paths keep /api/v1/... segments.
    // Disambiguation should only walk back to the immediate parent,
    // not include api or v1 in the class name.
    const operations: ParsedOperation[] = [
      ...collection("/api/v1/agents"),
      op("GET", "/api/v1/agents/{agent}", "get_agent"),
      ...collection("/api/v1/agents/{agent}/agent_installations", "nested"),
      ...collection("/api/v1/agent_installations"),
      op("GET", "/api/v1/agent_installations/{id}", "get_inst"),
    ];

    const { resources } = inferResourceTree(operations);
    const names = allClassNames(resources);

    expect(names).toContain("AgentAgentInstallationResource");
    expect(names).not.toContain("ApiV1AgentAgentInstallationResource");
    expect(names).not.toContain("V1AgentAgentInstallationResource");

    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("walks back through multiple ancestors when one parent is not enough", () => {
    // /items, /foo/{f}/items, /bar/{b}/items — all share terminal "items"
    const operations: ParsedOperation[] = [
      ...collection("/items"),
      ...collection("/foo/{f}/items", "foo"),
      ...collection("/foo"),
      ...collection("/bar/{b}/items", "bar"),
      ...collection("/bar"),
    ];

    const { resources } = inferResourceTree(operations);
    const names = allClassNames(resources);

    expect(names).toContain("ItemResource");
    expect(names).toContain("FooItemResource");
    expect(names).toContain("BarItemResource");

    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("walks back further when immediate parent still collides", () => {
    // /a/{x}/sub/{y}/items and /b/{x}/sub/{y}/items both have parent "sub".
    // The first nested one claims SubItemResource. The second collides with
    // that and walks back one more level to get BSubItemResource.
    const operations: ParsedOperation[] = [
      ...collection("/items"),
      ...collection("/a/{x}/sub/{y}/items", "a_sub"),
      ...collection("/a/{x}/sub", "a"),
      ...collection("/a"),
      ...collection("/b/{x}/sub/{y}/items", "b_sub"),
      ...collection("/b/{x}/sub", "b"),
      ...collection("/b"),
    ];

    const { resources } = inferResourceTree(operations);
    const names = allClassNames(resources);

    expect(names).toContain("ItemResource");
    // First nested claims SubItemResource, second needs one more ancestor
    expect(names).toContain("SubItemResource");
    expect(names).toContain("BSubItemResource");

    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("does not break when there is no collision", () => {
    const operations: ParsedOperation[] = [
      ...collection("/teams"),
      op("GET", "/teams/{team}", "get_team"),
      ...collection("/agents"),
      op("GET", "/agents/{agent}", "get_agent"),
    ];

    const { resources } = inferResourceTree(operations);
    const names = allClassNames(resources);

    expect(names).toContain("TeamResource");
    expect(names).toContain("AgentResource");
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
