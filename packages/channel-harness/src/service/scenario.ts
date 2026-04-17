/**
 * Scenario JSON DSL — wire-friendly counterpart to the in-process
 * `ScenarioBuilder`. Both TS and Python tests POST this to the harness
 * service's control endpoint to register per-topic handlers without passing
 * closures across a process boundary.
 *
 * The DSL is intentionally a subset of the in-process DSL: every action maps
 * to exactly one method on `JoinContext` / `MessageContext`. No user code
 * runs on the server side — the service just replays the action list when
 * the matching frame arrives.
 */

import type {
  JoinContext,
  MessageContext,
  ScenarioBuilder,
} from "../scenarios/dsl.js";

/** An action a scenario performs inside a join/message handler. */
export type ScenarioAction =
  | { type: "autoReply" }
  | { type: "reply"; payload: unknown }
  | { type: "replyError"; payload: unknown }
  | { type: "replyTimeout" }
  | { type: "replyRaw"; status: "ok" | "error"; payload: unknown }
  | { type: "push"; event: string; payload: unknown }
  | { type: "autoPush"; event: string }
  | { type: "pushRaw"; event: string; payload: unknown }
  | { type: "disconnect" }
  | { type: "closeTopic" };

/**
 * A scenario expressed as JSON. `topic` is an exact match or `"*"`.
 *
 * `onLeave` is intentionally omitted — `LeaveContext` has no reply/push
 * surface, so every `ScenarioAction` would be a no-op. Accepting it in the
 * schema would let callers POST what looks like a successful hook and get
 * silent nothing in return; reject it at validation time instead.
 */
export interface ScenarioRequest {
  topic: string;
  onJoin?: ScenarioAction[];
  onMessage?: Record<string, ScenarioAction[]>;
}

/**
 * Convert a JSON scenario into the closure-based configure function that
 * `ContractServer.scenario()` expects.
 */
export function configureFromRequest(
  req: ScenarioRequest
): (s: ScenarioBuilder) => void {
  return (s) => {
    if (req.onJoin && req.onJoin.length > 0) {
      const actions = req.onJoin;
      s.onJoin((ctx) => applyActions(ctx, actions));
    }
    if (req.onMessage) {
      for (const [event, actions] of Object.entries(req.onMessage)) {
        if (!actions || actions.length === 0) continue;
        s.onMessage(event, (ctx) => applyActions(ctx, actions));
      }
    }
  };
}

function applyActions(
  ctx: JoinContext | MessageContext,
  actions: ScenarioAction[]
): void {
  for (const a of actions) applyAction(ctx, a);
}

function applyAction(
  ctx: JoinContext | MessageContext,
  action: ScenarioAction
): void {
  switch (action.type) {
    case "autoReply":
      ctx.autoReply();
      return;
    case "reply":
      ctx.reply(action.payload);
      return;
    case "replyError":
      ctx.replyError(action.payload);
      return;
    case "replyTimeout":
      ctx.replyTimeout();
      return;
    case "replyRaw":
      ctx.replyRaw(action.status, action.payload);
      return;
    case "push":
      ctx.push(action.event, action.payload);
      return;
    case "autoPush":
      ctx.autoPush(action.event);
      return;
    case "pushRaw":
      ctx.pushRaw(action.event, action.payload);
      return;
    case "disconnect":
      ctx.disconnect();
      return;
    case "closeTopic":
      ctx.closeTopic();
      return;
  }
}

/** Runtime guard for deserialized ScenarioRequests arriving over HTTP. */
export function validateScenarioRequest(value: unknown): ScenarioRequest {
  if (!value || typeof value !== "object") {
    throw new ScenarioRequestError("scenario must be a JSON object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.topic !== "string" || v.topic.length === 0) {
    throw new ScenarioRequestError("scenario.topic must be a non-empty string");
  }
  const out: ScenarioRequest = { topic: v.topic };
  if (v.onJoin !== undefined) {
    out.onJoin = validateActions(v.onJoin, "onJoin");
  }
  if (v.onMessage !== undefined) {
    if (!v.onMessage || typeof v.onMessage !== "object") {
      throw new ScenarioRequestError("scenario.onMessage must be an object");
    }
    const onMessage: Record<string, ScenarioAction[]> = {};
    for (const [event, actions] of Object.entries(
      v.onMessage as Record<string, unknown>
    )) {
      onMessage[event] = validateActions(actions, `onMessage[${event}]`);
    }
    out.onMessage = onMessage;
  }
  if (v.onLeave !== undefined) {
    throw new ScenarioRequestError(
      "scenario.onLeave is not supported — LeaveContext has no reply/push surface"
    );
  }
  return out;
}

function validateActions(value: unknown, path: string): ScenarioAction[] {
  if (!Array.isArray(value)) {
    throw new ScenarioRequestError(`${path} must be an array`);
  }
  return value.map((a, i) => validateAction(a, `${path}[${i}]`));
}

function validateAction(value: unknown, path: string): ScenarioAction {
  if (!value || typeof value !== "object") {
    throw new ScenarioRequestError(`${path} must be an object`);
  }
  const v = value as Record<string, unknown>;
  const type = v.type;
  switch (type) {
    case "autoReply":
    case "replyTimeout":
    case "disconnect":
    case "closeTopic":
      return { type };
    case "reply":
    case "replyError":
      return { type, payload: v.payload };
    case "replyRaw":
      if (v.status !== "ok" && v.status !== "error") {
        throw new ScenarioRequestError(
          `${path}.status must be "ok" or "error"`
        );
      }
      return { type, status: v.status, payload: v.payload };
    case "push":
    case "pushRaw":
      if (typeof v.event !== "string") {
        throw new ScenarioRequestError(`${path}.event must be a string`);
      }
      return { type, event: v.event, payload: v.payload };
    case "autoPush":
      if (typeof v.event !== "string") {
        throw new ScenarioRequestError(`${path}.event must be a string`);
      }
      return { type, event: v.event };
    default:
      throw new ScenarioRequestError(
        `${path}.type '${String(type)}' is not a recognized scenario action`
      );
  }
}

export class ScenarioRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioRequestError";
  }
}
