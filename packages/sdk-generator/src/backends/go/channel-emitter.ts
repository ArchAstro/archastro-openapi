import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import {
  GoNameRegistry,
  goExportedName,
  goString,
  uniqueGoFieldNames,
  uniqueGoParamNames,
} from "./identifiers.js";
import {
  emitDocComment,
  emitGoStruct,
  emitPlainDocComment,
  makeRefResolver,
} from "./model-emitter.js";
import { renderGoFile, typeRefToGo, unwrapOptional } from "./type-map.js";

/** Locals the generated topic/join function bodies own. */
const CHANNEL_LOCALS = [
  "ctx",
  "c",
  "socket",
  "topic",
  "channel",
  "payload",
  "joinResponse",
  "err",
  "callback",
  "decoded",
];

/**
 * Generate a Go channel file over the runtime's Phoenix `Channel`.
 *
 * Go has no static methods, so the topic builder and the join constructor
 * are package-level functions named after the channel struct.
 */
export function emitGoChannelFile(
  packageName: string,
  channel: ChannelDef,
  registry: GoNameRegistry
): string {
  const cb = new CodeBuilder("\t");
  const imports = new Set<string>(["context"]);

  claimChannelTypeNames(channel, registry);

  // Message input structs (client → server payloads), hoisted children first.
  for (const message of channel.messages) {
    if (message.params.length === 0) continue;
    const rootName = registry.lookup(messageInputKey(channel, message.event));
    const hoist = hoistInlineObjects(message.params, rootName, "typeddict");
    for (const child of hoist.hoisted) {
      emitGoStruct(cb, child.name, child.fields, registry, {
        description: child.description,
      });
      cb.line();
    }
    emitGoStruct(cb, rootName, hoist.fields, registry, {
      description: message.description,
    });
    cb.line();
  }

  // Push payload structs (server → client).
  for (const push of channel.pushes) {
    if (push.payloadType.kind !== "object" || push.payloadType.fields.length === 0) {
      continue;
    }
    const rootName = registry.lookup(pushPayloadKey(channel, push.event));
    const hoist = hoistInlineObjects(push.payloadType.fields, rootName, "basemodel");
    for (const child of hoist.hoisted) {
      emitGoStruct(cb, child.name, child.fields, registry, {
        description: child.description,
      });
      cb.line();
    }
    emitGoStruct(cb, rootName, hoist.fields, registry, {
      description: push.description,
    });
    cb.line();
  }

  const members = buildChannelMembers(channel);

  emitDocComment(cb, channel.className, channel.description);
  cb.block(`type ${channel.className} struct`, () => {
    cb.line("// Channel is the underlying Phoenix channel subscription.");
    cb.line("Channel *Channel");
    cb.line("// JoinResponse is the payload the server returned on join.");
    cb.line("JoinResponse JSONValue");
  });

  for (let i = 0; i < channel.joins.length; i++) {
    cb.line();
    emitTopicBuilder(cb, channel, channel.joins[i]!, i, registry);
    cb.line();
    emitJoinFunc(cb, channel, channel.joins[i]!, i, registry);
  }

  cb.line();
  emitPlainDocComment(cb, "Leave: leave the underlying channel.");
  cb.block(
    `func (c *${channel.className}) Leave(ctx context.Context) error`,
    () => {
      cb.line("return c.Channel.Leave(ctx)");
    }
  );

  for (let i = 0; i < channel.messages.length; i++) {
    cb.line();
    emitMessageMethod(cb, channel, channel.messages[i]!, members.messageMethods[i]!, registry);
  }

  for (let i = 0; i < channel.pushes.length; i++) {
    cb.line();
    emitPushHandler(cb, channel, channel.pushes[i]!, members.pushHandlers[i]!, registry);
  }

  return renderGoFile(packageName, [...imports], cb.toString());
}

export interface GoChannelMembers {
  messageMethods: string[];
  pushHandlers: string[];
}

/**
 * Method names on a channel struct, uniquified against each other and
 * against the struct's fields (Go forbids a field and method sharing a
 * name). Shared with the contract-tests emitter.
 */
export function buildChannelMembers(channel: ChannelDef): GoChannelMembers {
  const names = uniqueGoFieldNames(
    [
      ...channel.messages.map((m) => sanitizeEvent(m.event)),
      ...channel.pushes.map((p) => `on_${sanitizeEvent(p.event)}`),
    ],
    ["Channel", "JoinResponse", "Leave"]
  );
  return {
    messageMethods: names.slice(0, channel.messages.length),
    pushHandlers: names.slice(channel.messages.length),
  };
}

