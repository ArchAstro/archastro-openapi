/**
 * Scenario DSL — declarative per-topic handlers for join, inbound messages,
 * and leave. Handlers run when matching frames arrive from the client.
 *
 * A scenario is registered against a topic pattern string (which may itself
 * contain `{var}` placeholders matching the channel's join pattern). When a
 * client joins a topic that resolves to this scenario, a fresh session is
 * bound to that subscription and lives until the client leaves or disconnects.
 */

export interface JoinContext {
  /** Resolved topic string (with variables substituted). */
  topic: string;
  /** Captured topic variables, e.g. `{ team_id: "t_1", thread_id: "th_42" }`. */
  vars: Record<string, string>;
  /** Join params already validated against the contract. */
  params: unknown;
  /** Reply with a success response. Validated against the join's returns schema. */
  reply(payload: unknown): void;
  /** Reply with a contract-valid fixture synthesized from the join's returns schema. */
  autoReply(): void;
  /** Reply with an error response. */
  replyError(payload: unknown): void;
  /** Do not reply — leaves the client's join ref hanging (simulates a timeout). */
  replyTimeout(): void;
  /** Reply bypassing contract validation — for testing how clients handle bad servers. */
  replyRaw(status: "ok" | "error", payload: unknown): void;
  /** Send a server-initiated push on this topic. Validated against the contract. */
  push(event: string, payload: unknown): void;
  /** Send a server-initiated push with a contract-valid fixture synthesized from the push's payload schema. */
  autoPush(event: string): void;
  /** Send a push bypassing validation (invalid event or payload). */
  pushRaw(event: string, payload: unknown): void;
  /** Close the underlying transport, simulating an abrupt disconnect. */
  disconnect(): void;
  /** Issue a server-initiated phx_close on this topic. */
  closeTopic(): void;
}

export interface MessageContext extends Omit<JoinContext, "params"> {
  event: string;
  params: unknown;
}

export interface LeaveContext {
  topic: string;
  vars: Record<string, string>;
}

export type JoinHandler = (ctx: JoinContext) => void | Promise<void>;
export type MessageHandler = (ctx: MessageContext) => void | Promise<void>;
export type LeaveHandler = (ctx: LeaveContext) => void | Promise<void>;

export interface ScenarioBuilder {
  onJoin(handler: JoinHandler): this;
  onMessage(event: string, handler: MessageHandler): this;
  onLeave(handler: LeaveHandler): this;
}

export interface ScenarioDefinition {
  joinHandler: JoinHandler | null;
  messageHandlers: Map<string, MessageHandler>;
  leaveHandler: LeaveHandler | null;
}

export function makeScenarioBuilder(def: ScenarioDefinition): ScenarioBuilder {
  const builder: ScenarioBuilder = {
    onJoin(handler) {
      def.joinHandler = handler;
      return builder;
    },
    onMessage(event, handler) {
      def.messageHandlers.set(event, handler);
      return builder;
    },
    onLeave(handler) {
      def.leaveHandler = handler;
      return builder;
    },
  };
  return builder;
}
