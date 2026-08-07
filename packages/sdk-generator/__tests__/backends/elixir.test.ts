import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import {
  ELIXIR_GENERATED_DIR,
  elixirResourceChain,
  generateElixir,
} from "../../src/backends/elixir/index.js";
import { emitElixirContractTests } from "../../src/backends/contract-tests/elixir-emitter.js";
import {
  exFieldName,
  exFunctionName,
  exModuleSegment,
  uniqueExModuleSegments,
} from "../../src/backends/elixir/identifiers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../fixtures/sample-spec.json"), "utf8")
);

function ast() {
  return parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" });
}

describe("elixir identifiers", () => {
  it("emits idiomatic modules, functions, fields, and escaped keywords", () => {
    expect(exModuleSegment("api_chat_channel")).toBe("ApiChatChannel");
    expect(exFunctionName("listUsers")).toBe("list_users");
    expect(exFieldName("created-at")).toBe("created_at");
    expect(exFieldName("when")).toBe("when_");
    expect(exFunctionName("true")).toBe("true_");
    expect(exFunctionName("---")).toBe("value");
    expect(exFunctionName("1st")).toBe("_1st");
    expect(exFunctionName("__info__")).toBe("__info___");
    expect(exFieldName("__struct__")).toBe("__struct___");
    expect(uniqueExModuleSegments(["Foo", "Foo", "Foo2"])).toEqual(["Foo", "Foo2", "Foo22"]);
  });
});

