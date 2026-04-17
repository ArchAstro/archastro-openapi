/**
 * Test-side `Socket` / `Channel` implementation backing the generated SDK.
 *
 * The TypeScript generator emits channel files that do:
 *
 *   import type { Channel } from "../phx_channel/channel.js";
 *   import type { Socket }  from "../phx_channel/socket.js";
 *
 *   const channel = socket.channel(topic);
 *   const joinResponse = await channel.join(payload);
 *   return this.channel.push(event, payload);
 *   return this.channel.on(event, callback);
 *   await this.channel.leave();
 *
 * This file implements those two interfaces against an in-process transport
 * so the same generated SDK consumers use in production can drive a
 * ContractServer in tests — no bespoke test-side client.
 */

import {
  PHX_CLOSE,
  PHX_ERROR,
  PHX_JOIN,
  PHX_LEAVE,
  type Frame,
} from "../server/frame.js";

// ─── Public types the generated SDK imports against ─────────────

export interface Channel {
  join(payload?: unknown): Promise<unknown>;
  leave(): Promise<void>;
  push(event: string, payload: unknown): Promise<unknown>;
  on(event: string, callback: (payload: unknown) => void): () => void;
}

export interface Socket {
  channel(topic: string): Channel;
}

// ─── Transport contract (matches InProcessClient) ───────────────

export interface HarnessTransport {
  send(frame: Frame): void;
  close(): void;
  onFrame(listener: (frame: Frame) => void): void | (() => void);
  onClose(listener: () => void): void | (() => void);
}

// ─── Errors ──────────────────────────────────────────────────────

export class ChannelJoinError extends Error {
  constructor(
    public readonly topic: string,
    public readonly response: unknown
  ) {
    super(`join failed for ${topic}: ${safeStringify(response)}`);
    this.name = "ChannelJoinError";
  }
}

export class ChannelReplyError extends Error {
  constructor(
    public readonly event: string,
    public readonly response: unknown
  ) {
    super(`${event} reply failed: ${safeStringify(response)}`);
    this.name = "ChannelReplyError";
  }
}

export class ChannelTimeoutError extends Error {
  constructor(public readonly what: string) {
    super(`timed out waiting for ${what}`);
    this.name = "ChannelTimeoutError";
  }
}

export class ChannelDisconnectError extends Error {
  constructor() {
    super("channel disconnected");
    this.name = "ChannelDisconnectError";
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─── Reply envelope ──────────────────────────────────────────────

interface ReplyEnvelope {
  status: "ok" | "error";
  response: unknown;
}

function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "response" in value
  );
}

// ─── Socket ──────────────────────────────────────────────────────

export interface HarnessSocketOptions {
  /** Default timeout for join/push/leave replies. Default: 1000 ms. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1000;

interface PendingEntry {
  kind: "join" | "reply";
  channel: HarnessPhxChannel;
  resolve: (envelope: ReplyEnvelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HarnessSocket implements Socket {
  private nextRefN = 1;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly channels = new Map<string, HarnessPhxChannel>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  readonly defaultTimeoutMs: number;

  constructor(
    private readonly transport: HarnessTransport,
    options: HarnessSocketOptions = {}
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    transport.onFrame((frame) => this.handleFrame(frame));
    transport.onClose(() => this.handleClose());
  }

  channel(topic: string): Channel {
    const existing = this.channels.get(topic);
    if (existing) return existing;
    const channel = new HarnessPhxChannel(this, topic);
    this.channels.set(topic, channel);
    return channel;
  }

  close(): void {
    this.transport.close();
  }

  /**
   * Register a listener that fires once when the socket closes from either
   * side. Returns an unsubscribe function. Lets callers (e.g. the harness
   * client's `liveSockets` tracker) prune references as sockets die instead
   * of leaking them until an explicit cleanup pass.
   */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      // Already closed — fire immediately so late registrations still unwind.
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  // ── internal plumbing used by HarnessPhxChannel ───────────────

  _allocRef(): string {
    return String(this.nextRefN++);
  }

