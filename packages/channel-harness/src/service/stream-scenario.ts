/**
 * Wire-friendly validation for SSE stream scenarios POSTed to the harness
 * control API (`POST /stream-scenarios`). The streaming counterpart to
 * `service/scenario.ts`: every action is plain data the server replays when a
 * request hits the route — no closures cross the process boundary.
 */

import type { StreamAction } from "../scenarios/stream-dsl.js";

/** A stream scenario expressed as JSON. `route` is `"METHOD /path"` or `"*"`. */
export interface StreamScenarioRequest {
  route: string;
  actions: StreamAction[];
}

/** Runtime guard for deserialized StreamScenarioRequests arriving over HTTP. */
export function validateStreamScenarioRequest(value: unknown): StreamScenarioRequest {
  if (!value || typeof value !== "object") {
    throw new StreamScenarioRequestError("stream scenario must be a JSON object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.route !== "string" || v.route.length === 0) {
    throw new StreamScenarioRequestError("stream scenario.route must be a non-empty string");
  }
  if (!Array.isArray(v.actions)) {
    throw new StreamScenarioRequestError("stream scenario.actions must be an array");
  }
  const actions = v.actions.map((a, i) => validateStreamAction(a, `actions[${i}]`));
  return { route: v.route, actions };
}

function validateStreamAction(value: unknown, path: string): StreamAction {
  if (!value || typeof value !== "object") {
    throw new StreamScenarioRequestError(`${path} must be an object`);
  }
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "disconnect":
      return { type: "disconnect" };
    case "autoEmit":
      requireEvent(v, path);
      return { type: "autoEmit", event: v.event as string };
    case "emit":
    case "emitRaw":
      requireEvent(v, path);
      return { type: v.type, event: v.event as string, data: v.data };
    case "status":
      if (typeof v.code !== "number") {
        throw new StreamScenarioRequestError(`${path}.code must be a number`);
      }
      return { type: "status", code: v.code, body: v.body };
    default:
      throw new StreamScenarioRequestError(
        `${path}.type '${String(v.type)}' is not a recognized stream action`
      );
  }
}

function requireEvent(v: Record<string, unknown>, path: string): void {
  if (typeof v.event !== "string" || v.event.length === 0) {
    throw new StreamScenarioRequestError(`${path}.event must be a non-empty string`);
  }
}

export class StreamScenarioRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamScenarioRequestError";
  }
}
