import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  parseOpenApiSpec,
  type ChannelDef,
  type ChannelJoinDef,
  type ChannelMessageDef,
  type ChannelPushDef,
  type OperationDef,
  type ResourceDef,
  type SdkSpec,
  type TypeRef,
} from "@archastro/sdk-generator";

export type JsonSchema = Record<string, unknown>;

export interface JoinContract {
  pattern: string;
  topicRegex: RegExp;
  vars: string[];
  paramsSchema: JsonSchema | null;
  returnsSchema: JsonSchema | null;
  def: ChannelJoinDef;
}

export interface MessageContract {
  event: string;
  paramsSchema: JsonSchema | null;
  returnsSchema: JsonSchema | null;
  def: ChannelMessageDef;
}

export interface PushContract {
  event: string;
  payloadSchema: JsonSchema | null;
  def: ChannelPushDef;
}

export interface ChannelContract {
  name: string;
  def: ChannelDef;
  joins: JoinContract[];
  messages: Map<string, MessageContract>;
  pushes: Map<string, PushContract>;
}

/** One named SSE event a streaming route can emit. */
export interface StreamEventContract {
  event: string;
  /** Raw JSON schema for the event payload (for Ajv validation). */
  dataSchema: JsonSchema | null;
  /** AST type ref for the event payload (for fixture synthesis). */
  dataType: TypeRef;
}

/**
 * A streaming HTTP route declared via `x-sdk-streaming` (the SSE analogue of a
 * channel): a method + path, a request-body schema, and the set of named SSE
 * events it may emit.
 */
export interface StreamContract {
  /** `"POST /api/v1/ai/chat/completions/stream"` — method + path. */
  routeKey: string;
  method: string;
  /** Full path with `{param}` placeholders, e.g. `/apps/{app}/...`. */
  path: string;
  pathRegex: RegExp;
  vars: string[];
  /** Request body schema (application/json), or null when the op has none. */
  requestSchema: JsonSchema | null;
  events: Map<string, StreamEventContract>;
}

export interface LoadedSpec {
  ast: SdkSpec;
  contracts: Map<string, ChannelContract>;
  /** Streaming (SSE) routes, keyed by `"METHOD /path"`. */
  streams: Map<string, StreamContract>;
  components: Record<string, JsonSchema>;
  rawSpec: Record<string, unknown>;
}

interface RawStreamingHint {
  type?: string;
  events?: Record<string, JsonSchema>;
}

interface RawXChannel {
  name: string;
  joins?: Array<{
    pattern: string;
    name?: string;
    params?: JsonSchema;
    returns?: JsonSchema;
  }>;
  messages?: Array<{
    event: string;
    params?: JsonSchema;
    returns?: JsonSchema;
  }>;
  pushes?: Array<{
    event: string;
    payload?: JsonSchema;
  }>;
}

export function loadSpec(source: string | Record<string, unknown>): LoadedSpec {
  const rawSpec =
    typeof source === "string" ? readSpecFile(source) : source;

  const ast = parseOpenApiSpec(
    rawSpec as unknown as Parameters<typeof parseOpenApiSpec>[0]
  );

  const components =
    ((rawSpec.components as Record<string, unknown> | undefined)?.schemas as
      | Record<string, JsonSchema>
      | undefined) ?? {};

  const rawChannels = (rawSpec["x-channels"] as RawXChannel[] | undefined) ?? [];

  const contracts = new Map<string, ChannelContract>();
  for (const channelDef of ast.channels) {
    const raw = rawChannels.find((c) => c.name === channelDef.name);
    contracts.set(channelDef.name, buildChannelContract(channelDef, raw));
  }

  const streams = buildStreamContracts(ast, rawSpec);

  return { ast, contracts, streams, components, rawSpec };
}

/**
 * Build a `StreamContract` for every operation the AST marked as streaming.
 * Event payload schemas + the request-body schema are read from the raw spec
 * (`x-sdk-streaming.events` and `requestBody`) so they keep their `$ref`s for
 * Ajv; the matching `dataType` for fixtures comes from the AST operation.
 */
function buildStreamContracts(
  ast: SdkSpec,
  rawSpec: Record<string, unknown>
): Map<string, StreamContract> {
  const streams = new Map<string, StreamContract>();
  const rawPaths =
    (rawSpec.paths as Record<string, Record<string, RawOperation>> | undefined) ?? {};

  for (const op of collectStreamingOperations(ast.resources)) {
    if (!op.streaming) continue;
    const method = op.method.toUpperCase();
    const routeKey = `${method} ${op.path}`;
    const rawOp = rawPaths[op.path]?.[op.method.toLowerCase()];
    const hint = (rawOp?.["x-sdk-streaming"] as RawStreamingHint | undefined) ?? {};

    const events = new Map<string, StreamEventContract>();
    for (const ev of op.streaming.events) {
      events.set(ev.event, {
        event: ev.event,
        dataSchema: hint.events?.[ev.event] ?? null,
        dataType: ev.dataType,
      });
    }

    const { regex, vars } = pathPatternToRegex(op.path);
    streams.set(routeKey, {
      routeKey,
      method,
      path: op.path,
      pathRegex: regex,
      vars,
      requestSchema: extractRequestSchema(rawOp),
      events,
    });
  }

  return streams;
}

