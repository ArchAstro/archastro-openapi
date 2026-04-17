/**
 * @archastro/channel-harness
 *
 * Runtime contract-testing harness for x-channels described in an OpenAPI
 * spec. Boot a ContractServer from a spec, register per-topic scenarios,
 * and attach either an in-process transport (same-process TS tests) or a
 * real WebSocket server (language-agnostic end-to-end tests).
 *
 * Every inbound frame is validated against the channel's join/message
 * schemas. Every outbound payload is (by default) validated against the
 * channel's reply/push schemas, so scenarios can't silently lie about the
 * contract — they must go through explicit *Raw methods to inject faults.
 */

export {
  ContractServer,
  ContractViolation,
  type ContractServerOptions,
  type Observation,
  type Transport,
} from "./server/contract-server.js";

export {
  createInProcessPair,
  type InProcessPair,
  type InProcessClient,
} from "./server/in-process-socket.js";

export {
  startWsHarness,
  type WsHarnessHandle,
  type WsHarnessOptions,
} from "./server/socket-server.js";

export {
  type Frame,
  encodeFrame,
  decodeFrame,
  FrameDecodeError,
  PHX_JOIN,
  PHX_LEAVE,
  PHX_REPLY,
  PHX_ERROR,
  PHX_CLOSE,
  HEARTBEAT,
} from "./server/frame.js";

export {
  type ScenarioBuilder,
  type JoinContext,
  type MessageContext,
  type LeaveContext,
  type JoinHandler,
  type MessageHandler,
  type LeaveHandler,
} from "./scenarios/dsl.js";

export {
  loadSpec,
  topicPatternToRegex,
  matchTopic,
  type LoadedSpec,
  type ChannelContract,
  type JoinContract,
  type MessageContract,
  type PushContract,
  type JsonSchema,
} from "./spec/loader.js";

export {
  buildValidator,
  type ChannelValidator,
  type ValidationResult,
} from "./spec/validator.js";

export { FixtureGenerator } from "./fixtures/generator.js";

export {
  HarnessSocket,
  ChannelJoinError,
  ChannelReplyError,
  ChannelTimeoutError,
  ChannelDisconnectError,
  type Socket,
  type Channel,
  type HarnessTransport,
  type HarnessSocketOptions,
} from "./client/phx-adapter.js";

export {
  startHarnessService,
  type HarnessServiceHandle,
  type HarnessServiceOptions,
} from "./service/harness-service.js";

export {
  HarnessServiceClient,
  createWsTransport,
  type HarnessServiceClientOptions,
  type HandlerErrorReport,
} from "./service/harness-client.js";

export {
  configureFromRequest,
  validateScenarioRequest,
  ScenarioRequestError,
  type ScenarioAction,
  type ScenarioRequest,
} from "./service/scenario.js";
