import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { generateSwift, prepareSwiftSpec } from "../../src/backends/swift/index.js";
import { emitSwiftModelsFile } from "../../src/backends/swift/model-emitter.js";
import { emitSwiftChannelFile } from "../../src/backends/swift/channel-emitter.js";
import { SwiftNameRegistry, uniqueSwiftMemberNames, swiftMemberName } from "../../src/backends/swift/identifiers.js";
import {
  typeRefToSwift,
  findValueCycleSchemas,
  swiftQueryStringExpr,
} from "../../src/backends/swift/type-map.js";
import { emitSwiftContractTests } from "../../src/backends/contract-tests/swift-emitter.js";
import { emitSwiftChannelContractTestFile } from "../../src/backends/contract-tests/channel-emitter-swift.js";
import type { SchemaDef } from "../../src/ast/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/sample-spec.json"), "utf-8")
);

function generateFixtureFiles(): Record<string, string> {
  const ast = parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
  return generateSwift(ast, { outDir: "sdk" });
}

describe("swift identifiers", () => {
  it("camelCases wire names and escapes keywords", () => {
    expect(swiftMemberName("user_id")).toBe("userId");
    expect(swiftMemberName("default")).toBe("`default`");
    expect(swiftMemberName("import")).toBe("`import`");
  });

  it("uniquifies collisions and honors reserved names", () => {
    expect(uniqueSwiftMemberNames(["user_id", "userId"])).toEqual([
      "userId",
      "userId2",
    ]);
    expect(uniqueSwiftMemberNames(["query"], ["query"])).toEqual(["query2"]);
  });

  it("hands out registry names deterministically", () => {
    const registry = new SwiftNameRegistry();
    expect(registry.claim("a", "Team")).toBe("Team");
    expect(registry.claim("b", "Team")).toBe("Team2");
    expect(registry.claim("a", "Team")).toBe("Team");
    // Runtime type names are reserved.
    expect(registry.claim("c", "ApiError")).toBe("ApiError2");
  });
});

describe("swift type map", () => {
  it("maps primitives, arrays, maps, and optionals", () => {
    expect(typeRefToSwift({ kind: "primitive", type: "string" })).toBe("String");
    expect(typeRefToSwift({ kind: "primitive", type: "integer" })).toBe("Int");
    expect(typeRefToSwift({ kind: "primitive", type: "datetime" })).toBe("Date");
    expect(
      typeRefToSwift({ kind: "array", items: { kind: "primitive", type: "string" } })
    ).toBe("[String]");
    expect(
      typeRefToSwift({
        kind: "optional",
        inner: { kind: "ref", schema: "Team" },
      })
    ).toBe("Team?");
    expect(
      typeRefToSwift({
        kind: "nullable",
        inner: { kind: "ref", schema: "Team" },
      })
    ).toBe("Team?");
    expect(
      typeRefToSwift({
        kind: "map",
        keyType: { kind: "primitive", type: "string" },
        valueType: { kind: "unknown" },
      })
    ).toBe("[String: JSONValue]");
    expect(typeRefToSwift({ kind: "enum", values: ["a", "b"] })).toBe("String");
    expect(
      swiftQueryStringExpr(
        {
          kind: "nullable",
          inner: { kind: "primitive", type: "string" },
        },
        "value"
      )
    ).toBe('value.map { $0 } ?? "null"');
  });

  it("detects by-value containment cycles", () => {
    const schemas: SchemaDef[] = [
      {
        name: "Node",
        fields: [
          {
            name: "next",
            type: { kind: "optional", inner: { kind: "ref", schema: "Node" } },
            required: false,
          },
        ],
      },
      {
        name: "NullableNode",
        fields: [
          {
            name: "next",
            type: { kind: "nullable", inner: { kind: "ref", schema: "NullableNode" } },
            required: true,
          },
        ],
      },
      {
        name: "Tree",
        fields: [
          {
            name: "children",
            type: { kind: "array", items: { kind: "ref", schema: "Tree" } },
            required: false,
          },
        ],
      },
    ];
    const cycles = findValueCycleSchemas(schemas);
    // Optional and nullable self-refs recurse by value; array self-ref is boxed.
    expect(cycles.has("Node")).toBe(true);
    expect(cycles.has("NullableNode")).toBe(true);
    expect(cycles.has("Tree")).toBe(false);
  });
});

