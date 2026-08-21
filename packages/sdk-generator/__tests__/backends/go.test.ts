import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { generateGo, prepareGoSpec } from "../../src/backends/go/index.js";
import { emitGoModelsFile } from "../../src/backends/go/model-emitter.js";
import { emitGoChannelFile } from "../../src/backends/go/channel-emitter.js";
import { emitGoResourceFile } from "../../src/backends/go/resource-emitter.js";
import { emitGoChannelContractTestFile } from "../../src/backends/contract-tests/channel-emitter-go.js";
import {
  GoNameRegistry,
  goExportedName,
  goFileStem,
  goUnexportedName,
  uniqueGoFieldNames,
  uniqueGoParamNames,
} from "../../src/backends/go/identifiers.js";
import {
  goFieldType,
  goJSONTag,
  goQueryStringExpr,
  typeRefToGo,
} from "../../src/backends/go/type-map.js";
import { emitGoContractTests } from "../../src/backends/contract-tests/go-emitter.js";
import type { SchemaDef } from "../../src/ast/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/sample-spec.json"), "utf-8")
);

function fixtureAst() {
  return parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
}

function generateFixtureFiles(): Record<string, string> {
  return generateGo(fixtureAst(), { outDir: "sdk" });
}

describe("go identifiers", () => {
  it("exports names with Go initialism casing", () => {
    expect(goExportedName("user_id")).toBe("UserID");
    expect(goExportedName("api_key")).toBe("APIKey");
    expect(goExportedName("created_at")).toBe("CreatedAt");
    expect(goExportedName("ApiChatChannel")).toBe("APIChatChannel");
    // Only whole words are initialisms — "identity" keeps its spelling.
    expect(goExportedName("identity")).toBe("Identity");
    expect(goExportedName("v1")).toBe("V1");
  });

  it("unexports names and escapes keywords", () => {
    expect(goUnexportedName("agent_id")).toBe("agentID");
    expect(goUnexportedName("type")).toBe("typeVal");
    expect(goUnexportedName("range")).toBe("rangeVal");
    // Predeclared identifiers are avoided too — a local named `len` is a trap.
    expect(goUnexportedName("len")).toBe("lenVal");
  });

  it("uniquifies collisions and honors reserved names", () => {
    expect(uniqueGoFieldNames(["user_id", "userId"])).toEqual(["UserID", "UserID2"]);
    expect(uniqueGoParamNames(["query"], ["query"])).toEqual(["query2"]);
  });

  it("hands out registry names deterministically", () => {
    const registry = new GoNameRegistry();
    expect(registry.claim("a", "Team")).toBe("Team");
    expect(registry.claim("b", "Team")).toBe("Team2");
    expect(registry.claim("a", "Team")).toBe("Team");
    // Runtime type names are reserved.
    expect(registry.claim("c", "APIError")).toBe("APIError2");
    expect(registry.claim("d", "JSONValue")).toBe("JSONValue2");
  });

  it("derives readable snake_case file stems", () => {
    expect(goFileStem("APIChatChannel")).toBe("api_chat_channel");
    expect(goFileStem("agent_computers")).toBe("agent_computers");
    expect(goFileStem("v1")).toBe("v1");
  });
});

describe("go type map", () => {
  it("maps primitives, arrays, maps, and optionals", () => {
    expect(typeRefToGo({ kind: "primitive", type: "string" })).toBe("string");
    expect(typeRefToGo({ kind: "primitive", type: "integer" })).toBe("int");
    expect(typeRefToGo({ kind: "primitive", type: "float" })).toBe("float64");
    expect(typeRefToGo({ kind: "primitive", type: "datetime" })).toBe("Time");
    expect(
      typeRefToGo({ kind: "array", items: { kind: "primitive", type: "string" } })
    ).toBe("[]string");
    expect(
      typeRefToGo({ kind: "optional", inner: { kind: "primitive", type: "string" } })
    ).toBe("*string");
    expect(
      typeRefToGo({
        kind: "map",
        keyType: { kind: "primitive", type: "string" },
        valueType: { kind: "unknown" },
      })
    ).toBe("map[string]JSONValue");
    expect(typeRefToGo({ kind: "enum", values: ["a", "b"] })).toBe("string");
    expect(
      goQueryStringExpr(
        {
          kind: "nullable",
          inner: { kind: "primitive", type: "string" },
        },
        "value"
      )
    ).toBe("queryParam(value)");
  });

  it("qualifies runtime types when emitting into another package", () => {
    expect(
      typeRefToGo({ kind: "primitive", type: "datetime" }, (s) => s, "platform.")
    ).toBe("platform.Time");
    expect(typeRefToGo({ kind: "unknown" }, (s) => s, "platform.")).toBe(
      "platform.JSONValue"
    );
  });

  it("makes refs and optional fields pointers, and leaves slices alone", () => {
    // Refs are always pointers: a Go struct cannot contain itself by value,
    // and every nested model needs an absent state.
    expect(
      goFieldType({ name: "team", type: { kind: "ref", schema: "Team" }, required: true })
    ).toBe("*Team");
    expect(
      goFieldType({
        name: "created_at",
        type: { kind: "primitive", type: "datetime" },
        required: false,
      })
    ).toBe("*Time");
    // Slices already carry nil; a pointer to a slice would be noise.
    expect(
      goFieldType({
        name: "tags",
        type: { kind: "array", items: { kind: "primitive", type: "string" } },
        required: false,
      })
    ).toBe("[]string");
  });

  it("adds omitempty only to optional fields", () => {
    expect(
      goJSONTag({ name: "id", type: { kind: "primitive", type: "string" }, required: true })
    ).toBe('`json:"id"`');
    expect(
      goJSONTag({
        name: "created_at",
        type: { kind: "primitive", type: "datetime" },
        required: false,
      })
    ).toBe('`json:"created_at,omitempty"`');
  });
});

