import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  ContractServer,
  ContractViolation,
  createInProcessPair,
  startWsHarness,
  type Frame,
  type InProcessClient,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/sample-spec.json"), "utf-8")
);

const TOPIC = "api:chat:team:team_1:thread:thread_42";

interface Harness {
  server: ContractServer;
  client: InProcessClient;
}

async function makeHarness(): Promise<Harness> {
  const server = await ContractServer.fromSpec(spec);
  const pair = createInProcessPair();
  server.attach(pair.serverSide);
  return { server, client: pair.clientSide };
}

function nextServerFrame(client: InProcessClient): Promise<Frame> {
  return new Promise((resolve) => {
    const stop = client.onFrame((frame) => {
      stop();
      resolve(frame);
    });
  });
}

function collectFrames(client: InProcessClient): () => Frame[] {
  const captured: Frame[] = [];
  client.onFrame((frame) => {
    captured.push(frame);
  });
  return () => captured;
}

function joinFrame(topic: string, ref: string, payload: unknown): Frame {
  return [ref, ref, topic, "phx_join", payload];
}

function pushFrame(
  joinRef: string,
  ref: string,
  topic: string,
  event: string,
  payload: unknown
): Frame {
  return [joinRef, ref, topic, event, payload];
}

describe("ContractServer (in-process)", () => {
  describe("happy path", () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
    });

    it("accepts a valid join and replies with ok", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => {
          expect(ctx.vars).toEqual({ team_id: "team_1", thread_id: "thread_42" });
          ctx.reply({ messages: [{ id: "m1" }] });
        });
      });

      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      const reply = await nextServerFrame(harness.client);

      expect(reply[3]).toBe("phx_reply");
      expect(reply[4]).toMatchObject({ status: "ok" });
    });

    it("routes an inbound message and replies with contract-valid data", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.reply({ messages: [] }));
        s.onMessage("send_message", (ctx) => {
          expect(ctx.params).toMatchObject({ content: "hi" });
          ctx.reply({
            id: "msg_1",
            content: "hi",
            created_at: "2024-01-01T00:00:00Z",
          });
        });
      });

      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await nextServerFrame(harness.client); // drain join reply

      harness.client.send(
        pushFrame("r1", "r2", TOPIC, "send_message", { content: "hi" })
      );
      const reply = await nextServerFrame(harness.client);

      expect(reply[1]).toBe("r2");
      expect(reply[4]).toMatchObject({
        status: "ok",
        response: { id: "msg_1", content: "hi" },
      });
    });

    it("delivers server-initiated pushes on a joined topic", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => {
          ctx.reply({ messages: [] });
          ctx.push("message_added", {
            id: "m2",
            content: "hello",
            user_id: "u_1",
            created_at: "2024-01-01T00:00:00Z",
          });
        });
      });

      const frames = collectFrames(harness.client);
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 10));

      const pushed = frames().find((f) => f[3] === "message_added");
      expect(pushed).toBeDefined();
      expect(pushed?.[4]).toMatchObject({ id: "m2", user_id: "u_1" });
    });

    it("cleans up subscription on phx_leave", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.reply({ messages: [] }));
      });

      const frames = collectFrames(harness.client);
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 5));
      harness.client.send(["r1", "r2", TOPIC, "phx_leave", {}]);
      await new Promise((r) => setTimeout(r, 5));

      expect(frames().some((f) => f[1] === "r2" && f[4] && (f[4] as { status: string }).status === "ok")).toBe(true);
      expect(frames().some((f) => f[3] === "phx_close")).toBe(true);
    });
  });

  describe("inbound validation", () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
    });

    it("rejects a join whose params miss a required field", async () => {
      // Use a local spec whose required join fields are NOT topic vars —
      // topic-captured fields get stripped from the schema's required list
      // before validation (they're already in the URL), so a test that uses
      // Chat here would never trip the "missing required" path.
      const requiredSpec = {
        openapi: "3.0.0",
        info: { title: "Required", version: "1.0.0" },
        paths: {},
        components: { schemas: {} },
        "x-channels": [
          {
            name: "Room",
            joins: [
              {
                pattern: "room:{room_id}",
                name: "join",
                params: {
                  type: "object",
                  required: ["token"],
                  properties: {
                    token: { type: "string" },
                  },
                },
                returns: { type: "object" },
              },
            ],
            messages: [],
            pushes: [],
          },
        ],
      };
      const server = await ContractServer.fromSpec(requiredSpec);
      const pair = createInProcessPair();
      server.attach(pair.serverSide);
      pair.clientSide.send(joinFrame("room:r1", "r1", {})); // missing token
      const reply = await nextServerFrame(pair.clientSide);
      expect(reply[4]).toMatchObject({
        status: "error",
        response: { reason: "invalid_params" },
      });
    });

    it("rejects an unknown topic", async () => {
      harness.client.send(joinFrame("not:a:real:topic", "r1", {}));
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({ status: "error", response: { reason: "unknown_topic" } });
    });

    it("rejects a message on an unjoined topic", async () => {
      harness.client.send(pushFrame("r1", "r2", TOPIC, "send_message", { content: "hi" }));
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({ status: "error", response: { reason: "not_joined" } });
    });

    it("rejects an unknown message event", async () => {
      harness.server.scenario(TOPIC, (s) => s.onJoin((c) => c.reply({ messages: [] })));
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await nextServerFrame(harness.client);

      harness.client.send(pushFrame("r1", "r2", TOPIC, "nonexistent_event", {}));
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({
        status: "error",
        response: { reason: "unknown_event", event: "nonexistent_event" },
      });
    });

    it("rejects message params violating the contract", async () => {
      harness.server.scenario(TOPIC, (s) => s.onJoin((c) => c.reply({ messages: [] })));
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await nextServerFrame(harness.client);

      harness.client.send(pushFrame("r1", "r2", TOPIC, "send_message", {})); // missing content
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({
        status: "error",
        response: { reason: "invalid_params" },
      });
    });
  });

  describe("outbound validation", () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
    });

    it("throws ContractViolation when a scenario pushes an unknown event", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => {
          ctx.reply({ messages: [] });
          expect(() => ctx.push("not_a_push", {})).toThrow(ContractViolation);
        });
      });
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await nextServerFrame(harness.client);
    });

    it("pushRaw bypasses validation for fault-injection tests", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => {
          ctx.reply({ messages: [] });
          ctx.pushRaw("made_up_event", { anything: true });
        });
      });
      const frames = collectFrames(harness.client);
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 10));

      expect(frames().some((f) => f[3] === "made_up_event")).toBe(true);
    });
  });

  describe("failure injectors", () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
    });

    it("replyError sends an error-status reply", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.replyError({ reason: "denied" }));
      });
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({
        status: "error",
        response: { reason: "denied" },
      });
    });

    it("replyTimeout never sends a reply", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.replyTimeout());
      });
      const frames = collectFrames(harness.client);
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(frames().length).toBe(0);
    });

    it("replyRaw bypasses schema validation on replies", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.replyRaw("ok", { garbage: "payload", messages: "not-an-array" }));
      });
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      const reply = await nextServerFrame(harness.client);
      expect(reply[4]).toMatchObject({
        status: "ok",
        response: { garbage: "payload" },
      });
    });

    it("disconnect closes the transport mid-session", async () => {
      let closed = false;
      harness.client.onClose(() => {
        closed = true;
      });
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => ctx.disconnect());
      });
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 10));
      expect(closed).toBe(true);
    });

    it("closeTopic issues a server-side phx_close", async () => {
      harness.server.scenario(TOPIC, (s) => {
        s.onJoin((ctx) => {
          ctx.reply({ messages: [] });
          ctx.closeTopic();
        });
      });
      const frames = collectFrames(harness.client);
      harness.client.send(joinFrame(TOPIC, "r1", { team_id: "team_1", thread_id: "thread_42" }));
      await new Promise((r) => setTimeout(r, 10));
      expect(frames().some((f) => f[3] === "phx_close")).toBe(true);
    });
  });

  describe("heartbeat", () => {
    it("replies ok to heartbeats on the phoenix topic", async () => {
      const harness = await makeHarness();
      harness.client.send([null, "hb1", "phoenix", "heartbeat", {}]);
      const reply = await nextServerFrame(harness.client);
      expect(reply).toEqual([null, "hb1", "phoenix", "phx_reply", { status: "ok", response: {} }]);
    });
  });

  describe("fixtures", () => {
    it("exposes a fixture generator bound to the spec's schemas", async () => {
      const server = await ContractServer.fromSpec(spec);
      const msg = server.fixtures.fromTypeRef({
        kind: "object",
        fields: [
          { name: "id", type: { kind: "primitive", type: "string" }, required: true },
          { name: "created_at", type: { kind: "primitive", type: "datetime" }, required: true },
        ],
      });
      expect(msg).toMatchObject({ id: expect.any(String), created_at: expect.any(String) });
    });
  });
});

describe("ContractServer (ws)", () => {
  it("boots a real WebSocket server and speaks Phoenix v2", async () => {
    const server = await ContractServer.fromSpec(spec);
    server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => ctx.reply({ messages: [] }));
    });

    const handle = await startWsHarness(server, { port: 0 });
    try {
      const ws = new WebSocket(handle.url);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const reply = new Promise<Frame>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(
        JSON.stringify([
          "r1",
          "r1",
          TOPIC,
          "phx_join",
          { team_id: "team_1", thread_id: "thread_42" },
        ])
      );
      const ack = await reply;
      expect(ack[3]).toBe("phx_reply");
      expect(ack[4]).toMatchObject({ status: "ok" });

      ws.close();
    } finally {
      await handle.close();
    }
  });
});
