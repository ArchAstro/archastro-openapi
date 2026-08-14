import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { emitRustContractTests } from "../../src/backends/contract-tests/rust-emitter.js";
import { rustIdent, rustTypeName, uniqueRustNames } from "../../src/backends/rust/identifiers.js";
import { generateRust, rustType } from "../../src/backends/rust/index.js";
import { parseOpenApiSpec } from "../../src/frontend/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "../fixtures/sample-spec.json"), "utf8"));

function ast() { return parseOpenApiSpec(fixture, { apiBase: "/api", defaultVersion: "v1" }); }

describe("rust identifiers", () => {
  it("uses idiomatic snake and Pascal case while escaping keywords", () => {
    expect(rustIdent("createdAt")).toBe("created_at");
    expect(rustIdent("type")).toBe("type_");
    expect(rustTypeName("api_chat_channel")).toBe("ApiChatChannel");
    expect(uniqueRustNames(["type", "type", "type_2"])).toEqual(["type_", "type__2", "type_2"]);
  });
});

describe("rust type mapping", () => {
  it("maps primitives, collections, nullability, and schema refs", () => {
    expect(rustType({ kind: "primitive", type: "datetime" })).toBe("chrono::DateTime<chrono::Utc>");
    expect(rustType({ kind: "array", items: { kind: "ref", schema: "Team" } })).toBe("Vec<Team>");
    expect(rustType({ kind: "nullable", inner: { kind: "primitive", type: "string" } })).toBe("Option<String>");
    expect(rustType({ kind: "unknown" })).toBe("Value");
  });
});

describe("rust backend", () => {
  it("generates models, auth, channels, version resources, and module wiring", () => {
    const files = generateRust(ast(), { outDir: "sdk" });
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      "sdk/src/generated/types.rs",
      "sdk/src/generated/auth.rs",
      "sdk/src/generated/channels.rs",
      "sdk/src/generated/v1.rs",
      "sdk/src/generated/mod.rs",
    ]));
    const output = Object.values(files).join("\n");
    expect(output).toContain("pub struct V1");
    expect(output).toContain("pub async fn");
    expect(output).toContain("_blocking(");
    expect(output).toContain("SseDecode, SseStream");
    expect(output).toContain("ChannelEventStream<");
  });

  it("lifts synthetic api/version wrappers out of the public namespace", () => {
    const files = generateRust(ast(), { outDir: "sdk" });
    const version = files["sdk/src/generated/v1.rs"]!;
    expect(version).not.toContain("pub fn api(&self)");
    expect(version).not.toContain("pub fn v1(&self)");
  });

  it("emits typed enums and unions while boxing only inline recursive references", () => {
    const spec = ast();
    spec.schemas.push(
      {
        name: "Leaf",
        fields: [{ name: "value", type: { kind: "primitive", type: "string" }, required: true }],
      },
      {
        name: "RecursiveNode",
        fields: [
          { name: "leaf", type: { kind: "ref", schema: "Leaf" }, required: true },
          { name: "next", type: { kind: "optional", inner: { kind: "ref", schema: "RecursiveNode" } }, required: false },
          { name: "children", type: { kind: "array", items: { kind: "ref", schema: "RecursiveNode" } }, required: true },
          { name: "status", type: { kind: "enum", values: ["in-progress", "in_progress"] }, required: true },
          {
            name: "choice",
            type: { kind: "union", variants: [
              { kind: "primitive", type: "string" },
              { kind: "primitive", type: "integer" },
            ] },
            required: true,
          },
        ],
      },
    );

    const types = generateRust(spec, { outDir: "sdk" })["sdk/src/generated/types.rs"]!;
    expect(types).toContain("pub leaf: Leaf,");
    expect(types).toContain("pub next: Option<Box<RecursiveNode>>,");
    expect(types).toContain("pub children: Vec<RecursiveNode>,");
    expect(types).toContain("pub enum RecursiveNodeStatus");
    expect(types).toContain("#[serde(rename = \"in-progress\")]");
    expect(types).toContain("InProgress2,");
    expect(types).toContain("pub enum RecursiveNodeChoice");
    expect(types).toContain("Variant1(String)");
    expect(types).toContain("Variant2(i64)");
  });
});

describe("rust contract emitter", () => {
  it("emits REST happy/error cases and SSE harness cases", () => {
    const spec = ast();
    const operation = spec.versions[0]!.resources[0]!.children[0]!.operations[0]!;
    operation.streaming = { style: "sse", events: [{ event: "updated", dataType: { kind: "unknown" } }] };
    const files = emitRustContractTests(spec, "sdk");
    const rest = files["sdk/tests/generated_rest_contract.rs"]!;
    const streams = files["sdk/tests/generated_stream_contract.rs"]!;
    expect(rest).toContain("#[tokio::test]");
    expect(rest).toContain("support::assert_api_error");
    expect(rest).toContain("serde_json::from_str");
    expect(streams).toContain("register_stream");
    expect(streams).toContain("StreamExt");
  });
});
