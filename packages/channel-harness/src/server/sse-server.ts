/**
 * SSE request handling — the HTTP analogue of the channel transport.
 *
 * `handleSseRequest` turns an incoming HTTP request into a Server-Sent Events
 * response when the loaded spec declares a streaming route (`x-sdk-streaming`)
 * for `METHOD path`. It validates the request body, replays the registered
 * stream scenario (or synthesizes a contract-valid stream when none is set),
 * and validates every emitted event against its schema — the same
 * authoritative validation the channel server applies to pushes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { matchStreamRoute, type StreamContract } from "../spec/loader.js";
import { ContractServer, ContractViolation } from "./contract-server.js";
import type { StreamAction } from "../scenarios/stream-dsl.js";

/**
 * Serve an SSE streaming route if one matches `METHOD path`. Returns `true`
 * when a route matched and the response was written (or started); `false`
 * when no streaming route matched, so the caller can fall through to a 404.
 */
export async function handleSseRequest(
  server: ContractServer,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const match = matchStreamRoute(server.loaded.streams, req.method ?? "GET", url.pathname);
  if (!match) return false;

  const { contract } = match;
  const body = await readJsonBody(req);

  // Validate the request body like the real backend's DSL would: an invalid
  // body is a 400 before the stream opens, so the SDK's stream() rejects.
  if (server.strictMode) {
    const reqResult = server.validator.validateStreamRequest(contract.routeKey, body);
    if (!reqResult.valid) {
      sendJson(res, 400, {
        error: {
          type: "validation_error",
          code: "invalid_parameters",
          message: "Invalid parameters",
          fields: reqResult.errors,
        },
      });
      return true;
    }
  }

  // Record what the SDK actually sent so tests can assert it via /observations.
  server._recordObservation(contract.routeKey, "request", body);

  try {
    runStream(server, contract, server.lookupStreamScenario(contract.routeKey), res);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    server._recordHandlerError(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: error.message } });
    } else {
      res.end();
    }
  }
  return true;
}

function runStream(
  server: ContractServer,
  contract: StreamContract,
  actions: StreamAction[] | null,
  res: ServerResponse
): void {
  // An error-response scenario (single `status` action) short-circuits the
  // stream with a plain HTTP error — the SDK should reject before iterating.
  const statusAction = actions?.find((a) => a.type === "status");
  if (statusAction && statusAction.type === "status") {
    sendJson(res, statusAction.code, statusAction.body ?? { error: { code: statusAction.code } });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // No scenario: synthesize a contract-valid payload for each declared event,
  // in declaration order — the SSE analogue of the channel server's
  // "no handler → fixture reply".
  const effective: StreamAction[] =
    actions ?? [...contract.events.keys()].map((event) => ({ type: "autoEmit", event }));

  for (const action of effective) {
    switch (action.type) {
      case "emit":
        emit(server, contract, res, action.event, action.data, /*validated*/ true);
        break;
      case "emitRaw":
        emit(server, contract, res, action.event, action.data, /*validated*/ false);
        break;
      case "autoEmit": {
        const ev = contract.events.get(action.event);
        if (!ev) {
          throw new ContractViolation(
            `stream ${contract.routeKey} does not declare event '${action.event}'`
          );
        }
        emit(server, contract, res, action.event, server.fixtures.fromTypeRef(ev.dataType), true);
        break;
      }
      case "disconnect":
        // Abruptly drop the connection mid-stream (simulated network fault).
        res.destroy();
        return;
      case "status":
        break; // handled above
    }
  }
  res.end();
}

function emit(
  server: ContractServer,
  contract: StreamContract,
  res: ServerResponse,
  event: string,
  data: unknown,
  validated: boolean
): void {
  if (validated && server.outboundValidation) {
    if (!contract.events.has(event)) {
      throw new ContractViolation(
        `stream ${contract.routeKey} does not declare event '${event}' — use emitRaw for contract-violation tests`
      );
    }
    const r = server.validator.validateStreamEvent(contract.routeKey, event, data);
    if (!r.valid) {
      throw new ContractViolation(
        `SSE event '${event}' payload violates contract: ${r.errors.join("; ")}`
      );
    }
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}
