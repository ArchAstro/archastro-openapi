import { loadSpec, type LoadedSpec } from "../spec/loader.js";
import { buildValidator, type ChannelValidator } from "../spec/validator.js";
import { FixtureGenerator } from "../fixtures/generator.js";
import {
  HarnessSocket,
  type HarnessSocketOptions,
} from "../client/phx-adapter.js";
import { createInProcessPair } from "./in-process-socket.js";
import {
  closeFrame,
  decodeFrame,
  encodeFrame,
  HEARTBEAT,
  PHX_CLOSE,
  PHX_ERROR,
  PHX_JOIN,
  PHX_LEAVE,
  pushFrame,
  replyError,
  replyOk,
  type Frame,
} from "./frame.js";
import { resolveTopic, type TopicMatch } from "./router.js";
import {
  makeScenarioBuilder,
  type JoinContext,
  type MessageContext,
  type ScenarioBuilder,
  type ScenarioDefinition,
} from "../scenarios/dsl.js";

export interface ContractServerOptions {
  /**
   * When true (default), inbound frames that violate the contract (unknown
   * topic, unknown event, schema mismatch) are rejected with phx_error.
   * When false, they are passed through to handlers for bespoke handling.
   */
  strict?: boolean;
  /**
   * When true (default), outbound payloads go through validators and throw
   * on contract violations. Tests that want to deliberately emit bad data
   * must use the `*Raw` methods on the context.
   */
  validateOutbound?: boolean;
}

export interface Transport {
  /** Deliver a frame from server → client. */
  send(frame: Frame): void;
  /** Close the transport. Any in-flight server pushes should be dropped. */
  close(): void;
  /** Register a handler invoked for every raw frame received from the client. */
  onFrame(listener: (frame: Frame) => void): void;
  /** Register a handler invoked when the transport closes from either side. */
  onClose(listener: () => void): void;
}

interface Subscription {
  topic: string;
  match: TopicMatch;
  joinRef: string;
  scenario: ScenarioDefinition;
  vars: Record<string, string>;
}

/** A captured inbound message that passed validation. */
export interface Observation {
  topic: string;
  /** `"phx_join"` for joins, otherwise the inbound event name. */
  event: string;
  params: unknown;
  /** Millisecond timestamp the frame was observed. */
  ts: number;
}

/**
 * A contract-testing server backed by an OpenAPI spec with x-channels.
 * Bind it to any transport (ws or in-process) to simulate a compliant —
 * or deliberately broken — channel backend.
 */
export class ContractServer {
  readonly loaded: LoadedSpec;
  readonly validator: ChannelValidator;
  readonly fixtures: FixtureGenerator;
  private readonly strict: boolean;
  private readonly validateOutbound: boolean;
  private readonly scenarios = new Map<string, ScenarioDefinition>();
  private readonly transports = new Set<TransportSession>();
  private readonly _handlerErrors: Error[] = [];
  private readonly _observations: Observation[] = [];

  private constructor(loaded: LoadedSpec, opts: ContractServerOptions) {
    this.loaded = loaded;
    this.validator = buildValidator(loaded);
    this.fixtures = new FixtureGenerator(loaded.ast);
    this.strict = opts.strict ?? true;
    this.validateOutbound = opts.validateOutbound ?? true;
  }

  static async fromSpec(
    source: string | Record<string, unknown>,
    opts: ContractServerOptions = {}
  ): Promise<ContractServer> {
    const loaded = loadSpec(source);
    return new ContractServer(loaded, opts);
  }

  /**
   * Register a scenario for an exact topic pattern. The pattern may contain
   * `{var}` placeholders; any topic that matches a channel's join pattern
   * and also matches this scenario pattern will be routed to this scenario.
   *
   * Wildcard scenario pattern `*` matches any topic.
   */
  scenario(
    topicPattern: string,
    configure: (builder: ScenarioBuilder) => void
  ): this {
    if (this.scenarios.has(topicPattern)) {
      throw new Error(
        `ContractServer.scenario(${JSON.stringify(topicPattern)}) is already registered — call once per topic, per test.`
      );
    }
    const def: ScenarioDefinition = {
      joinHandler: null,
      messageHandlers: new Map(),
      leaveHandler: null,
    };
    configure(makeScenarioBuilder(def));
    this.scenarios.set(topicPattern, def);
    return this;
  }

