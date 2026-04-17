/**
 * End-to-end contract tests for the LiveDoc fake API.
 *
 * These drive the GENERATED SDK channel class — `LiveDocChannel` — against a
 * `ContractServer` booted from the same spec the SDK was generated from.
 * The harness's `HarnessSocket` satisfies the `Socket`/`Channel` types the
 * generator emits, so there is no separate test-side client: the tests use
 * the exact API real SDK consumers will use.
 *
 * The sample SDK under `__tests__/generated-sdk/` is regenerated before
 * every `vitest run` by the globalSetup in vitest.config.ts — it is NOT
 * checked in. See __tests__/setup/regenerate-sample-sdk.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  ChannelDisconnectError,
  ChannelJoinError,
  ChannelReplyError,
  ChannelTimeoutError,
  ContractServer,
  ContractViolation,
  startWsHarness,
  type Frame,
  type HarnessSocket,
  type WsHarnessHandle,
} from "../src/index.js";
import { LiveDocChannel } from "./generated-sdk/src/channels/live_doc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "./fixtures/channel-harness-spec.json");

const DOC_ID = "doc_42";
const TOPIC = `doc:${DOC_ID}`;

interface Rig {
  server: ContractServer;
  socket: HarnessSocket;
}

async function bootHarness(): Promise<Rig> {
  const server = await ContractServer.fromSpec(SPEC_PATH);
  const socket = server.connectSocket();
  return { server, socket };
}

function nextPush(
  subscribe: (cb: (payload: unknown) => void) => () => void,
  timeoutMs = 500
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error("push not received in time"));
    }, timeoutMs);

    unsubscribe = subscribe((payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(payload);
    });
    // `subscribe` may have drained a buffered push synchronously before
    // `unsubscribe` was assigned — clean up now if so.
    if (settled) unsubscribe();
  });
}

// ─── happy path ──────────────────────────────────────────────────

describe("LiveDoc contract — happy path", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootHarness();
  });

  it("joins via the generated SDK and receives a spec-valid reply", async () => {
    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });

    expect(channel.joinResponse).toEqual({
      document: {
        id: expect.any(String),
        content: expect.any(String),
        version: expect.any(Number),
      },
      collaborators: expect.any(Array),
    });
  });

  it("pushes an edit via the generated .edit() method", async () => {
    rig.server.scenario(TOPIC, (s) => s.onJoin((ctx) => ctx.autoReply()));

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    const reply = await channel.edit({ position: 0, text: "hi" });

    expect(reply).toEqual({ version: expect.any(Number) });
  });

  it("lets a scenario assert inbound params while auto-replying", async () => {
    let observed: unknown = null;

    rig.server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => ctx.autoReply());
      s.onMessage("edit", (ctx) => {
        observed = ctx.params;
        ctx.autoReply();
      });
    });

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    await channel.edit({ position: 4, text: "yo" });

    expect(observed).toEqual({ position: 4, text: "yo" });
  });

  it("receives user_joined via the generated onUserJoined handler", async () => {
    rig.server.scenario(TOPIC, (s) =>
      s.onJoin((ctx) => {
        ctx.autoReply();
        ctx.autoPush("user_joined");
      })
    );

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    const payload = await nextPush((cb) => channel.onUserJoined(cb));

    // Driven by the spec's User schema via $ref.
    expect(payload).toEqual({
      id: expect.any(String),
      name: expect.any(String),
    });
  });

  it("receives edit_applied via the generated onEditApplied handler", async () => {
    rig.server.scenario(TOPIC, (s) =>
      s.onJoin((ctx) => {
        ctx.autoReply();
        ctx.autoPush("edit_applied");
      })
    );

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    const payload = await nextPush((cb) => channel.onEditApplied(cb));

    expect(payload).toEqual({
      user_id: expect.any(String),
      position: expect.any(Number),
      text: expect.any(String),
      version: expect.any(Number),
    });
  });

  it("leaves cleanly through the generated leave() method", async () => {
    rig.server.scenario(TOPIC, (s) => s.onJoin((ctx) => ctx.autoReply()));

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    await channel.leave();
  });
});

// ─── contract violations (client side) ───────────────────────────

describe("LiveDoc contract — inbound validation", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootHarness();
  });

  it("join rejects when required userId param is missing", async () => {
    await expect(
      // @ts-expect-error — deliberately violating the generated type to prove
      // the server enforces the contract regardless of TS-level guards.
      LiveDocChannel.joinDocument(rig.socket, DOC_ID, {})
    ).rejects.toBeInstanceOf(ChannelJoinError);
  });

  it("edit push rejects when required position is missing", async () => {
    rig.server.scenario(TOPIC, (s) => s.onJoin((ctx) => ctx.autoReply()));
    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });

    await expect(channel.edit({ text: "oops" })).rejects.toBeInstanceOf(
      ChannelReplyError
    );
  });
});

// ─── contract violations (server side) ───────────────────────────

describe("LiveDoc contract — outbound validation", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootHarness();
  });

  it("throws ContractViolation synchronously when a scenario replies with an invalid Document", async () => {
    rig.server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => {
        expect(() =>
          ctx.reply({ document: { id: DOC_ID }, collaborators: [] })
        ).toThrow(ContractViolation);
      });
    });

    // The handler swallows the ContractViolation via `expect.toThrow`, so no
    // reply is ever sent — the client times out.
    await expect(
      LiveDocChannel.joinDocument(rig.socket, DOC_ID, { userId: "user_1" })
    ).rejects.toBeInstanceOf(ChannelTimeoutError);

    // Nothing escaped the handler, so no unhandled error was recorded.
    expect(rig.server.handlerErrors).toHaveLength(0);
  });

  it("propagates an unhandled ContractViolation from a scenario — client fails fast, error is surfaced on server.handlerErrors", async () => {
    rig.server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => {
        // Not wrapped in expect.toThrow — the throw escapes the handler.
        ctx.reply({ document: { id: DOC_ID }, collaborators: [] });
      });
    });

    // Transport closes → client rejects with DisconnectError, not a timeout.
    await expect(
      LiveDocChannel.joinDocument(rig.socket, DOC_ID, { userId: "user_1" })
    ).rejects.toBeInstanceOf(ChannelDisconnectError);

    // The actual error type is preserved for inspection.
    expect(rig.server.handlerErrors).toHaveLength(1);
    expect(rig.server.handlerErrors[0]).toBeInstanceOf(ContractViolation);
  });

  it("throws ContractViolation when a scenario pushes an undeclared event", async () => {
    rig.server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => {
        ctx.autoReply();
        expect(() => ctx.push("document_deleted", {})).toThrow(
          ContractViolation
        );
      });
    });

    // Join still succeeds because autoReply fires before the violating push.
    await LiveDocChannel.joinDocument(rig.socket, DOC_ID, { userId: "user_1" });
  });
});

// ─── failure-mode scenarios ──────────────────────────────────────

describe("LiveDoc contract — failure injection", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootHarness();
  });

  it("surfaces an application-level error reply as ChannelJoinError", async () => {
    rig.server.scenario(TOPIC, (s) =>
      s.onJoin((ctx) => ctx.replyError({ reason: "document_locked" }))
    );

    const err = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelJoinError);
    expect((err as ChannelJoinError).response).toEqual({
      reason: "document_locked",
    });
  });

  it("times out when the server never replies to a join", async () => {
    rig.server.scenario(TOPIC, (s) => s.onJoin((ctx) => ctx.replyTimeout()));

    // Dedicated socket with a tight timeout so we don't wait on the default.
    const socket = rig.server.connectSocket({ defaultTimeoutMs: 20 });
    await expect(
      LiveDocChannel.joinDocument(socket, DOC_ID, { userId: "user_1" })
    ).rejects.toBeInstanceOf(ChannelTimeoutError);
  });

  it("rejects an in-flight push with ChannelDisconnectError when the server disconnects", async () => {
    rig.server.scenario(TOPIC, (s) => {
      s.onJoin((ctx) => ctx.autoReply());
      s.onMessage("edit", (ctx) => ctx.disconnect());
    });

    const channel = await LiveDocChannel.joinDocument(rig.socket, DOC_ID, {
      userId: "user_1",
    });
    await expect(
      channel.edit({ position: 0, text: "x" })
    ).rejects.toBeInstanceOf(ChannelDisconnectError);
  });
});

// ─── real WebSocket end-to-end ───────────────────────────────────
//
// Kept as a raw-frame test to prove the wire protocol actually works over
// a network socket. Every other test uses the generated SDK.

describe("LiveDoc contract — over a real WebSocket", () => {
  let server: ContractServer;
  let handle: WsHarnessHandle;

  beforeEach(async () => {
    server = await ContractServer.fromSpec(SPEC_PATH);
    handle = await startWsHarness(server, { port: 0 });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("accepts a real websocket connection and auto-generates a contract-valid join reply", async () => {
    const ws = new WebSocket(handle.url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const reply = new Promise<Frame>((resolve) =>
      ws.once("message", (data) => resolve(JSON.parse(data.toString())))
    );
    ws.send(
      JSON.stringify([
        "r1",
        "r1",
        TOPIC,
        "phx_join",
        { userId: "user_1" },
      ])
    );
    const ack = await reply;
    expect(ack[3]).toBe("phx_reply");
    const body = ack[4] as {
      status: string;
      response: { document: { id: string; version: number } };
    };
    expect(body.status).toBe("ok");
    expect(body.response.document).toEqual({
      id: expect.any(String),
      content: expect.any(String),
      version: expect.any(Number),
    });
    ws.close();
  });
});
