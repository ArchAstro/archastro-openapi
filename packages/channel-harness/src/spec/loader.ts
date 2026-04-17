import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  parseOpenApiSpec,
  type ChannelDef,
  type ChannelJoinDef,
  type ChannelMessageDef,
  type ChannelPushDef,
  type SdkSpec,
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

export interface LoadedSpec {
  ast: SdkSpec;
  contracts: Map<string, ChannelContract>;
  components: Record<string, JsonSchema>;
  rawSpec: Record<string, unknown>;
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

  return { ast, contracts, components, rawSpec };
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
  const joins: JoinContract[] = channelDef.joins.map((joinDef, i) => {
    const rawJoin = raw?.joins?.[i];
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
