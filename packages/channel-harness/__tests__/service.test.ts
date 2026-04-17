/**
 * Service-path tests — prove that the HarnessService + HarnessServiceClient
 * pipeline works end-to-end over HTTP + WebSocket, with no in-process
 * shortcuts. The same code path the generated tests (and Python tests)
 * use to drive a subprocess is exercised here against an in-process service
 * instance.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelJoinError,
  ChannelReplyError,
  HarnessServiceClient,
  startHarnessService,
  type HarnessServiceHandle,
  type HarnessSocket,
} from "../src/index.js";
import { LiveDocChannel } from "./generated-sdk/src/channels/live_doc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "./fixtures/channel-harness-spec.json");

describe("HarnessService over the wire", () => {
  let service: HarnessServiceHandle;
  let client: HarnessServiceClient;
  let socket: HarnessSocket;

  beforeEach(async () => {
    service = await startHarnessService({ spec: SPEC_PATH });
    client = new HarnessServiceClient({
      wsUrl: service.wsUrl,
      controlUrl: service.controlUrl,
    });
    await client.reset();
    socket = await client.openSocket();
  });

  afterEach(async () => {
    client.closeAllSockets();
    await service.stop();
  });

  it("exposes ws and http URLs with distinct ports", () => {
    expect(service.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/socket\/websocket$/);
    expect(service.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("joins the generated SDK channel through a real WebSocket", async () => {
    const channel = await LiveDocChannel.joinDocument(socket, "doc_42", {
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

  it("applies scenarios registered via the HTTP control API", async () => {
    await client.registerScenario({
      topic: "doc:doc_42",
      onJoin: [{ type: "replyError", payload: { reason: "locked" } }],
    });

    await expect(
      LiveDocChannel.joinDocument(socket, "doc_42", { userId: "user_1" })
    ).rejects.toBeInstanceOf(ChannelJoinError);
  });

  it("delivers autoPush pushes to the generated handler", async () => {
    await client.registerScenario({
      topic: "doc:doc_42",
      onJoin: [
        { type: "autoReply" },
        { type: "autoPush", event: "user_joined" },
      ],
    });

    const channel = await LiveDocChannel.joinDocument(socket, "doc_42", {
      userId: "user_1",
    });
    const payload = await new Promise<unknown>((resolvePayload, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        reject(new Error("no push"));
      }, 500);
      unsubscribe = channel.onUserJoined((p) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolvePayload(p);
      });
      if (settled) unsubscribe();
    });

    expect(payload).toEqual({
      id: expect.any(String),
      name: expect.any(String),
    });
  });

  it("records observations visible through the HTTP control API", async () => {
    await client.registerScenario({
      topic: "doc:doc_42",
      onJoin: [{ type: "autoReply" }],
      onMessage: { edit: [{ type: "autoReply" }] },
    });
    const channel = await LiveDocChannel.joinDocument(socket, "doc_42", {
      userId: "user_1",
    });
    await channel.edit({ position: 3, text: "hi" });

    const observed = await client.observations("doc:doc_42", "edit");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.params).toEqual({ position: 3, text: "hi" });
  });

  it("rejects pushes that violate the message schema", async () => {
    await client.registerScenario({
      topic: "doc:doc_42",
      onJoin: [{ type: "autoReply" }],
    });
    const channel = await LiveDocChannel.joinDocument(socket, "doc_42", {
      userId: "user_1",
    });

    await expect(channel.edit({})).rejects.toBeInstanceOf(ChannelReplyError);
  });

  it("rejects scenario requests with invalid actions via HTTP 400", async () => {
    const res = await fetch(`${client.controlUrl}/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "doc:doc_42",
        onJoin: [{ type: "bogus_action" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scenario");
  });

  it("reset clears scenarios and observations", async () => {
    await client.registerScenario({
      topic: "doc:doc_42",
      onJoin: [{ type: "autoReply" }],
    });
    await LiveDocChannel.joinDocument(socket, "doc_42", { userId: "user_1" });
    expect((await client.observations()).length).toBeGreaterThan(0);

    await client.reset();
    expect(await client.observations()).toEqual([]);
    // After reset the topic has no scenario — joins still get a synthesized
    // reply because that's the default path.
    const channel = await LiveDocChannel.joinDocument(socket, "doc_42", {
      userId: "user_1",
    });
    expect(channel.joinResponse).toBeDefined();
  });
});
