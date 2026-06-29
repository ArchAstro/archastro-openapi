/**
 * SSE stream scenarios — the streaming analogue of the channel scenario DSL.
 *
 * A channel scenario replays push/reply actions when a frame arrives; a stream
 * scenario replays a sequence of SSE *emit* actions (plus terminal faults) when
 * a request hits a streaming route. Like the channel JSON DSL, every action is
 * pure data so the same scenario can be registered in-process (TS) or over the
 * HTTP control API (any language) — no closures cross the boundary.
 */

/** An action a stream scenario performs while responding to a request. */
export type StreamAction =
  /** Emit a named SSE event with the given payload (validated against the
   * route's event schema). */
  | { type: "emit"; event: string; data: unknown }
  /** Emit a named SSE event whose payload is synthesized from the event
   * schema — the SSE analogue of `autoPush`. */
  | { type: "autoEmit"; event: string }
  /** Emit a named SSE event WITHOUT outbound validation, for fault injection. */
  | { type: "emitRaw"; event: string; data: unknown }
  /** Respond with a plain HTTP error status instead of a stream (e.g. 401/402)
   * — exercises the SDK's pre-stream error path. Must be the sole action. */
  | { type: "status"; code: number; body?: unknown }
  /** Abruptly close the response mid-stream after the preceding emits. */
  | { type: "disconnect" };