  /**
   * Clear every scenario, observation, and recorded handler error. Designed
   * for between-test cleanup when the same server is reused across cases
   * (e.g. via the harness service's HTTP control endpoint).
   *
   * Does not close existing transports — an active socket can keep talking
   * to the server on the default synthesized-reply path after a reset.
   */
  reset(): void {
    this.scenarios.clear();
    this._observations.length = 0;
    this._handlerErrors.length = 0;
  }

  /** Attach a transport (any duplex frame source) to this server. */
  attach(transport: Transport): void {
    const session = new TransportSession(this, transport);
    this.transports.add(session);
    transport.onClose(() => {
      this.transports.delete(session);
    });
  }

  /**
   * Connect a `Socket`-shaped adapter. Lets a generated SDK channel class
   * consume this server as if it were a real Phoenix socket. Options are
   * passed through to the underlying HarnessSocket.
   */
  connectSocket(options: HarnessSocketOptions = {}): HarnessSocket {
    const pair = createInProcessPair();
    this.attach(pair.serverSide);
    return new HarnessSocket(pair.clientSide, options);
  }

  /** Close every attached transport. */
  closeAll(): void {
    for (const s of this.transports) s.close();
    this.transports.clear();
  }

  /**
   * Errors thrown by scenario handlers that were not caught locally (e.g.,
   * by `expect().toThrow(...)`). Populated in arrival order. Tests should
   * assert this is empty in afterEach, or inspect it to verify that an
   * expected handler-side exception actually fired.
   */
  get handlerErrors(): readonly Error[] {
    return this._handlerErrors;
  }

  /**
   * Every inbound frame that passed contract validation, in arrival order.
   * Tests that run against a remote service (no shared closures) fetch this
   * to assert what the SDK actually put on the wire — replacing the
   * `observed = ctx.params` pattern used by in-process tests.
   */
  observations(topic?: string, event?: string): readonly Observation[] {
    if (!topic && !event) return this._observations;
    return this._observations.filter(
      (o) =>
        (topic === undefined || o.topic === topic) &&
        (event === undefined || o.event === event)
    );
  }

  /** Internal — called by TransportSession when a scenario handler throws. */
  _recordHandlerError(err: Error): void {
    this._handlerErrors.push(err);
  }

  /** Internal — called once an inbound frame is validated. */
  _recordObservation(topic: string, event: string, params: unknown): void {
    this._observations.push({ topic, event, params, ts: Date.now() });
  }

  // ── internal: scenario resolution ──────────────────────────────
  lookupScenario(topic: string): ScenarioDefinition | null {
    const exact = this.scenarios.get(topic);
    if (exact) return exact;
    const wildcard = this.scenarios.get("*");
    if (wildcard) return wildcard;
    return null;
  }

  get strictMode(): boolean {
    return this.strict;
  }

  get outboundValidation(): boolean {
    return this.validateOutbound;
  }
}

/**
 * Per-transport state. Tracks active subscriptions (one per topic) and
 * routes frames through the validator + scenario handlers.
 */
class TransportSession {
  private readonly subs = new Map<string, Subscription>();
  private closed = false;

