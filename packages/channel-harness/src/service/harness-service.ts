/**
 * HarnessService — the single process that language-agnostic tests talk to.
 *
 * Exposes two surfaces:
 *
 *  - A **WebSocket** endpoint (`startWsHarness`) carrying the real Phoenix
 *    channel protocol. Generated SDKs connect here to exercise their own
 *    channel classes end-to-end.
 *
 *  - An **HTTP control** endpoint for scenario management, observation
 *    queries, and lifecycle. Tests POST JSON scenarios here instead of
 *    registering closures, which is what lets Python (or any other runtime)
 *    drive the same `ContractServer` that backs the TS tests.
 *
 * Both surfaces sit on top of a single `ContractServer` so validation +
 * fixture generation stay authoritative regardless of which language
 * registered a scenario.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ContractServer, type ContractServerOptions } from "../server/contract-server.js";
import {
  startWsHarness,
  type WsHarnessHandle,
  type WsHarnessOptions,
} from "../server/socket-server.js";
import {
  configureFromRequest,
  validateScenarioRequest,
  ScenarioRequestError,
} from "./scenario.js";

export interface HarnessServiceOptions {
  /** Where to read the OpenAPI spec from. Path or in-memory object. */
  spec: string | Record<string, unknown>;
  /** WebSocket bind options. */
  ws?: WsHarnessOptions;
  /** HTTP control server bind options. */
  control?: {
    /** Listen port. 0 = ephemeral (default). */
    port?: number;
    /** Listen host. Defaults to 127.0.0.1. */
    host?: string;
  };
  /** ContractServer options (strict mode, outbound validation). */
  contract?: ContractServerOptions;
}

export interface HarnessServiceHandle {
  /** URL for SDK traffic, e.g. `ws://127.0.0.1:51234/socket/websocket`. */
  wsUrl: string;
  /** Base URL for the HTTP control API, e.g. `http://127.0.0.1:51235`. */
  controlUrl: string;
  /** Underlying ContractServer (for in-process callers only). */
  server: ContractServer;
  /** Stop the WS + HTTP servers and drop every active connection. */
  stop(): Promise<void>;
}

/**
 * Boot a `ContractServer` from a spec and expose it over WebSocket + HTTP.
 * Use `stop()` to tear everything down.
 */
export async function startHarnessService(
  options: HarnessServiceOptions
): Promise<HarnessServiceHandle> {
  const server = await ContractServer.fromSpec(options.spec, options.contract);
  const wsHandle = await startWsHarness(server, options.ws ?? { port: 0 });
  const controlHandle = await startControlServer(server, wsHandle, options.control ?? {});

  return {
    wsUrl: wsHandle.url,
    controlUrl: controlHandle.url,
    server,
    async stop() {
      await controlHandle.close();
      await wsHandle.close();
      server.closeAll();
    },
  };
}

// ─── HTTP control server ─────────────────────────────────────────

interface ControlHandle {
  url: string;
  close(): Promise<void>;
}

async function startControlServer(
  server: ContractServer,
  ws: WsHarnessHandle,
  opts: { port?: number; host?: string }
): Promise<ControlHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const http: Server = createServer((req, res) => {
    handleRequest(server, ws, req, res).catch((err: unknown) => {
      console.error("[harness-service] control request failed:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: String(err) });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("listening", () => resolve());
    http.once("error", reject);
    http.listen(port, host);
  });
  const addr = http.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    close() {
      return new Promise<void>((resolve, reject) => {
        // Force-close keep-alive sockets so HarnessServiceClient teardown
        // doesn't hang on an idle connection.
        http.closeAllConnections?.();
        http.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleRequest(
  server: ContractServer,
  ws: WsHarnessHandle,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, wsUrl: ws.url });
    return;
  }

  if (req.method === "POST" && path === "/scenarios") {
    const body = await readJsonBody(req);
    let parsed;
    try {
      parsed = validateScenarioRequest(body);
    } catch (err) {
      if (err instanceof ScenarioRequestError) {
        sendJson(res, 400, { error: "invalid_scenario", message: err.message });
        return;
      }
      throw err;
    }
    try {
      server.scenario(parsed.topic, configureFromRequest(parsed));
    } catch (err) {
      sendJson(res, 409, {
        error: "scenario_conflict",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    sendJson(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/reset") {
    server.reset();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && path === "/observations") {
    const topic = url.searchParams.get("topic") ?? undefined;
    const event = url.searchParams.get("event") ?? undefined;
    sendJson(res, 200, server.observations(topic, event));
    return;
  }

  if (req.method === "GET" && path === "/handler-errors") {
    sendJson(
      res,
      200,
      server.handlerErrors.map((e) => ({
        name: e.name,
        message: e.message,
        stack: e.stack,
      }))
    );
    return;
  }

  sendJson(res, 404, { error: "not_found", path });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ScenarioRequestError(
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}
