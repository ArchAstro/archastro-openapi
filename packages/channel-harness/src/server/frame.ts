/**
 * Phoenix v2 wire frame: [join_ref, ref, topic, event, payload].
 *
 * - `join_ref` is set once per join and echoed on every subsequent frame for
 *   that topic subscription. `null` for frames not tied to a join (e.g.,
 *   heartbeats on the "phoenix" topic).
 * - `ref` correlates a client push with its reply. `null` for server-initiated
 *   pushes (broadcasts) and for `phx_close`.
 * - `event` is the message name (`phx_join`, `phx_leave`, custom events, or
 *   `phx_reply` / `phx_error` / `phx_close` for server-side frames).
 * - `payload` is the opaque JSON body.
 */
export type Frame = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

export const PHX_JOIN = "phx_join";
export const PHX_LEAVE = "phx_leave";
export const PHX_REPLY = "phx_reply";
export const PHX_ERROR = "phx_error";
export const PHX_CLOSE = "phx_close";
export const HEARTBEAT = "heartbeat";

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(raw: string | Buffer): Frame {
  const text = typeof raw === "string" ? raw : raw.toString("utf-8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    throw new FrameDecodeError(
      `expected Phoenix v2 frame [join_ref, ref, topic, event, payload], got ${JSON.stringify(parsed)}`
    );
  }
  return parsed as Frame;
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

/** Build a successful reply frame for a client push. */
export function replyOk(
  joinRef: string | null,
  ref: string,
  topic: string,
  response: unknown
): Frame {
  return [joinRef, ref, topic, PHX_REPLY, { status: "ok", response }];
}

/** Build an error reply frame for a client push. */
export function replyError(
  joinRef: string | null,
  ref: string,
  topic: string,
  response: unknown
): Frame {
  return [joinRef, ref, topic, PHX_REPLY, { status: "error", response }];
}

/** Build a server-initiated push frame (broadcast). */
export function pushFrame(
  joinRef: string | null,
  topic: string,
  event: string,
  payload: unknown
): Frame {
  return [joinRef, null, topic, event, payload];
}

/** Build a server-originated close frame. */
export function closeFrame(joinRef: string | null, topic: string): Frame {
  return [joinRef, null, topic, PHX_CLOSE, {}];
}