  constructor(
    private readonly server: ContractServer,
    private readonly transport: Transport
  ) {
    transport.onFrame((frame) => {
      this.handleFrame(frame).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        // Record on the server so tests can assert (`server.handlerErrors`),
        // log with a clear header, then close the transport so the client's
        // pending ops reject with `ChannelDisconnectError` instead of
        // hanging until a timeout.
        this.server._recordHandlerError(error);
        console.error(
          "[contract-server] scenario handler threw — closing transport:",
          error
        );
        this.closed = true;
        this.transport.close();
      });
    });
    transport.onClose(() => {
      this.closed = true;
    });
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }

  private async handleFrame(frame: Frame): Promise<void> {
    if (this.closed) return;
    const [joinRef, ref, topic, event, payload] = frame;

    if (topic === "phoenix" && event === HEARTBEAT) {
      if (ref) {
        this.transport.send([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]);
      }
      return;
    }

    switch (event) {
      case PHX_JOIN:
        await this.handleJoin(joinRef, ref, topic, payload);
        return;
      case PHX_LEAVE:
        await this.handleLeave(joinRef, ref, topic);
        return;
      default:
        await this.handleMessage(joinRef, ref, topic, event, payload);
    }
  }

  private async handleJoin(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    payload: unknown
  ): Promise<void> {
    if (!ref) return; // unreachable under Phoenix v2
    const effectiveJoinRef = joinRef ?? ref;

    const match = resolveTopic(this.server.loaded, topic);
    if (!match) {
      if (this.server.strictMode) {
        this.transport.send([
          effectiveJoinRef,
          ref,
          topic,
          "phx_reply",
          { status: "error", response: { reason: "unknown_topic" } },
        ]);
      }
      return;
    }

    const paramsResult = this.server.validator.validateJoinParams(
      match.channel.name,
      match.joinIndex,
      payload
    );
    if (!paramsResult.valid && this.server.strictMode) {
      this.transport.send([
        effectiveJoinRef,
        ref,
        topic,
        "phx_reply",
        {
          status: "error",
          response: { reason: "invalid_params", errors: paramsResult.errors },
        },
      ]);
      return;
    }

    this.server._recordObservation(topic, PHX_JOIN, payload);

    const scenario = this.server.lookupScenario(topic);
    if (!scenario?.joinHandler) {
      // No handler — synthesize a contract-valid reply from the join's
      // return schema so the client gets a shape it can actually parse.
      const fixture = this.server.fixtures.fromTypeRef(match.join.def.returnType);
      this.transport.send([
        effectiveJoinRef,
        ref,
        topic,
        "phx_reply",
        { status: "ok", response: fixture },
      ]);
      this.subs.set(topic, {
        topic,
        match,
        joinRef: effectiveJoinRef,
        scenario: scenario ?? { joinHandler: null, messageHandlers: new Map(), leaveHandler: null },
        vars: match.vars,
      });
      return;
    }

    const sub: Subscription = {
      topic,
      match,
      joinRef: effectiveJoinRef,
      scenario,
      vars: match.vars,
    };
    this.subs.set(topic, sub);

    const ctx = this.buildJoinContext(sub, ref, payload);
    await scenario.joinHandler(ctx);
  }

  private async handleMessage(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: unknown
  ): Promise<void> {
    const sub = this.subs.get(topic);
    if (!sub) {
      if (ref && this.server.strictMode) {
        this.transport.send([
          joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "error", response: { reason: "not_joined" } },
        ]);
      }
      return;
    }

    if (!sub.match.channel.messages.has(event)) {
      if (ref && this.server.strictMode) {
        this.transport.send([
          sub.joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "error", response: { reason: "unknown_event", event } },
        ]);
      }
      return;
    }

    const paramsResult = this.server.validator.validateMessageParams(
      sub.match.channel.name,
      event,
      payload
    );
    if (!paramsResult.valid && this.server.strictMode) {
      if (ref) {
        this.transport.send([
          sub.joinRef,
          ref,
          topic,
          "phx_reply",
          {
            status: "error",
            response: { reason: "invalid_params", errors: paramsResult.errors },
          },
        ]);
      }
      return;
    }

    this.server._recordObservation(topic, event, payload);

    const handler = sub.scenario.messageHandlers.get(event);
    if (!handler) {
      if (ref) {
        const messageDef = sub.match.channel.messages.get(event)?.def;
        const fixture = messageDef
          ? this.server.fixtures.fromTypeRef(messageDef.returnType)
          : {};
        this.transport.send([
          sub.joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "ok", response: fixture },
        ]);
      }
      return;
    }

    const ctx = this.buildMessageContext(sub, ref, event, payload);
    await handler(ctx);
  }

  private async handleLeave(
    joinRef: string | null,
    ref: string | null,
    topic: string
  ): Promise<void> {
    const sub = this.subs.get(topic);
    if (!sub) {
      if (ref) {
        this.transport.send([
          joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "error", response: { reason: "not_joined" } },
        ]);
      }
      return;
    }
    this.subs.delete(topic);

    if (ref) {
      this.transport.send([sub.joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
    }
    this.transport.send([sub.joinRef, null, topic, PHX_CLOSE, {}]);

    if (sub.scenario.leaveHandler) {
      await sub.scenario.leaveHandler({ topic, vars: sub.vars });
    }
  }

  // ── context factories ──────────────────────────────────────────
  private buildJoinContext(
    sub: Subscription,
    ref: string,
    params: unknown
  ): JoinContext {
    const replied = { done: false };
    // The returned context exposes method-syntax callbacks (reply/autoReply/push/…)
    // that must call back into the Subscription; capture `this` under a name the
    // nested methods can see.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const send = (frame: Frame) => self.transport.send(frame);

    return {
      topic: sub.topic,
      vars: sub.vars,
      params,
      reply(payload) {
        if (replied.done) return;
        replied.done = true;
        if (self.server.outboundValidation) {
          const r = self.server.validator.validateJoinReply(
            sub.match.channel.name,
            sub.match.joinIndex,
            payload
          );
          if (!r.valid) {
            throw new ContractViolation(
              `join reply violates contract for ${sub.match.channel.name}: ${r.errors.join("; ")}`
            );
          }
        }
        send(replyOk(sub.joinRef, ref, sub.topic, payload));
      },
      autoReply() {
        if (replied.done) return;
        this.reply(
          self.server.fixtures.fromTypeRef(sub.match.join.def.returnType)
        );
      },
      replyError(payload) {
        if (replied.done) return;
        replied.done = true;
        send(replyError(sub.joinRef, ref, sub.topic, payload));
      },
      replyTimeout() {
        replied.done = true;
      },
      replyRaw(status, payload) {
        if (replied.done) return;
        replied.done = true;
        send([sub.joinRef, ref, sub.topic, "phx_reply", { status, response: payload }]);
      },
      push(event, payload) {
        self.sendPush(sub, event, payload, /*validated*/ true);
      },
      autoPush(event) {
        self.sendAutoPush(sub, event);
      },
      pushRaw(event, payload) {
        self.sendPush(sub, event, payload, /*validated*/ false);
      },
      disconnect() {
        self.close();
      },
      closeTopic() {
        self.subs.delete(sub.topic);
        send(closeFrame(sub.joinRef, sub.topic));
      },
    };
  }

  private buildMessageContext(
    sub: Subscription,
    ref: string | null,
    event: string,
    params: unknown
  ): MessageContext {
    const replied = { done: ref === null }; // can't reply if no ref
    // See buildJoinContext — method-syntax callbacks need access to outer `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const send = (frame: Frame) => self.transport.send(frame);

    return {
      topic: sub.topic,
      vars: sub.vars,
      event,
      params,
      reply(payload) {
        if (replied.done || ref === null) return;
        replied.done = true;
        if (self.server.outboundValidation) {
          const r = self.server.validator.validateMessageReply(
            sub.match.channel.name,
            event,
            payload
          );
          if (!r.valid) {
            throw new ContractViolation(
              `reply to ${event} violates contract: ${r.errors.join("; ")}`
            );
          }
        }
        send(replyOk(sub.joinRef, ref, sub.topic, payload));
      },
      autoReply() {
        if (replied.done || ref === null) return;
        const messageDef = sub.match.channel.messages.get(event)?.def;
        const fixture = messageDef
          ? self.server.fixtures.fromTypeRef(messageDef.returnType)
          : {};
        this.reply(fixture);
      },
      replyError(payload) {
        if (replied.done || ref === null) return;
        replied.done = true;
        send(replyError(sub.joinRef, ref, sub.topic, payload));
      },
      replyTimeout() {
        replied.done = true;
      },
      replyRaw(status, payload) {
        if (replied.done || ref === null) return;
        replied.done = true;
        send([sub.joinRef, ref, sub.topic, "phx_reply", { status, response: payload }]);
      },
      push(pushEvent, payload) {
        self.sendPush(sub, pushEvent, payload, true);
      },
      autoPush(pushEvent) {
        self.sendAutoPush(sub, pushEvent);
      },
      pushRaw(pushEvent, payload) {
        self.sendPush(sub, pushEvent, payload, false);
      },
      disconnect() {
        self.close();
      },
      closeTopic() {
        self.subs.delete(sub.topic);
        send(closeFrame(sub.joinRef, sub.topic));
      },
    };
  }

  private sendPush(
    sub: Subscription,
    event: string,
    payload: unknown,
    validated: boolean
  ): void {
    if (validated && this.server.outboundValidation) {
      if (!sub.match.channel.pushes.has(event)) {
        throw new ContractViolation(
          `channel ${sub.match.channel.name} does not define push event '${event}' — use pushRaw() for contract-violation tests`
        );
      }
      const r = this.server.validator.validatePushPayload(
        sub.match.channel.name,
        event,
        payload
      );
      if (!r.valid) {
        throw new ContractViolation(
          `push '${event}' payload violates contract: ${r.errors.join("; ")}`
        );
      }
    }
    this.transport.send(pushFrame(sub.joinRef, sub.topic, event, payload));
  }

  sendAutoPush(sub: Subscription, event: string): void {
    const pushDef = sub.match.channel.pushes.get(event)?.def;
    if (!pushDef) {
      throw new ContractViolation(
        `channel ${sub.match.channel.name} does not define push event '${event}'`
      );
    }
    const fixture = this.server.fixtures.fromTypeRef(pushDef.payloadType);
    this.sendPush(sub, event, fixture, /*validated*/ true);
  }
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

// Re-exports used by transport implementations
export { decodeFrame, encodeFrame, PHX_ERROR };
