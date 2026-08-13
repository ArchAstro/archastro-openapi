import { describe, it, expect } from "vitest";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { emitResourceFile } from "../../src/backends/typescript/resource-emitter.js";
import { emitPythonResourceFile } from "../../src/backends/python/resource-emitter.js";
import { generateContractTests } from "../../src/backends/contract-tests/index.js";
import { generateElixir } from "../../src/backends/elixir/index.js";

// A spec with a single SSE streaming operation (`x-sdk-streaming`), modeled on
// POST /ai/chat/completions/stream: a typed request body plus a discriminated
// set of named SSE event payloads. Exercises the whole pipeline — the operation
// parser reads the hint, the resource inferrer attaches `streaming`, and the
// backends emit a stream method rather than a plain request.
const streamSpec = {
  openapi: "3.0.0",
  info: { title: "Stream API", version: "1.0.0" },
  paths: {
    "/api/v1/ai/chat/completions/stream": {
      post: {
        operationId: "post_api_v1_ai_chat_completions_stream",
        summary: "Stream a chat completion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["messages"],
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["role"],
                      properties: {
                        role: { type: "string" },
                        content: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "x-sdk-streaming": {
          type: "sse",
          events: {
            message_delta: { $ref: "#/components/schemas/StreamMessageDelta" },
            done: { $ref: "#/components/schemas/StreamDone" },
          },
        },
        responses: { "200": { description: "Server-Sent Events stream" } },
      },
    },
  },
  components: {
    schemas: {
      StreamMessageDelta: {
        type: "object",
        properties: { delta: { type: "string" } },
      },
      StreamDone: {
        type: "object",
        properties: { finish_reason: { type: "string" } },
      },
    },
  },
};

const parseOpts = {
  name: "archastro-platform",
  version: "0.1.0",
  baseUrl: "https://platform.archastro.ai",
  apiBase: "/api",
  defaultVersion: "v1",
};

const ast = parseOpenApiSpec(streamSpec, parseOpts);
// Emit every resource and join — robust to how the nested ai/chat/completions
// tree is named; the `stream` method lands somewhere in the combined output.
const tsOutput = ast.resources
  .map((r) => emitResourceFile(r, "/api/v1"))
  .join("\n\n");
const pyOutput = ast.resources
  .map((r) => emitPythonResourceFile(r, "/api/v1"))
  .join("\n\n");

describe("TypeScript SSE streaming emission", () => {
  it("emits an async generator method (not a Promise-returning request)", () => {
    expect(tsOutput).toMatch(/async \*stream\(/);
  });

  it("passes the typed request body through to streamSSE", () => {
    expect(tsOutput).toMatch(/async \*stream\(input:/);
    expect(tsOutput).toContain("this.http.streamSSE(");
    expect(tsOutput).toContain("body: input");
  });

  it("types the yielded events as a discriminated union of {event, data}", () => {
    expect(tsOutput).toContain("AsyncIterable<");
    expect(tsOutput).toContain('{ event: "done"; data: StreamDone }');
    expect(tsOutput).toContain(
      '{ event: "message_delta"; data: StreamMessageDelta }',
    );
  });

  it("imports the event payload schemas referenced in the union", () => {
    // Regression: the stream() union references the event schema names, so they
    // must be added to the resource file's imports — otherwise tsc fails with
    // TS2304 "Cannot find name". (Only manifests with $ref'd, named events.)
    const schemaImports = {
      StreamMessageDelta: "../../types/sample.js",
      StreamDone: "../../types/sample.js",
    };
    const out = ast.resources
      .map((r) => emitResourceFile(r, "/api/v1", { schemaImports }))
      .join("\n\n");
    expect(out).toMatch(/import type \{[^}]*\bStreamMessageDelta\b[^}]*\} from/);
    expect(out).toMatch(/import type \{[^}]*\bStreamDone\b[^}]*\} from/);
  });
});