describe("go model emitter", () => {
  it("emits structs with JSON tags and Go field names", () => {
    const registry = new GoNameRegistry();
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
    const output = emitGoModelsFile("platform", schemas, registry);
    expect(output).toContain("package platform");
    expect(output).toContain("type Team struct");
    expect(output).toContain('ID string `json:"id"`');
    expect(output).toContain('CreatedAt *Time `json:"created_at,omitempty"`');
    expect(output).toContain("// Team: A team.");
  });

  it("emits recursive schemas without infinite-size structs", () => {
    const registry = new GoNameRegistry();
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
    const output = emitGoModelsFile("platform", schemas, registry);
    expect(output).toContain("Next *Node");
  });

  it("emits top-level unions as variant structs with custom JSON coding", () => {
    const registry = new GoNameRegistry();
    registry.claim("schema:Cat", "Cat");
    registry.claim("schema:Dog", "Dog");
    registry.claim("schema:Pet", "Pet");
    const schemas: SchemaDef[] = [
      { name: "Cat", fields: [] },
      { name: "Dog", fields: [] },
      {
        name: "Pet",
        fields: [],
        unionType: {
          kind: "union",
          variants: [
            { kind: "ref", schema: "Cat" },
            { kind: "ref", schema: "Dog" },
          ],
          discriminator: { propertyName: "type", mapping: { cat: "Cat", dog: "Dog" } },
        },
      },
    ];
    const output = emitGoModelsFile("platform", schemas, registry);
    expect(output).toContain("type Pet struct");
    expect(output).toContain("Cat *Cat");
    expect(output).toContain("Raw JSONValue");
    expect(output).toContain("func (u *Pet) UnmarshalJSON(data []byte) error");
    expect(output).toContain("func (u Pet) MarshalJSON() ([]byte, error)");
    expect(output).toContain('case "cat":');
  });
});