describe("elixir backend", () => {
  it("writes generated source beneath the one-word archastro folder", () => {
    const files = generateElixir(ast(), { outDir: "sdk" });
    const paths = Object.keys(files);

    expect(ELIXIR_GENERATED_DIR).toBe("lib/archastro/generated");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.startsWith("sdk/lib/archastro/generated/"))).toBe(true);
    expect(paths.some((path) => path.includes("lib/arch_astro"))).toBe(false);
  });

  it("removes only leading synthetic resource wrappers", () => {
    const version = ast().versions[0]!;
    const resource = (name: string) => ({ name } as typeof version.resources[number]);
    expect(elixirResourceChain(version, [resource("api"), resource(version.version), resource("foo")]))
      .toEqual(["foo"]);
    expect(elixirResourceChain(version, [resource("foo"), resource("api")]))
      .toEqual(["foo", "api"]);
    expect(elixirResourceChain(version, [resource("api"), resource(version.version)]))
      .toEqual([]);
  });

  it("emits structs, resources, auth, and Slipstream-facing channel facades", () => {
    const output = Object.values(generateElixir(ast(), { outDir: "sdk" })).join("\n");

    expect(output).toContain("defmodule ArchAstro.Types.");
    expect(output).toContain("ArchAstro.HTTP.request");
    expect(output).toContain("defmodule ArchAstro.Auth do");
    expect(output).toContain("ArchAstro.Channel.join");
    expect(output).toContain("ArchAstro.Channel.push");
  });

  it("types every generated public function and uses structs at API boundaries", () => {
    const output = Object.values(generateElixir(ast(), { outDir: "sdk" })).join("\n");
    const publicDefs = output.match(/^ {2}def /gm) ?? [];
    const specs = output.match(/^ {2}@spec /gm) ?? [];

    expect(specs).toHaveLength(publicDefs.length);
    expect(output).toContain("ArchAstro.Client.t()");
    expect(output).toContain("ArchAstro.JSON.t()");
    expect(output).toContain("Params.t()");
    expect(output).toContain("Input.t()");
    expect(output).not.toContain("term()");
    expect(output).not.toContain("params \\ []");
    expect(output).not.toContain("payload \\ %{}");
  });

  it("types OpenAPI numbers for both integer and fractional JSON values", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = { kind: "primitive", type: "float" };

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain("{:ok, number()}");
    expect(output).not.toContain("{:ok, float()}");
  });

  it("disambiguates normalized API-version module names", () => {
    const spec = ast();
    const second = structuredClone(spec.versions[0]!);
    second.version = "v_1";
    second.apiPrefix = second.apiPrefix.replace("v1", "v_1");
    spec.versions = [spec.versions[0]!, second];

    const sdk = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(sdk).toContain("defmodule ArchAstro.V1.");
    expect(sdk).toContain("defmodule ArchAstro.V12.");
    expect(contracts).toContain("defmodule ArchAstro.Contract.V1.");
    expect(contracts).toContain("defmodule ArchAstro.Contract.V12.");
  });

  it("serializes query structs with OpenAPI wire names", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)
      .find((candidate) => candidate.queryParams.length > 0)!;
    operation.queryParams[0]!.name = "sdkQueryName";
    operation.queryParams[0]!.wireName = "wire-query-name";

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain('sdk_query_name: {"wire-query-name",');
  });

  it("replaces every occurrence of repeated REST and channel placeholders", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.path = "/parents/{id}/children/{id}";
    operation.pathParams = [{
      name: "id",
      required: true,
      type: { kind: "primitive", type: "string" },
    }];

    const join = spec.channels[0]!.joins[0]!;
    join.topicPattern = "room:{id}:mirror:{id}";
    join.params = [{
      name: "id",
      required: true,
      type: { kind: "primitive", type: "string" },
    }];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain(
      '"/parents/#{ArchAstro.Path.encode(id)}/children/#{ArchAstro.Path.encode(id)}"'
    );
    expect(output).toContain('"room:#{id}:mirror:#{id}"');
    expect(output).not.toMatch(/def \w+\(socket, id, id_2/);
  });

  it("matches non-word channel placeholders by their OpenAPI wire names", () => {
    const spec = ast();
    const join = spec.channels[0]!.joins[0]!;
    join.topicPattern = "room:{user-id}";
    join.params = [{
      name: "user_id",
      wireName: "user-id",
      required: true,
      type: { kind: "primitive", type: "string" },
    }];

    const sdk = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(sdk).toContain('topic = "room:#{user_id}"');
    expect(sdk).toContain("@spec join_team_thread(GenServer.server(), String.t())");
    expect(contracts).toContain("join_team_thread(socket, \"test-id\")");
  });

  it("hoists inline union object variants into strict structs", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = {
      kind: "object",
      fields: [{
        name: "choice",
        required: true,
        type: {
          kind: "union",
          variants: [
            {
              kind: "object",
              fields: [{
                name: "count",
                required: true,
                type: { kind: "primitive", type: "integer" },
              }],
            },
            {
              kind: "object",
              fields: [{
                name: "label",
                required: true,
                type: { kind: "primitive", type: "string" },
              }],
            },
          ],
        },
      }],
    };

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toMatch(/defmodule ArchAstro\.Types\..*ChoiceVariant1 do/);
    expect(output).toMatch(/defmodule ArchAstro\.Types\..*ChoiceVariant2 do/);
    expect(output).toMatch(/choice: ArchAstro\.Types\..*ChoiceVariant1\.t\(\) \| ArchAstro\.Types\..*ChoiceVariant2\.t\(\)/);
  });

  it("hoists top-level inline union response variants into strict structs", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = {
      kind: "union",
      variants: [
        {
          kind: "object",
          fields: [{
            name: "count",
            required: true,
            type: { kind: "primitive", type: "integer" },
          }],
        },
        {
          kind: "object",
          fields: [{
            name: "label",
            required: true,
            type: { kind: "primitive", type: "string" },
          }],
        },
      ],
    };

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toMatch(/defmodule ArchAstro\.Types\..*Response\.Nested\.ValueVariant1 do/);
    expect(output).toContain(
      ":: {:ok, ArchAstro.Types.Operations.ListAgents.Response.Nested.ValueVariant1.t() | " +
      "ArchAstro.Types.Operations.ListAgents.Response.Nested.ValueVariant2.t()}"
    );
  });

  it("disambiguates channel facades after removing the Channel suffix", () => {
    const spec = ast();
    const first = structuredClone(spec.channels[0]!);
    const second = structuredClone(spec.channels[0]!);
    first.className = "FooChannel";
    second.className = "Foo";
    first.name = "foo-channel";
    second.name = "foo";
    spec.channels = [first, second];

    const sdk = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(sdk).toContain("defmodule ArchAstro.Channels.Foo do");
    expect(sdk).toContain("defmodule ArchAstro.Channels.Foo2 do");
    expect(sdk).toContain("defmodule ArchAstro.Types.ChannelPayloads.FooChannel.");
    expect(sdk).toContain("defmodule ArchAstro.Types.ChannelPayloads.Foo2Channel.");
    expect(contracts).toContain("ArchAstro.Channels.Foo.");
    expect(contracts).toContain("ArchAstro.Channels.Foo2.");
    expect(contracts).toContain("defmodule ArchAstro.Contract.Channels.FooChannelTest do");
    expect(contracts).toContain("defmodule ArchAstro.Contract.Channels.Foo2ChannelTest do");
  });

  it("preserves raw-response and typed channel-response semantics", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.rawResponse = true;
    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");

    expect(output).toContain("raw: true");
    expect(output).toContain("{:ok, Req.Response.t()}");
    expect(output).toMatch(/ArchAstro\.Channel\.join\([\s\S]*\{:ref, ArchAstro\.Types\./);
  });

  it("generates ExUnit REST and channel contract suites", () => {
    const files = emitElixirContractTests(ast(), "sdk");
    const paths = Object.keys(files);
    const output = Object.values(files).join("\n");

    expect(paths.every((path) => path.startsWith("sdk/test/contract/"))).toBe(true);
    expect(output).toContain("use ExUnit.Case, async: false");
    expect(output).toContain("ArchAstro.ContractSupport.client()");
    expect(output).toContain("ArchAstro.ContractSupport.verify_channel");
    expect(output).toContain("fn socket, push ->");
    expect(output).toContain("assert {:ok, %ArchAstro.Channel{join_response:");
    expect(output).toContain("assert :ok = ArchAstro.Channels.");
    expect(output).toContain('assert :ok = push.(channel.topic, "message_added")');
    expect(output).toContain('assert_receive {:archastro_channel, ^channel, "message_added"');
    expect(output).toContain("%ArchAstro.Types.Operations.");
  });

  it("constructs required referenced structs in contract inputs", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.body = {
      schema: "inline",
      contentType: "application/json",
      fields: [{
        name: "team",
        required: true,
        type: { kind: "ref", schema: "Team" },
      }],
    };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toMatch(
      /%ArchAstro\.Types\.Operations\..*\.Input\{team: %ArchAstro\.Types\.Team\{id: "test-id", name: "test-name"\}\}/
    );
  });

  it("terminates recursive required array inputs with an empty collection", () => {
    const spec = ast();
    const node = {
      name: "Node",
      fields: [{
        name: "children",
        required: true,
        type: { kind: "array" as const, items: { kind: "ref" as const, schema: "Node" } },
      }],
    };
    spec.schemas.push(node);
    spec.schemaGroups.recursive_contract = [node];
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.body = { schema: "Node", contentType: "application/json" };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("%ArchAstro.Types.Node{children: []}");
    expect(contracts).not.toContain("%ArchAstro.Types.Node{}");
  });

  it("accepts nil or a struct for nullable structured responses", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = {
      kind: "nullable",
      inner: { kind: "ref", schema: "Team" },
    };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("assert {:ok, value} =");
    expect(contracts).toContain(
      "assert is_nil(value) or is_struct(value, ArchAstro.Types.Team)"
    );
  });

  it("constructs a concrete variant for top-level union request bodies", () => {
    const spec = ast();
    const variant = { name: "UnionInputVariant", fields: [] };
    const union = {
      name: "UnionInput",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [{ kind: "ref" as const, schema: variant.name }],
      },
    };
    spec.schemas.push(variant, union);
    spec.schemaGroups.union_input = [variant, union];
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.body = { schema: union.name, contentType: "application/json" };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("%ArchAstro.Types.UnionInputVariant{}");
    expect(contracts).not.toContain("%ArchAstro.Types.UnionInput{}");
  });

  it("uses the emitted hoisted module for inline named-union request variants", () => {
    const spec = ast();
    const union = {
      name: "InlineUnionInput",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [{
          kind: "object" as const,
          fields: [{
            name: "value",
            required: true,
            type: { kind: "primitive" as const, type: "string" as const },
          }],
        }],
      },
    };
    spec.schemas.push(union);
    spec.schemaGroups.inline_union_input = [union];
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.body = { schema: union.name, contentType: "application/json" };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain(
      "%ArchAstro.Types.InlineUnionInput.Nested.VariantVariant1{value: \"test-value\"}"
    );
    expect(contracts).not.toContain("%ArchAstro.Types.InlineUnionInput.Nested{");
  });

  it("checks named-union push payloads against their hoisted variant module", () => {
    const spec = ast();
    const union = {
      name: "PushUnion",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [{
          kind: "object" as const,
          fields: [{
            name: "value",
            required: true,
            type: { kind: "primitive" as const, type: "string" as const },
          }],
        }],
      },
    };
    spec.schemas.push(union);
    spec.schemaGroups.push_union = [union];
    spec.channels[0]!.pushes[0]!.payloadType = { kind: "ref", schema: union.name };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain(
      "is_struct(push_payload_0, ArchAstro.Types.PushUnion.Nested.VariantVariant1)"
    );
    expect(contracts).not.toContain(
      "is_struct(push_payload_0, ArchAstro.Types.ChannelPayloads.ChatChannel.MessageAdded.Payload)"
    );
  });

  it("does not pattern-match named channel response unions as structs", () => {
    const spec = ast();
    const variant = { name: "ChannelUnionVariant", fields: [] };
    const union = {
      name: "ChannelUnion",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [{ kind: "ref" as const, schema: variant.name }],
      },
    };
    spec.schemas.push(variant, union);
    spec.schemaGroups.channel_union = [variant, union];
    spec.channels[0]!.joins[0]!.returnType = { kind: "ref", schema: union.name };
    spec.channels[0]!.messages[0]!.returnType = { kind: "ref", schema: union.name };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).not.toContain("%ArchAstro.Types.ChannelUnion{}");
    expect(contracts).toContain("join_response: _value");
  });

  it("preserves named-union request bodies for auth operations", () => {
    const spec = ast();
    const variant = { name: "AuthUnionVariant", fields: [] };
    const union = {
      name: "AuthUnionInput",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [{ kind: "ref" as const, schema: variant.name }],
      },
    };
    spec.schemas.push(variant, union);
    spec.schemaGroups.auth_union = [variant, union];
    const operation = structuredClone(
      spec.versions
        .flatMap((version) => version.resources)
        .flatMap(function walk(resource): typeof resource[] {
          return [resource, ...resource.children.flatMap(walk)];
        })
        .flatMap((resource) => resource.operations)[0]!
    );
    operation.name = "union_auth";
    operation.sdkName = "union_auth";
    operation.body = { schema: union.name, contentType: "application/json" };
    operation.pathParams = [];
    operation.queryParams = [];
    spec.authOperations = [operation];

    const sdk = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(sdk).toContain("body: ArchAstro.Types.AuthUnionInput.t()");
    expect(sdk).toContain("body = input.body");
    expect(sdk).toContain("body: body");
  });

  it("allows empty array responses while asserting their list shape", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = {
      kind: "array",
      items: { kind: "primitive", type: "string" },
    };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("assert {:ok, items} =");
    expect(contracts).toContain("assert is_list(items)");
    expect(contracts).not.toContain("[_item | _]");
  });

  it("asserts scalar REST response runtime shapes", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = { kind: "primitive", type: "integer" };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("assert {:ok, value} =");
    expect(contracts).toContain("assert is_integer(value)");
  });

  it("asserts anonymous union objects against their emitted hoisted modules", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = {
      kind: "union",
      variants: [{
        kind: "object",
        fields: [{
          name: "value",
          required: true,
          type: { kind: "primitive", type: "string" },
        }],
      }],
    };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain(
      "is_struct(value, ArchAstro.Types.Operations.ListAgents.Response.Nested.ValueVariant1)"
    );
    expect(contracts).not.toContain(
      "is_struct(value, ArchAstro.Types.Operations.ListAgents.Response)"
    );
  });

  it("verifies every SSE event name, decoded payload shape, and error behavior", () => {
    const spec = ast();
    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.streaming = {
      style: "sse",
      events: [
        { event: "team", dataType: { kind: "ref", schema: "Team" } },
        { event: "count", dataType: { kind: "primitive", type: "integer" } },
        { event: "created", dataType: { kind: "primitive", type: "datetime" } },
      ],
    };

    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain('["team", "count", "created"], fn client ->');
    expect(contracts).toContain('event: "team", data: event_data_0');
    expect(contracts).toContain("assert is_struct(event_data_0, ArchAstro.Types.Team)");
    expect(contracts).toContain("assert is_integer(event_data_1)");
    expect(contracts).toContain("assert is_struct(event_data_2, DateTime)");
    expect(contracts).toContain("ArchAstro.ContractSupport.verify_stream_error");
  });

  it("escapes OpenAPI interpolation syntax in source and contract-test literals", () => {
    const spec = ast();
    spec.channels[0]!.name = "unsafe#{System.cmd(\"touch\", [\"owned\"])}";
    spec.channels[0]!.description = "unsafe #{raise \"compiled\"} and escaped \\#{raise \"also compiled\"}";

    const sdk = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(sdk).toContain('unsafe \\#{raise "compiled"}');
    expect(sdk).toContain('escaped \\\\\\#{raise "also compiled"}');
    expect(contracts).toContain('unsafe\\#{System.cmd(\\"touch\\", [\\"owned\\"])}');
  });

  it("keeps colliding normalized channel filenames distinct", () => {
    const spec = ast();
    const first = structuredClone(spec.channels[0]!);
    const second = structuredClone(spec.channels[0]!);
    first.name = "chat-feed";
    second.name = "chat_feed";
    first.className = "ChatFeedChannel";
    second.className = "Chat_FeedChannel";
    spec.channels = [first, second];

    const sdkPaths = Object.keys(generateElixir(spec, { outDir: "sdk" }));
    const contractPaths = Object.keys(emitElixirContractTests(spec, "sdk"));
    expect(sdkPaths.filter((path) => path.includes("/channels/chat_feed"))).toHaveLength(2);
    expect(contractPaths.filter((path) => path.includes("/channels/chat_feed"))).toHaveLength(2);
  });

  it("confines hostile channel names to safe generated basenames", () => {
    const spec = ast();
    spec.channels[0]!.name = "../../../../outside";

    const sdkPaths = Object.keys(generateElixir(spec, { outDir: "sdk" }));
    const contractPaths = Object.keys(emitElixirContractTests(spec, "sdk"));
    expect(sdkPaths.every((path) => path.startsWith("sdk/lib/archastro/generated/"))).toBe(true);
    expect(contractPaths.every((path) => path.startsWith("sdk/test/contract/"))).toBe(true);
    expect([...sdkPaths, ...contractPaths].every((path) => !path.includes(".."))).toBe(true);
  });

  it("disambiguates auth facades and channel payload types without changing wire names", () => {
    const spec = ast();
    const firstAuth = structuredClone(
      spec.versions
        .flatMap((version) => version.resources)
        .flatMap(function walk(resource): typeof resource[] {
          return [resource, ...resource.children.flatMap(walk)];
        })
        .flatMap((resource) => resource.operations)[0]!
    );
    const secondAuth = structuredClone(firstAuth);
    firstAuth.name = "sign-in";
    firstAuth.sdkName = "sign-in";
    secondAuth.name = "sign_in";
    secondAuth.sdkName = "sign_in";
    secondAuth.operationId = `${firstAuth.operationId}_second`;
    spec.authOperations = [firstAuth, secondAuth];

    const channel = spec.channels[0]!;
    const firstMessage = channel.messages[0]!;
    const secondMessage = structuredClone(firstMessage);
    firstMessage.event = "item-added";
    secondMessage.event = "item_added";
    channel.messages = [firstMessage, secondMessage];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toMatch(/def sign_in\(/);
    expect(output).toMatch(/def sign_in_2\(/);
    expect(output).toContain(".ItemAdded.Input do");
    expect(output).toContain(".ItemAdded2.Input do");
    expect(output).toContain('ArchAstro.Channel.push(channel, "item-added"');
    expect(output).toContain('ArchAstro.Channel.push(channel, "item_added"');
  });

  it("types channel topic arguments from their declared schemas", () => {
    const spec = ast();
    const join = spec.channels[0]!.joins[0]!;
    const topicName = [...join.topicPattern.matchAll(/\{(\w+)\}/g)][0]![1]!;
    join.params.find((param) => param.name === topicName)!.type = {
      kind: "primitive",
      type: "integer",
    };

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toMatch(/@spec \w+\(GenServer\.server\(\), integer\(\)/);
  });

  it("uses one collision-safe payload namespace across channel member kinds", () => {
    const spec = ast();
    const channel = spec.channels[0]!;
    const join = channel.joins[0]!;
    const message = channel.messages[0]!;
    join.name = "update-item";
    message.event = "update_item";

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain(".UpdateItem.Response do");
    expect(output).toContain(".UpdateItem2.Response do");
  });

  it("preserves original implicit discriminator tags while normalizing modules", () => {
    const spec = ast();
    const cat = { name: "foo-bar", fields: [] };
    const dog = { name: "dog_type", fields: [] };
    const pet = {
      name: "pet_union",
      fields: [],
      unionType: {
        kind: "union" as const,
        variants: [
          { kind: "ref" as const, schema: "foo-bar" },
          { kind: "ref" as const, schema: "dog_type" },
        ],
        discriminator: { propertyName: "kind" },
      },
    };
    spec.schemas.push(cat, dog, pet);
    spec.schemaGroups.discriminator_regression = [cat, dog, pet];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain('"foo-bar" => ArchAstro.Types.FooBar');
    expect(output).toContain('"dog_type" => ArchAstro.Types.DogType');

    const operation = spec.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)[0]!;
    operation.returnType = { kind: "ref", schema: "pet_union" };
    const contracts = Object.values(emitElixirContractTests(spec, "sdk")).join("\n");
    expect(contracts).toContain("assert {:ok, value} =");
    expect(contracts).toContain("is_struct(value, ArchAstro.Types.FooBar)");
    expect(contracts).not.toContain("%ArchAstro.Types.PetUnion{}");
  });

  it("marks non-required object descriptors optional and disambiguates nested models", () => {
    const spec = ast();
    const nested = (name: string) => ({
      name,
      required: false,
      type: {
        kind: "object" as const,
        fields: [{
          name: "value",
          required: true,
          type: { kind: "primitive" as const, type: "string" as const },
        }],
      },
    });
    const schema = {
      name: "collision_container",
      fields: [nested("item-added"), nested("item_added")],
    };
    spec.schemas.push(schema);
    spec.schemaGroups.nested_regression = [schema];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain(".ItemAdded do");
    expect(output).toContain(".ItemAdded2 do");
    expect(output).toContain('{"item-added", {:optional, {:ref,');
    expect(output).toContain('{"item_added", {:optional, {:ref,');
  });

  it("redacts credential-bearing generated structs", () => {
    const spec = ast();
    const tokens = {
      name: "auth_tokens",
      fields: [{
        name: "access_token",
        required: true,
        sdkRole: "access_token",
        type: { kind: "primitive" as const, type: "string" as const },
      }],
    };
    spec.schemas.push(tokens);
    spec.schemaGroups.auth_regression = [tokens];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain("defimpl Inspect, for: ArchAstro.Types.AuthTokens do");
    expect(output).toContain("<[REDACTED]>");
  });

  it("redacts auth inputs and keeps colliding parameter locations distinct", () => {
    const spec = ast();
    const operation = structuredClone(
      spec.versions
        .flatMap((version) => version.resources)
        .flatMap(function walk(resource): typeof resource[] {
          return [resource, ...resource.children.flatMap(walk)];
        })
        .flatMap((resource) => resource.operations)[0]!
    );
    const credential = {
      name: "credential",
      wireName: "credential",
      required: true,
      type: { kind: "primitive" as const, type: "string" as const },
    };
    operation.name = "authenticate";
    operation.operationId = "authenticate_collision";
    operation.path = "/auth/{credential}";
    operation.pathParams = [credential];
    operation.queryParams = [structuredClone(credential)];
    operation.body = {
      schema: "inline",
      contentType: "application/json",
      fields: [structuredClone(credential)],
    };
    spec.authOperations = [operation];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toContain("path_credential:");
    expect(output).toContain("query_credential:");
    expect(output).toContain("body_credential:");
    expect(output).toContain("ArchAstro.Path.encode(input.path_credential)");
    expect(output).toContain('put_optional("credential", input.query_credential)');
    expect(output).toContain('put_optional("credential", input.body_credential)');
    expect(output).toContain(
      "defimpl Inspect, for: ArchAstro.Types.Operations.AuthenticateCollision.AuthInput"
    );
  });

  it("uses the same path-based auth fallback names as sibling generators", () => {
    const spec = ast();
    const operation = structuredClone(
      spec.versions
        .flatMap((version) => version.resources)
        .flatMap(function walk(resource): typeof resource[] {
          return [resource, ...resource.children.flatMap(walk)];
        })
        .flatMap((resource) => resource.operations)[0]!
    );
    operation.name = "post_api_v1_auth_login";
    operation.sdkName = undefined;
    operation.path = "/api/v1/auth/login";
    operation.pathParams = [];
    spec.authOperations = [operation];

    const output = Object.values(generateElixir(spec, { outDir: "sdk" })).join("\n");
    expect(output).toMatch(/def login\(/);
    expect(output).not.toMatch(/def post_api_v1_auth_login\(/);
  });
});