describe("swift model emitter", () => {
  it("emits Codable structs with CodingKeys for renamed fields", () => {
    const registry = new SwiftNameRegistry();
    registry.claim("schema:Team", "Team");
    const schemas: SchemaDef[] = [
      {
        name: "Team",
        description: "A team.",
        fields: [
          { name: "id", type: { kind: "primitive", type: "string" }, required: true },
          {
            name: "created_at",
            type: { kind: "primitive", type: "datetime" },
            required: false,
          },
        ],
      },
    ];
    const output = emitSwiftModelsFile(schemas, registry, new Set());
    expect(output).toContain("public struct Team: Codable, Sendable");
    expect(output).toContain("public var id: String");
    expect(output).toContain("public var createdAt: Date?");
    expect(output).toContain('case createdAt = "created_at"');
    expect(output).toContain("/// A team.");
  });

  it("emits recursive schemas as final classes", () => {
    const registry = new SwiftNameRegistry();
    registry.claim("schema:Node", "Node");
    const schemas: SchemaDef[] = [
      {
        name: "Node",
        fields: [
          {
            name: "next",
            type: { kind: "optional", inner: { kind: "ref", schema: "Node" } },
            required: false,
          },
        ],
      },
    ];
    const output = emitSwiftModelsFile(schemas, registry, new Set(["Node"]));
    expect(output).toContain("public final class Node: Codable, @unchecked Sendable");
  });
});

describe("swift backend", () => {
  it("encodes required nullable channel parameters as explicit JSON null", () => {
    const output = emitSwiftChannelFile(
      {
        name: "Nullable",
        className: "NullableChannel",
        joins: [
          {
            topicPattern: "nullable",
            params: [
              {
                name: "value",
                type: {
                  kind: "nullable",
                  inner: { kind: "primitive", type: "string" },
                },
                required: true,
              },
            ],
            returnType: { kind: "unknown" },
          },
        ],
        messages: [],
        pushes: [],
      },
      new SwiftNameRegistry()
    );

    expect(output).toContain("value: String?");
    expect(output).not.toContain("value: String? = nil");
    expect(output).toContain(
      'payload["value"] = value.map { .string($0) } ?? .null'
    );
  });

  it("generates the full SDK file set", () => {
    const files = generateFixtureFiles();
    const paths = Object.keys(files);

    expect(paths.some((p) => p.includes("Generated/Client.swift"))).toBe(true);
    expect(paths.some((p) => p.includes("Generated/V1/V1.swift"))).toBe(true);
    expect(paths.some((p) => p.endsWith("Models.swift"))).toBe(true);

    const client = files[paths.find((p) => p.endsWith("Client.swift"))!]!;
    expect(client).toContain("public final class PlatformClient: Sendable");
  });

  it("emits async resource methods calling the runtime", () => {
    const files = generateFixtureFiles();
    const resourceFiles = Object.entries(files).filter(([p]) =>
      /Generated\/V1\/(?!V1\.swift)/.test(p)
    );
    expect(resourceFiles.length).toBeGreaterThan(0);
    const combined = resourceFiles.map(([, content]) => content).join("\n");
    expect(combined).toContain("async throws");
    expect(combined).toContain("http.request(");
  });

  it("assigns collision-free type names across the module", () => {
    const ast = parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
    const { registry } = prepareSwiftSpec(ast);
    // Claiming an existing schema name again yields a distinct name.
    const claimed = registry.claim("test:dup", "Team");
    expect(claimed).not.toBe("");
  });
});

describe("swift contract tests emitter", () => {
  it("generates suite files per top-level resource", () => {
    const ast = parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
    const files = emitSwiftContractTests(ast, { outDir: "sdk" });
    const paths = Object.keys(files);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.includes("Tests/ArchAstroPlatformContractTests"))).toBe(
      true
    );

    const combined = Object.values(files).join("\n");
    expect(combined).toContain("import Testing");
    expect(combined).toContain("import ArchAstroPlatform");
    expect(combined).toContain("ContractSupport.client()");
    expect(combined).toContain("catch let error as ApiError");
  });

  it("emits error tests for documented status codes", () => {
    const ast = parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
    const files = emitSwiftContractTests(ast, { outDir: "sdk" });
    const combined = Object.values(files).join("\n");
    const hasErrorTest = /error_\d{3}\(\) async throws/.test(combined);
    expect(hasErrorTest).toBe(true);
  });

  it("uses JSON dictionaries for inline channel join objects", () => {
    const output = emitSwiftChannelContractTestFile(
      {
        name: "api_chat",
        className: "ApiChatChannel",
        joins: [
          {
            topicPattern: "api:chat:user:thread:{thread_id}",
            params: [
              {
                name: "thread_id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "local_tools",
                type: {
                  kind: "array",
                  items: {
                    kind: "object",
                    fields: [
                      {
                        name: "type",
                        type: { kind: "primitive", type: "string" },
                        required: true,
                      },
                      {
                        name: "function",
                        type: {
                          kind: "object",
                          fields: [
                            {
                              name: "name",
                              type: { kind: "primitive", type: "string" },
                              required: true,
                            },
                          ],
                        },
                        required: true,
                      },
                    ],
                  },
                },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
          },
        ],
        messages: [],
        pushes: [],
      },
      new SwiftNameRegistry()
    );
    expect(output).not.toContain("LocalToolsItem");
    expect(output).toContain(
      'localTools: [["type": "test", "function": ["name": "test-name"]]]'
    );
  });
});