describe("go backend", () => {
  it("populates inline union JSONValue inputs with a valid variant", () => {
    const registry = new GoNameRegistry();
    const channel = {
      name: "Tools",
      className: "ToolsChannel",
      joins: [
        {
          topicPattern: "tools",
          params: [],
          returnType: { kind: "unknown" as const },
        },
      ],
      messages: [
        {
          event: "tool_result",
          params: [
            {
              name: "results",
              required: true,
              type: {
                kind: "array" as const,
                items: {
                  kind: "union" as const,
                  variants: [
                    {
                      kind: "object" as const,
                      fields: [
                        {
                          name: "call_id",
                          type: { kind: "primitive" as const, type: "string" as const },
                          required: true,
                        },
                        {
                          name: "status",
                          type: { kind: "enum" as const, values: ["ok"] },
                          required: true,
                        },
                        {
                          name: "content",
                          type: { kind: "primitive" as const, type: "string" as const },
                          required: true,
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          returnType: { kind: "unknown" as const },
        },
      ],
      pushes: [],
    };

    emitGoChannelFile("platform", channel, registry);
    const contract = emitGoChannelContractTestFile(
      channel,
      { pkg: "platform", registry, schemas: [] },
      "github.com/ArchAstro/archastro-go/platform",
      (name) => name
    );

    const validResult =
      'platform.JSONOf(map[string]any{"call_id": "test-id", "status": "ok", "content": "test content"})';
    expect(contract).toContain(`Results: []platform.JSONValue{${validResult}}`);
    expect(contract).toContain(
      'platform.JSONOf([]any{map[string]any{"call_id": "test-id", "status": "ok", "content": "test content"}})'
    );
  });

  it("encodes required nullable channel parameters as explicit JSON null", () => {
    const registry = new GoNameRegistry();
    const channel = {
      name: "Nullable",
      className: "NullableChannel",
      joins: [
        {
          topicPattern: "nullable",
          params: [
            {
              name: "value",
              type: {
                kind: "nullable" as const,
                inner: { kind: "primitive" as const, type: "string" as const },
              },
              required: true,
            },
            {
              name: "optional_value",
              type: {
                kind: "optional" as const,
                inner: {
                  kind: "nullable" as const,
                  inner: { kind: "primitive" as const, type: "string" as const },
                },
              },
              required: false,
            },
          ],
          returnType: { kind: "unknown" as const },
        },
      ],
      messages: [],
      pushes: [],
    };
    const output = emitGoChannelFile(
      "platform",
      channel,
      registry
    );
    const contract = emitGoChannelContractTestFile(
      channel,
      { pkg: "platform", registry, schemas: [] },
      "github.com/ArchAstro/archastro-go/platform",
      (name) => name
    );

    expect(output).toContain("value *string");
    expect(output).toContain('payload["value"] = JSONOf(value)');
    expect(output).not.toContain("if value != nil");
    expect(contract).toMatch(
      /JoinNullableChannel\(ctx, socket, platform\.Ptr\("[^"]+"\), platform\.Ptr\(platform\.Ptr\("[^"]+"\)\)\)/
    );
  });

  it("serializes required nullable query parameters without omitting nil", () => {
    const output = emitGoResourceFile(
      "platform",
      {
        name: "widgets",
        className: "WidgetsResource",
        path: "/widgets",
        scopeParams: [],
        children: [],
        operations: [
          {
            name: "list",
            operationId: "get_widgets",
            method: "GET",
            path: "/api/v1/widgets",
            deprecated: false,
            pathParams: [],
            queryParams: [
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
            errors: [],
          },
        ],
      },
      new GoNameRegistry()
    );

    expect(output).toContain("Value *string");
    expect(output).toContain("if params.Value == nil");
    expect(output).toContain('q.Add("value", "null")');
    expect(output).toContain('q.Add("value", *params.Value)');
  });

  it("generates the full SDK file set flat in one package directory", () => {
    const files = generateFixtureFiles();
    const paths = Object.keys(files);

    expect(paths.some((p) => p.endsWith("platform/client.go"))).toBe(true);
    expect(paths.some((p) => p.endsWith("platform/v1.go"))).toBe(true);
    expect(paths.some((p) => /platform\/types_\w+\.go$/.test(p))).toBe(true);
    // Go compiles one package per directory — nothing may nest.
    expect(paths.every((p) => /^sdk\/platform\/[^/]+\.go$/.test(p))).toBe(true);

    const client = files[paths.find((p) => p.endsWith("client.go"))!]!;
    expect(client).toContain("type Client struct");
    expect(client).toContain("func NewClient(opts ...ClientOption) *Client");
  });

  it("emits context-taking resource methods over the runtime", () => {
    const files = generateFixtureFiles();
    const resourceFiles = Object.entries(files).filter(([p]) =>
      /platform\/v1_\w+\.go$/.test(p)
    );
    expect(resourceFiles.length).toBeGreaterThan(0);

    const combined = resourceFiles.map(([, content]) => content).join("\n");
    expect(combined).toContain("ctx context.Context");
    expect(combined).toContain("fetch[");
    expect(combined).toContain("requestSpec{");
    // Path parameters are escaped, not concatenated raw.
    expect(combined).toContain("url.PathEscape(");
  });

  it("bundles query parameters into a params struct", () => {
    const files = generateFixtureFiles();
    const combined = Object.values(files).join("\n");
    expect(combined).toMatch(/type \w+ListParams struct/);
    expect(combined).toContain("q := url.Values{}");
  });

  it("assigns collision-free names across the package namespace", () => {
    const { registry } = prepareGoSpec(fixtureAst());
    // Version namespaces claim before schemas, so V1 is always the namespace.
    expect(registry.lookup("version:v1")).toBe("V1");
    // Claiming an existing schema name again yields a distinct name.
    expect(registry.claim("test:dup", "Team")).not.toBe(registry.lookup("schema:Team"));
  });
});

describe("go contract tests emitter", () => {
  it("generates one test file per top-level resource", () => {
    const files = emitGoContractTests(fixtureAst(), { outDir: "sdk" });
    const paths = Object.keys(files);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.includes("contracttests/"))).toBe(true);
    expect(paths.every((p) => p.endsWith("_test.go"))).toBe(true);

    const combined = Object.values(files).join("\n");
    expect(combined).toContain("package contracttests");
    expect(combined).toContain('"testing"');
    expect(combined).toContain("client := restClient(t)");
    expect(combined).toContain("requireAPIError(t, err,");
  });

  it("emits error tests for documented status codes", () => {
    const files = emitGoContractTests(fixtureAst(), { outDir: "sdk" });
    const combined = Object.values(files).join("\n");
    expect(/func Test\w+Error\d{3}\(t \*testing\.T\)/.test(combined)).toBe(true);
  });

  it("keeps every generated test function name unique in the package", () => {
    const files = emitGoContractTests(fixtureAst(), { outDir: "sdk" });
    const names = Object.values(files)
      .join("\n")
      .match(/func (Test\w+)\(t \*testing\.T\)/g);
    expect(names).not.toBeNull();
    expect(new Set(names).size).toBe(names!.length);
  });

  it("only imports the SDK package when a test names a type from it", () => {
    const files = emitGoContractTests(fixtureAst(), { outDir: "sdk" });
    for (const [path, content] of Object.entries(files)) {
      const imported = content.includes(
        '"github.com/ArchAstro/archastro-go/platform"'
      );
      const used = content.includes("platform.");
      expect(imported, `${path} import/use mismatch`).toBe(used);
    }
  });
});