  _sendAndAwait(
    channel: HarnessPhxChannel,
    kind: "join" | "reply",
    frame: Frame,
    ref: string,
    timeoutMs: number,
    label: string
  ): Promise<ReplyEnvelope> {
    if (this.closed) {
      return Promise.reject(new ChannelDisconnectError());
    }
    return new Promise<ReplyEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new ChannelTimeoutError(label));
      }, timeoutMs);
      this.pending.set(ref, { kind, channel, resolve, reject, timer });
      this.transport.send(frame);
    });
  }

  _forgetChannel(topic: string): void {
    this.channels.delete(topic);
  }

  // ── frame dispatch ────────────────────────────────────────────

  private handleFrame(frame: Frame): void {
    const [, ref, topic, event, payload] = frame;

    // phx_reply correlation — dispatch SYNCHRONOUSLY so any follow-up push
    // queued right behind the reply finds the channel already in state.
    if (event === "phx_reply" && ref) {
      const pending = this.pending.get(ref);
      if (!pending) return;
      this.pending.delete(ref);
      clearTimeout(pending.timer);
      if (!isReplyEnvelope(payload)) {
        pending.reject(
          new ChannelReplyError(
            "phx_reply",
            `malformed reply payload: ${safeStringify(payload)}`
          )
        );
        return;
      }
      pending.resolve(payload);
      return;
    }

    if (event === PHX_CLOSE) {
      const channel = this.channels.get(topic);
      if (channel) {
        this.channels.delete(topic);
        channel._onClose();
      }
      return;
    }

    if (event === PHX_ERROR) {
      this.channels.get(topic)?._onError(payload);
      return;
    }

    // Server-initiated push.
    this.channels.get(topic)?._onPush(event, payload);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ChannelDisconnectError());
    }
    this.pending.clear();
    for (const channel of this.channels.values()) channel._onClose();
    this.channels.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // Don't let a stray listener block the rest of teardown.
      }
    }
    this.closeListeners.clear();
  }
}

// ─── Channel ─────────────────────────────────────────────────────

type PushHandler = (payload: unknown) => void;

class HarnessPhxChannel implements Channel {
  private joinRef: string | null = null;
  private joinResponse: unknown = undefined;
  private readonly handlers = new Map<string, Set<PushHandler>>();
  /**
   * Pushes received before any subscriber existed. Drained the next time a
   * handler is registered for the event — lets tests register `on` after the
   * fact without losing frames.
   */
  private readonly buffer = new Map<string, unknown[]>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(payload: unknown) => void>();
  private state: "idle" | "joined" | "closed" = "idle";

  constructor(
    private readonly socket: HarnessSocket,
    public readonly topic: string
  ) {}

  async join(payload: unknown = {}): Promise<unknown> {
    if (this.state === "joined") return this.joinResponse;
    if (this.state === "closed") throw new ChannelDisconnectError();

    const ref = this.socket._allocRef();
    this.joinRef = ref;

    const envelope = await this.socket._sendAndAwait(
      this,
      "join",
      [ref, ref, this.topic, PHX_JOIN, payload],
      ref,
      this.socket.defaultTimeoutMs,
      `phx_join reply on ${this.topic}`
    );

    if (envelope.status === "error") {
      this.joinRef = null;
      this.state = "closed";
      this.socket._forgetChannel(this.topic);
      throw new ChannelJoinError(this.topic, envelope.response);
    }

    this.state = "joined";
    this.joinResponse = envelope.response;
    return envelope.response;
  }

  async push(event: string, payload: unknown): Promise<unknown> {
    if (this.state !== "joined" || this.joinRef === null) {
      throw new ChannelDisconnectError();
    }
    const ref = this.socket._allocRef();
    const envelope = await this.socket._sendAndAwait(
      this,
      "reply",
      [this.joinRef, ref, this.topic, event, payload],
      ref,
      this.socket.defaultTimeoutMs,
      `${event} reply on ${this.topic}`
    );
    if (envelope.status === "error") {
      throw new ChannelReplyError(event, envelope.response);
    }
    return envelope.response;
  }

  on(event: string, handler: PushHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    const unsubscribe = () => set!.delete(handler);

    // Drain any pushes that arrived before this handler registered. Stop
    // if the handler unsubscribes mid-flush (e.g., nextPush).
    const buffered = this.buffer.get(event);
    if (buffered) {
      while (buffered.length > 0 && set.has(handler)) {
        handler(buffered.shift()!);
      }
      if (buffered.length === 0) this.buffer.delete(event);
    }

    return unsubscribe;
  }

  async leave(): Promise<void> {
    if (this.state !== "joined" || this.joinRef === null) return;
    const ref = this.socket._allocRef();
    this.state = "closed";
    try {
      await this.socket._sendAndAwait(
        this,
        "reply",
        [this.joinRef, ref, this.topic, PHX_LEAVE, {}],
        ref,
        this.socket.defaultTimeoutMs,
        `phx_leave ack on ${this.topic}`
      );
    } finally {
      this.socket._forgetChannel(this.topic);
    }
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (payload: unknown) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  // ── internal (called by HarnessSocket) ────────────────────────

  _onPush(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (set && set.size > 0) {
      for (const h of set) h(payload);
      return;
    }
    let buf = this.buffer.get(event);
    if (!buf) {
      buf = [];
      this.buffer.set(event, buf);
    }
    buf.push(payload);
  }

  _onClose(): void {
    this.state = "closed";
    for (const h of this.closeHandlers) h();
  }

  _onError(payload: unknown): void {
    for (const h of this.errorHandlers) h(payload);
  }
}

export type { HarnessPhxChannel };