function sanitizeEvent(event: string): string {
  return event.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Claim registry names for a channel's payload structs and join helpers. */
export function claimChannelTypeNames(
  channel: ChannelDef,
  registry: GoNameRegistry
): void {
  for (const message of channel.messages) {
    if (message.params.length === 0) continue;
    registry.claim(
      messageInputKey(channel, message.event),
      channelTypeName(channel, message.event, "Input")
    );
  }
  for (const push of channel.pushes) {
    if (push.payloadType.kind !== "object" || push.payloadType.fields.length === 0) {
      continue;
    }
    registry.claim(
      pushPayloadKey(channel, push.event),
      channelTypeName(channel, push.event, "Payload")
    );
  }
  for (let i = 0; i < channel.joins.length; i++) {
    registry.claim(
      topicFuncKey(channel, i),
      goChannelTopicFuncName(channel, channel.joins[i]!, i)
    );
    registry.claim(
      joinFuncKey(channel, i),
      goChannelJoinFuncName(channel, channel.joins[i]!, i)
    );
  }
}

export function messageInputKey(channel: ChannelDef, event: string): string {
  return `channel-input:${channel.name}:${event}`;
}

export function pushPayloadKey(channel: ChannelDef, event: string): string {
  return `channel-payload:${channel.name}:${event}`;
}

export function topicFuncKey(channel: ChannelDef, index: number): string {
  return `channel-topic-func:${channel.name}:${index}`;
}

export function joinFuncKey(channel: ChannelDef, index: number): string {
  return `channel-join-func:${channel.name}:${index}`;
}

/**
 * Channel payload type name — `{EventPascal}{Suffix}` prefixed with the
 * channel's short name when the event isn't already namespaced by it, so
 * types stay unique in Go's single package namespace.
 */
function channelTypeName(
  channel: ChannelDef,
  event: string,
  suffix: string
): string {
  const short = channel.className.replace(/Channel$/, "");
  const eventPascal = pascalCase(sanitizeEvent(event));
  const base = eventPascal.startsWith(short) ? eventPascal : `${short}${eventPascal}`;
  return `${base}${suffix}`;
}

/** Preferred name of the package-level topic builder for a join. */
export function goChannelTopicFuncName(
  channel: ChannelDef,
  join: { name?: string },
  index: number
): string {
  if (join.name) {
    return `${channel.className}Topic${goExportedName(join.name.replace(/^join_?/, ""))}`;
  }
  return channel.joins.length > 1
    ? `${channel.className}Topic${index + 1}`
    : `${channel.className}Topic`;
}

/** Preferred name of the package-level join constructor for a join. */
export function goChannelJoinFuncName(
  channel: ChannelDef,
  join: { name?: string },
  index: number
): string {
  if (join.name) {
    return `Join${channel.className}${goExportedName(join.name.replace(/^join_?/, ""))}`;
  }
  return channel.joins.length > 1
    ? `Join${channel.className}${index + 1}`
    : `Join${channel.className}`;
}

// ─── Topic + join ────────────────────────────────────────────────

export interface GoTopicParam {
  rawName: string;
  goName: string;
}

export function goChannelTopicParams(pattern: string): GoTopicParam[] {
  const rawNames = topicRawNames(pattern);
  const goNames = uniqueGoParamNames(rawNames, CHANNEL_LOCALS);
  return rawNames.map((rawName, i) => ({ rawName, goName: goNames[i]! }));
}

export function goChannelJoinParams(
  pattern: string,
  joinParams: ParamDef[]
): {
  topicParams: GoTopicParam[];
  payloadParams: Array<{ param: ParamDef; goName: string }>;
} {
  const rawTopicNames = topicRawNames(pattern);
  const matcher = topicParamMatcher(rawTopicNames, joinParams);
  const payloadParams = joinParams.filter((p) => !matcher(p.name));
  const names = uniqueGoParamNames(
    [...rawTopicNames, ...payloadParams.map((p) => p.name)],
    CHANNEL_LOCALS
  );
  return {
    topicParams: rawTopicNames.map((rawName, i) => ({ rawName, goName: names[i]! })),
    payloadParams: payloadParams.map((param, i) => ({
      param,
      goName: names[rawTopicNames.length + i]!,
    })),
  };
}

function topicRawNames(pattern: string): string[] {
  return [...pattern.matchAll(/\{(\w+)\}/g)].map(([, name]) => name!);
}

function topicParamMatcher(
  rawTopicNames: string[],
  joinParams: ParamDef[]
): (paramName: string) => boolean {
  const exactTopicNames = new Set(rawTopicNames);
  const exactParamNames = new Set(joinParams.map((p) => p.name));
  const legacySnakeTopicKeys = new Set(
    rawTopicNames
      .filter((name) => !exactParamNames.has(name) && snakeCase(name) === name)
      .map((name) => snakeCase(name))
  );
  return (paramName: string) =>
    exactTopicNames.has(paramName) || legacySnakeTopicKeys.has(snakeCase(paramName));
}

function emitTopicBuilder(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number,
  registry: GoNameRegistry
): void {
  const funcName = registry.lookup(topicFuncKey(channel, index));
  const params = goChannelTopicParams(join.topicPattern);
  const sig = params.map((p) => `${p.goName} string`).join(", ");

  emitPlainDocComment(
    cb,
    `${funcName}: build the channel topic ${join.topicPattern}.`
  );
  cb.block(`func ${funcName}(${sig}) string`, () => {
    cb.line(`return ${topicExpression(join.topicPattern, params)}`);
  });
}

function topicExpression(pattern: string, params: GoTopicParam[]): string {
  const parts: string[] = [];
  let literal = "";
  let paramIndex = 0;
  const regex = /\{(\w+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    literal += pattern.slice(lastIndex, match.index);
    if (literal.length > 0) {
      parts.push(goString(literal));
      literal = "";
    }
    parts.push(params[paramIndex++]!.goName);
    lastIndex = match.index + match[0].length;
  }
  literal += pattern.slice(lastIndex);
  if (literal.length > 0 || parts.length === 0) parts.push(goString(literal));
  return parts.join(" + ");
}

function emitJoinFunc(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number,
  registry: GoNameRegistry
): void {
  const funcName = registry.lookup(joinFuncKey(channel, index));
  const topicFunc = registry.lookup(topicFuncKey(channel, index));
  const { topicParams, payloadParams } = goChannelJoinParams(
    join.topicPattern,
    join.params
  );
  const resolveRef = makeRefResolver(registry);

  const sig = ["ctx context.Context", "socket *Socket"];
  for (const tp of topicParams) sig.push(`${tp.goName} string`);
  for (const { param, goName } of payloadParams) {
    const base = typeRefToGo(unwrapOptional(param.type), resolveRef);
    const optional = !param.required || param.type.kind === "optional";
    sig.push(`${goName} ${optional && !base.startsWith("[]") && !base.startsWith("map[") ? `*${base}` : base}`);
  }

  emitPlainDocComment(
    cb,
    `${funcName}: join ${join.topicPattern} on socket and return the typed channel.`
  );
  cb.block(
    `func ${funcName}(${sig.join(", ")}) (*${channel.className}, error)`,
    () => {
      cb.line(
        `topic := ${topicFunc}(${topicParams.map((p) => p.goName).join(", ")})`
      );
      cb.line("channel := socket.Channel(topic)");
      if (payloadParams.length > 0) {
        cb.line("payload := map[string]JSONValue{}");
        for (const { param, goName } of payloadParams) {
          const optional = !param.required || param.type.kind === "optional";
          const base = typeRefToGo(unwrapOptional(param.type), resolveRef);
          const isPointer =
            optional && !base.startsWith("[]") && !base.startsWith("map[");
          const wireKey = goString(param.name);
          if (isPointer) {
            cb.block(`if ${goName} != nil`, () => {
              cb.line(`payload[${wireKey}] = JSONOf(*${goName})`);
            });
          } else {
            cb.line(`payload[${wireKey}] = JSONOf(${goName})`);
          }
        }
        cb.line("joinResponse, err := channel.Join(ctx, payload)");
      } else {
        cb.line("joinResponse, err := channel.Join(ctx, nil)");
      }
      cb.block("if err != nil", () => {
        cb.line("return nil, err");
      });
      cb.line(
        `return &${channel.className}{Channel: channel, JoinResponse: joinResponse}, nil`
      );
    }
  );
}

function emitMessageMethod(
  cb: CodeBuilder,
  channel: ChannelDef,
  message: ChannelMessageDef,
  methodName: string,
  registry: GoNameRegistry
): void {
  const hasInput = message.params.length > 0;
  const payloadType = hasInput
    ? registry.lookup(messageInputKey(channel, message.event))
    : "map[string]JSONValue";

  emitDocComment(cb, methodName, message.description);
  cb.block(
    `func (c *${channel.className}) ${methodName}(ctx context.Context, payload ${payloadType}) (*ChannelReply, error)`,
    () => {
      cb.line(
        `return c.Channel.Push(ctx, ${goString(message.event)}, payload)`
      );
    }
  );
}

function emitPushHandler(
  cb: CodeBuilder,
  channel: ChannelDef,
  push: ChannelPushDef,
  handlerName: string,
  registry: GoNameRegistry
): void {
  const typed =
    push.payloadType.kind === "object" && push.payloadType.fields.length > 0;
  const refType =
    push.payloadType.kind === "ref"
      ? makeRefResolver(registry)(push.payloadType.schema)
      : undefined;
  const payloadType = typed
    ? registry.lookup(pushPayloadKey(channel, push.event))
    : refType;

  emitDocComment(cb, handlerName, push.description);
  if (payloadType) {
    cb.line("// Payloads that fail to decode as the declared type are dropped.");
    cb.line("// The returned function unsubscribes.");
    cb.block(
      `func (c *${channel.className}) ${handlerName}(callback func(${payloadType})) func()`,
      () => {
        cb.line(
          `return c.Channel.On(${goString(push.event)}, func(payload JSONValue) {`
        );
        cb.indent();
        cb.line(`var decoded ${payloadType}`);
        cb.block("if err := payload.Decode(&decoded); err != nil", () => {
          cb.line("return");
        });
        cb.line("callback(decoded)");
        cb.dedent();
        cb.line("})");
      }
    );
    return;
  }

  cb.line("// The returned function unsubscribes.");
  cb.block(
    `func (c *${channel.className}) ${handlerName}(callback func(JSONValue)) func()`,
    () => {
      cb.line(`return c.Channel.On(${goString(push.event)}, callback)`);
    }
  );
}
