import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startHarnessService,
  type HarnessServiceHandle,
} from "../src/service/harness-service.js";

// A spec with one SSE streaming route (x-sdk-streaming) modeled on
// POST /ai/chat/completions/stream: a required request body plus two named
// event payloads (one with a required string field, to exercise validation).
const spec = {
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
                  messages: { type: "array", items: { type: "object" } },
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
        required: ["delta"],
        properties: { delta: { type: "string" } },
      },
      StreamDone: {
        type: "object",
        properties: { finish_reason: { type: "string" } },
      },
    },
  },
};

const ROUTE = "POST /api/v1/ai/chat/completions/stream";
const PATH = "/api/v1/ai/chat/completions/stream";

let service: HarnessServiceHandle;

beforeAll(async () => {
  service = await startHarnessService({ spec });
});
afterAll(async () => {
  await service.stop();
});
afterEach(async () => {
  await fetch(`${service.controlUrl}/reset`, { method: "POST" });
});

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event !== undefined) {
      out.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  return out;
}

async function postStream(body: unknown): Promise<Response> {
  return fetch(`${service.sseUrl}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function registerScenario(actions: unknown[]): Promise<void> {
  const res = await fetch(`${service.controlUrl}/stream-scenarios`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ route: ROUTE, actions }),
  });
  expect(res.status).toBe(201);
}

describe("SSE harness", () => {
  it("discovers the streaming route from x-sdk-streaming", () => {
    expect(service.server.loaded.streams.has(ROUTE)).toBe(true);
    const contract = service.server.loaded.streams.get(ROUTE)!;
    expect([...contract.events.keys()].sort()).toEqual(["done", "message_delta"]);
  });

  it("synthesizes a contract-valid stream when no scenario is registered", async () => {
    const res = await postStream({ messages: [{ role: "user" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);
    expect(names).toContain("message_delta");
    expect(names).toContain("done");
    // The synthesized message_delta satisfies the event schema (delta: string).
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(typeof (delta.data as { delta: unknown }).delta).toBe("string");
  });

  it("replays an explicit emit scenario in order", async () => {
    await registerScenario([
      { type: "emit", event: "message_delta", data: { delta: "Hel" } },
      { type: "emit", event: "message_delta", data: { delta: "lo" } },
      { type: "emit", event: "done", data: { finish_reason: "stop" } },
    ]);

    const events = parseSse(await (await postStream({ messages: [{ role: "user" }] })).text());
    expect(events).toEqual([
      { event: "message_delta", data: { delta: "Hel" } },
      { event: "message_delta", data: { delta: "lo" } },
      { event: "done", data: { finish_reason: "stop" } },
    ]);
  });

  it("rejects an invalid request body with a 400 before streaming", async () => {
    const res = await postStream({ messages: "not-an-array" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_parameters");
  });

  it("records the request body as an observation", async () => {
    await postStream({ messages: [{ role: "user", content: "hi" }] });
    const obs = (await (
      await fetch(`${service.controlUrl}/observations?topic=${encodeURIComponent(ROUTE)}`)
    ).json()) as Array<{ event: string; params: { messages: unknown[] } }>;
    expect(obs.length).toBe(1);
    expect(obs[0]!.event).toBe("request");
    expect(obs[0]!.params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("records a ContractViolation when a scenario emits an invalid payload", async () => {
    // delta must be a string; emitting a number violates the event contract.
    await registerScenario([{ type: "emit", event: "message_delta", data: { delta: 123 } }]);
    await postStream({ messages: [{ role: "user" }] });

    const errors = (await (
      await fetch(`${service.controlUrl}/handler-errors`)
    ).json()) as Array<{ name: string; message: string }>;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/violates contract/);
  });

  it("emitRaw bypasses outbound validation (fault injection)", async () => {
    await registerScenario([{ type: "emitRaw", event: "message_delta", data: { delta: 123 } }]);
    const events = parseSse(await (await postStream({ messages: [{ role: "user" }] })).text());
    expect(events).toEqual([{ event: "message_delta", data: { delta: 123 } }]);

    const errors = (await (await fetch(`${service.controlUrl}/handler-errors`)).json()) as unknown[];
    expect(errors.length).toBe(0);
  });

  it("returns a plain HTTP error for a status scenario", async () => {
    await registerScenario([
      { type: "status", code: 402, body: { error: { code: "plan_not_entitled" } } },
    ]);
    const res = await postStream({ messages: [{ role: "user" }] });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("plan_not_entitled");
  });
});