interface RawOperation {
  "x-sdk-streaming"?: unknown;
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

function extractRequestSchema(rawOp: RawOperation | undefined): JsonSchema | null {
  return rawOp?.requestBody?.content?.["application/json"]?.schema ?? null;
}

function collectStreamingOperations(resources: ResourceDef[]): OperationDef[] {
  const out: OperationDef[] = [];
  const walk = (rs: ResourceDef[]): void => {
    for (const r of rs) {
      for (const op of r.operations) if (op.streaming) out.push(op);
      walk(r.children);
    }
  };
  walk(resources);
  return out;
}

/**
 * Convert an HTTP path with `{param}` placeholders into a regex plus the
 * ordered list of captured variable names.
 *
 * `/api/v1/apps/{app}/agents/{agent}/stream` →
 *   /^\/api\/v1\/apps\/([^/]+)\/agents\/([^/]+)\/stream$/ with ["app", "agent"]
 */
export function pathPatternToRegex(pattern: string): {
  regex: RegExp;
  vars: string[];
} {
  const vars: string[] = [];
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\{([a-zA-Z_][a-zA-Z0-9_]*)\\\}/g, (_, v) => {
    vars.push(v);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${body}$`), vars };
}

/**
 * Find the streaming route a `METHOD /path` request targets, returning the
 * contract plus any captured path-variable bindings. Query strings must be
 * stripped by the caller.
 */
export function matchStreamRoute(
  streams: Map<string, StreamContract>,
  method: string,
  path: string
): { contract: StreamContract; vars: Record<string, string> } | null {
  const upper = method.toUpperCase();
  for (const contract of streams.values()) {
    if (contract.method !== upper) continue;
    const m = path.match(contract.pathRegex);
    if (!m) continue;
    const vars: Record<string, string> = {};
    contract.vars.forEach((name, i) => {
      vars[name] = m[i + 1]!;
    });
    return { contract, vars };
  }
  return null;
}

function readSpecFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf-8");
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return parseYaml(text) as Record<string, unknown>;
  }
  return JSON.parse(text);
}

function buildChannelContract(
  channelDef: ChannelDef,
  raw: RawXChannel | undefined
): ChannelContract {
  const joins: JoinContract[] = channelDef.joins.map((joinDef) => {
    // Match by pattern, not positional index — mirrors how messages/pushes
    // below correlate by `event`. Keeps us safe against any future reorder
    // in parseOpenApiSpec.
    const rawJoin = raw?.joins?.find((rj) => rj.pattern === joinDef.topicPattern);
    const { regex, vars } = topicPatternToRegex(joinDef.topicPattern);
    return {
      pattern: joinDef.topicPattern,
      topicRegex: regex,
      vars,
      paramsSchema: rawJoin?.params ?? null,
      returnsSchema: rawJoin?.returns ?? null,
      def: joinDef,
    };
  });

  const messages = new Map<string, MessageContract>();
  for (const msg of channelDef.messages) {
    const rawMsg = raw?.messages?.find((m) => m.event === msg.event);
    messages.set(msg.event, {
      event: msg.event,
      paramsSchema: rawMsg?.params ?? null,
      returnsSchema: rawMsg?.returns ?? null,
      def: msg,
    });
  }

  const pushes = new Map<string, PushContract>();
  for (const push of channelDef.pushes) {
    const rawPush = raw?.pushes?.find((p) => p.event === push.event);
    pushes.set(push.event, {
      event: push.event,
      payloadSchema: rawPush?.payload ?? null,
      def: push,
    });
  }

  return { name: channelDef.name, def: channelDef, joins, messages, pushes };
}

/**
 * Convert a topic pattern with `{var}` placeholders into a regex plus the
 * ordered list of captured variable names.
 *
 * `api:chat:team:{team_id}:thread:{thread_id}` →
 *   /^api:chat:team:([^:]+):thread:([^:]+)$/ with vars ["team_id", "thread_id"]
 */
export function topicPatternToRegex(pattern: string): {
  regex: RegExp;
  vars: string[];
} {
  const vars: string[] = [];
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\{([a-zA-Z_][a-zA-Z0-9_]*)\\\}/g, (_, v) => {
    vars.push(v);
    return "([^:]+)";
  });
  return { regex: new RegExp(`^${body}$`), vars };
}

/** Extract variable bindings from a topic string given a join contract. */
export function matchTopic(
  topic: string,
  join: JoinContract
): Record<string, string> | null {
  const m = topic.match(join.topicRegex);
  if (!m) return null;
  const out: Record<string, string> = {};
  join.vars.forEach((name, i) => {
    out[name] = m[i + 1]!;
  });
  return out;
}
