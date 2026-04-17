import { WebSocketServer, type WebSocket } from "ws";
import { type AddressInfo } from "node:net";
import { decodeFrame, encodeFrame, FrameDecodeError, type Frame } from "./frame.js";
import type { ContractServer, Transport } from "./contract-server.js";

export interface WsHarnessOptions {
  /** Listen port. 0 = ephemeral. */
  port?: number;
  /** Listen host. Defaults to 127.0.0.1. */
  host?: string;
  /** URL path the server accepts connections on. Defaults to "/socket/websocket". */
  path?: string;
}

export interface WsHarnessHandle {
  /** ws://host:port + path — ready to feed to a Phoenix Socket client. */
  url: string;
  /** Resolved port (useful when `port: 0`). */
  port: number;
  /** Close the server and drop all connections. */
  close(): Promise<void>;
}

/**
 * Start a real WebSocket server bound to the given ContractServer.
 * Each incoming connection becomes a Transport that the server attaches.
 */
export async function startWsHarness(
  server: ContractServer,
  opts: WsHarnessOptions = {}
): Promise<WsHarnessHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const path = opts.path ?? "/socket/websocket";

  const wss = new WebSocketServer({ host, port, path });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  wss.on("connection", (ws) => {
    const transport = wrapWebSocket(ws);
    server.attach(transport);
  });

  const address = wss.address() as AddressInfo;
  const resolvedPort = address.port;

  return {
    url: `ws://${host}:${resolvedPort}${path}`,
    port: resolvedPort,
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function wrapWebSocket(ws: WebSocket): Transport {
  const frameListeners = new Set<(frame: Frame) => void>();
  const closeListeners = new Set<() => void>();

  ws.on("message", (data) => {
    let frame: Frame;
    try {
      frame = decodeFrame(
        typeof data === "string" ? data : (data as Buffer).toString("utf-8")
      );
    } catch (err) {
      if (err instanceof FrameDecodeError) return; // ignore malformed input
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
      ws.close();
    },
    onFrame(listener) {
      frameListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
  };
}
