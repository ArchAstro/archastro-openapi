/**
 * HarnessServiceClient — the TS-side handle that tests use to talk to a
 * running `HarnessService`, whether the service lives in the same process
 * or in a subprocess spawned by the vitest globalSetup.
 *
 * All scenario/observation traffic goes through HTTP; all SDK traffic goes
 * through a real WebSocket. There is no in-process shortcut — the generated
 * tests exercise the same wire paths Python (or any other language) would.
 */

import WebSocket from "ws";
import {
  HarnessSocket,
  type HarnessSocketOptions,
  type HarnessTransport,
} from "../client/phx-adapter.js";
import {
  decodeFrame,
  encodeFrame,
  FrameDecodeError,
  type Frame,
} from "../server/frame.js";
import type { Observation } from "../server/contract-server.js";
import type { ScenarioRequest } from "./scenario.js";

export interface HarnessServiceClientOptions {
  /** `ws://host:port/socket/websocket` — the SDK traffic endpoint. */
  wsUrl: string;
  /** `http://host:port` — the control API root. */
  controlUrl: string;
  /** Default HarnessSocket timeout for replies. */
  socketTimeoutMs?: number;
}

export interface HandlerErrorReport {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Thin client over the harness service's HTTP control API + WebSocket.
 * One instance per test file is typical; `openSocket()` may be called many
 * times for isolated SDK connections.
 */
export class HarnessServiceClient {
  readonly wsUrl: string;
  readonly controlUrl: string;
  private readonly socketTimeoutMs?: number;
  private readonly liveSockets = new Set<HarnessSocket>();

  constructor(options: HarnessServiceClientOptions) {
    this.wsUrl = options.wsUrl;
    this.controlUrl = options.controlUrl.replace(/\/$/, "");
    this.socketTimeoutMs = options.socketTimeoutMs;
  }

  /** Register a scenario for an exact topic. */
  async registerScenario(scenario: ScenarioRequest): Promise<void> {
    const res = await fetch(`${this.controlUrl}/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scenario),
    });
    if (!res.ok) {
      throw new Error(
        `registerScenario(${scenario.topic}) failed: ${res.status} ${await res.text()}`
      );
    }
  }

  /** Clear every scenario, observation, and handler error. */
  async reset(): Promise<void> {
    const res = await fetch(`${this.controlUrl}/reset`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`reset failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Fetch inbound frames observed by the server that passed validation. */
  async observations(
    topic?: string,
    event?: string
  ): Promise<Observation[]> {
    const url = new URL(`${this.controlUrl}/observations`);
    if (topic !== undefined) url.searchParams.set("topic", topic);
    if (event !== undefined) url.searchParams.set("event", event);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(
        `observations failed: ${res.status} ${await res.text()}`
      );
    }
    return (await res.json()) as Observation[];
  }

  /** Fetch scenario handler errors recorded by the server. */
  async handlerErrors(): Promise<HandlerErrorReport[]> {
    const res = await fetch(`${this.controlUrl}/handler-errors`);
    if (!res.ok) {
      throw new Error(
        `handlerErrors failed: ${res.status} ${await res.text()}`
      );
    }
    return (await res.json()) as HandlerErrorReport[];
  }

  /**
   * Open a `HarnessSocket` against the service. Every call produces a fresh
   * WebSocket connection — the generated SDK receives the same `Socket`
   * shape it would in production.
   */
  async openSocket(
    options: HarnessSocketOptions = {}
  ): Promise<HarnessSocket> {
    const transport = await createWsTransport(this.wsUrl);
    const socket = new HarnessSocket(transport, {
      defaultTimeoutMs: options.defaultTimeoutMs ?? this.socketTimeoutMs,
    });
    this.liveSockets.add(socket);
    // Prune the tracking set on natural close (server disconnect, remote
    // end closing) so a long-running client doesn't accumulate dead
    // references. `closeAllSockets()` still catches anything that's still
    // alive at teardown.
    socket.onClose(() => {
      this.liveSockets.delete(socket);
    });
    return socket;
  }

  /** Close every socket opened through this client. */
  closeAllSockets(): void {
    for (const s of this.liveSockets) s.close();
    this.liveSockets.clear();
  }
}

// ─── WebSocket-backed HarnessTransport ──────────────────────────

/**
 * Adapter that wraps a `ws` client connection in the `HarnessTransport`
 * interface the `HarnessSocket` expects. Malformed frames are dropped
 * silently to match the server-side behavior.
 */
export async function createWsTransport(
  url: string
): Promise<HarnessTransport> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  const frameListeners = new Set<(frame: Frame) => void>();
  const closeListeners = new Set<() => void>();

  ws.on("message", (data) => {
    let frame: Frame;
    try {
      frame = decodeFrame(
        typeof data === "string" ? data : (data as Buffer).toString("utf-8")
      );
    } catch (err) {
      if (err instanceof FrameDecodeError) return;
      throw err;
    }
    for (const l of frameListeners) l(frame);
  });

  ws.on("close", () => {
    for (const l of closeListeners) l();
  });

  return {
    send(frame) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(encodeFrame(frame));
    },
    close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    },
    onFrame(listener) {
      frameListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
  };
}