describe("Python SSE streaming emission", () => {
  it("emits both async and sync generator methods with a typed input", () => {
    expect(pyOutput).toContain("async def stream(self, input:");
    expect(pyOutput).toContain("-> AsyncIterator[");
    expect(pyOutput).toContain("-> Iterator[");
  });

  it("drives the stream through stream_sse / stream_sse_sync", () => {
    expect(pyOutput).toContain("stream_sse(");
    expect(pyOutput).toContain("stream_sse_sync(");
  });

  it("types the events as a TypedDict union keyed by a Literal tag", () => {
    expect(pyOutput).toContain('event: Literal["done"]');
    expect(pyOutput).toContain('event: Literal["message_delta"]');
    expect(pyOutput).toContain("data: StreamDone");
    expect(pyOutput).toContain("data: StreamMessageDelta");
    // The event union is `A | B` (ruff UP007), not `Union[A, B]`.
    expect(pyOutput).not.toContain("Union[");
    expect(pyOutput).toMatch(/CompletionStreamEvent\w* = \w+ \| \w+/);
  });
});

describe("Elixir SSE streaming emission", () => {
  it("decodes declared event payloads and safely passes through unknown events", () => {
    const output = Object.values(generateElixir(ast, { outDir: "sdk" })).join("\n");

    expect(output).toContain("ArchAstro.SDK.SSE.Stream.t(");
    expect(output).toContain("def decode(%ArchAstro.SDK.SSE.Event{event:");
    expect(output).toContain("def decode(event), do: event");
    expect(output).toContain("| ArchAstro.SDK.JSON.t()}");
  });

  it("keeps colliding normalized inline event payload modules distinct", () => {
    const collisionAst = structuredClone(ast);
    const operation = collisionAst.versions
      .flatMap((version) => version.resources)
      .flatMap(function walk(resource): typeof resource[] {
        return [resource, ...resource.children.flatMap(walk)];
      })
      .flatMap((resource) => resource.operations)
      .find((candidate) => candidate.streaming)!;
    const dataType = {
      kind: "object" as const,
      fields: [{
        name: "value",
        type: { kind: "primitive" as const, type: "string" as const },
        required: true,
      }],
    };
    operation.streaming!.events = [
      { event: "item-added", dataType },
      { event: "item_added", dataType: structuredClone(dataType) },
    ];

    const output = Object.values(generateElixir(collisionAst, { outDir: "sdk" })).join("\n");
    expect(output).toContain(".StreamEvents.ItemAddedData do");
    expect(output).toContain(".StreamEvents.ItemAdded2Data do");
    expect(output).toContain('event: "item-added"');
    expect(output).toContain('event: "item_added"');
  });
});

describe("SSE contract-test generation", () => {
  it("emits a TypeScript stream contract test driving the harness", () => {
    const files = generateContractTests(ast, { lang: "typescript", outDir: "sdk" });
    const entry = Object.entries(files).find(
      ([p]) => p.includes("/streams/") && p.endsWith(".contract.test.ts")
    );
    expect(entry).toBeDefined();
    const content = entry![1];
    expect(content).toContain('import { HarnessServiceClient } from "@archastro/channel-harness";');
    expect(content).toContain("registerStreamScenario");
    // autoEmit lets the harness synthesize contract-valid event payloads.
    expect(content).toContain('{ type: "autoEmit", event: "message_delta" }');
    expect(content).toMatch(/for await \(const ev of .*\.stream\(/);
    // error path asserts a non-2xx surfaces as ApiError
    expect(content).toContain("ApiError");
  });

  it("emits a Python stream contract test driving the harness", () => {
    const files = generateContractTests(ast, { lang: "python", outDir: "sdk" });
    const entry = Object.entries(files).find(
      ([p]) => p.includes("/streams/") && p.endsWith(".py")
    );
    expect(entry).toBeDefined();
    const content = entry![1];
    expect(content).toContain("from archastro.phx_channel import HarnessServiceClient");
    expect(content).toContain("register_stream_scenario");
    expect(content).toContain('{"type": "autoEmit", "event": "message_delta"}');
    expect(content).toMatch(/async for ev in .*\.stream\(/);
    expect(content).toContain("ApiError");
  });

  it("gates the stream tests behind the opt-in env + boots the harness", () => {
    const ts = generateContractTests(ast, { lang: "typescript", outDir: "sdk" });
    const vitestConfig = ts["sdk/__tests__/contract/vitest.contract.config.ts"];
    expect(vitestConfig).toContain('"__tests__/contract/streams/**/*"');
    const globalSetup = ts["sdk/__tests__/contract/global-setup.ts"];
    expect(globalSetup).toContain("harnessProcess");
  });
});
