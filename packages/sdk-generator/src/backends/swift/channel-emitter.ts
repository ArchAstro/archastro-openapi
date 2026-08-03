import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "./identifiers.js";
import { emitDocComment, emitSwiftStruct } from "./model-emitter.js";
import { swiftToJSONValueExpr, typeRefToSwift, unwrapOptional } from "./type-map.js";

/**
 * Generate a Swift channel class over the runtime's Phoenix `Channel`.
 *
 * ```swift
 * public final class ApiChatChannel: Sendable {
 *     public static func joinTeamThread(socket: Socket, teamId: String, …) async throws -> ApiChatChannel
 *     public func apiChatPostMessage(payload: ApiChatPostMessageInput) async throws -> ChannelReply
 *     public func onMessageAdded(_ callback: @escaping @Sendable (ApiChatMessageAddedPayload) -> Void) -> @Sendable () -> Void
 * }
 * ```
 */
export function emitSwiftChannelFile(
  channel: ChannelDef,
  registry: SwiftNameRegistry
): string {
  const cb = new CodeBuilder("    ");

  claimChannelTypeNames(channel, registry);

  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  // Message input structs (client → server payloads), hoisted children first.
  for (const message of channel.messages) {
    if (message.params.length === 0) continue;
    const rootName = registry.lookup(messageInputKey(channel, message.event));
    const hoist = hoistInlineObjects(message.params, rootName, "typeddict");
    for (const child of hoist.hoisted) {
      emitSwiftStruct(cb, child.name, child.fields, registry, {
        description: child.description,
      });
      cb.line();
    }
    emitSwiftStruct(cb, rootName, hoist.fields, registry, {
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
      emitSwiftStruct(cb, child.name, child.fields, registry, {
        description: child.description,
      });
      cb.line();
    }
    emitSwiftStruct(cb, rootName, hoist.fields, registry, {
      description: push.description,
    });
    cb.line();
  }

  emitDocComment(cb, channel.description);
  cb.block(`public final class ${channel.className}: Sendable`, () => {
    cb.line("public let channel: Channel");
    cb.line("public let joinResponse: JSONValue?");
    cb.line();
    cb.block(
      "public init(channel: Channel, joinResponse: JSONValue? = nil)",
      () => {
        cb.line("self.channel = channel");
        cb.line("self.joinResponse = joinResponse");
      }
    );

    for (let i = 0; i < channel.joins.length; i++) {
      const join = channel.joins[i]!;
      cb.line();
      emitTopicBuilder(cb, join, i, channel.joins.length);
      cb.line();
      emitJoinMethod(cb, channel, join, i);
    }

    cb.line();
    cb.line("/// Leave the underlying channel.");
    cb.block("public func leave() async throws", () => {
      cb.line("try await channel.leave()");
    });

    for (const message of channel.messages) {
      cb.line();
      emitMessageMethod(cb, channel, message, registry);
    }

    for (const push of channel.pushes) {
      cb.line();
      emitPushHandler(cb, channel, push, registry);
    }
  });

  return cb.toString();
}

/** Claim registry names for a channel's payload structs. */
export function claimChannelTypeNames(
  channel: ChannelDef,
  registry: SwiftNameRegistry
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
}

export function messageInputKey(channel: ChannelDef, event: string): string {
  return `channel-input:${channel.name}:${event}`;
}

export function pushPayloadKey(channel: ChannelDef, event: string): string {
  return `channel-payload:${channel.name}:${event}`;
}

/**
 * Channel payload type name — `{EventPascal}{Suffix}` prefixed with the
 * channel's short name when the event isn't already namespaced by it, so
 * types stay unique in Swift's single module namespace.
 */
function channelTypeName(
  channel: ChannelDef,
  event: string,
  suffix: string
): string {
  const short = channel.className.replace(/Channel$/, "");
  const eventPascal = pascalCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
  const base = eventPascal.startsWith(short) ? eventPascal : `${short}${eventPascal}`;
  return `${base}${suffix}`;
}

// ─── Topic + join ────────────────────────────────────────────────

interface TopicParamInfo {
  rawName: string;
  swiftName: string;
}

// Locals used inside generated topic/join method bodies.
const CHANNEL_LOCALS = ["socket", "topic", "channel", "payload", "joinResponse"];

export function swiftChannelTopicParams(pattern: string): TopicParamInfo[] {
  const rawNames = topicRawNames(pattern);
  const swiftNames = uniqueSwiftMemberNames(rawNames, CHANNEL_LOCALS);
  return rawNames.map((rawName, i) => ({ rawName, swiftName: swiftNames[i]! }));
}

export function swiftChannelJoinParams(
  pattern: string,
  joinParams: ParamDef[]
): { topicParams: TopicParamInfo[]; payloadParams: Array<{ param: ParamDef; swiftName: string }> } {
  const rawTopicNames = topicRawNames(pattern);
  const matcher = topicParamMatcher(rawTopicNames, joinParams);
  const payloadParams = joinParams.filter((p) => !matcher(p.name));
  const names = uniqueSwiftMemberNames(
    [...rawTopicNames, ...payloadParams.map((p) => p.name)],
    CHANNEL_LOCALS
  );
  return {
    topicParams: rawTopicNames.map((rawName, i) => ({
      rawName,
      swiftName: names[i]!,
    })),
    payloadParams: payloadParams.map((param, i) => ({
      param,
      swiftName: names[rawTopicNames.length + i]!,
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

export function swiftChannelTopicMethodName(
  join: { name?: string },
  index: number,
  total: number
): string {
  if (join.name) {
    return uniqueSwiftMemberNames([join.name.replace(/^join_/, "topic_")])[0]!;
  }
  return total > 1 ? `topic${index + 1}` : "topic";
}

export function swiftChannelJoinMethodName(
  join: { name?: string },
  index: number,
  total: number
): string {
  if (join.name) return uniqueSwiftMemberNames([join.name])[0]!;
  return total > 1 ? `join${index + 1}` : "join";
}

export function swiftChannelMessageMethodName(event: string): string {
  return uniqueSwiftMemberNames([event.replace(/[^a-zA-Z0-9_]/g, "_")])[0]!;
}

export function swiftChannelPushHandlerName(event: string): string {
  return `on${pascalCase(event.replace(/[^a-zA-Z0-9_]/g, "_"))}`;
}

function emitTopicBuilder(
  cb: CodeBuilder,
  join: ChannelJoinDef,
  index: number,
  total: number
): void {
  const methodName = swiftChannelTopicMethodName(join, index, total);
  const params = swiftChannelTopicParams(join.topicPattern);
  const sig = params.map((p) => `${p.swiftName}: String`).join(", ");

  let paramIndex = 0;
  const template = join.topicPattern.replace(/\{(\w+)\}/g, () => {
    const name = params[paramIndex++]!.swiftName;
    return `\\(${name})`;
  });

  emitDocComment(cb, join.description);
  cb.block(`public static func ${methodName}(${sig}) -> String`, () => {
    cb.line(`return "${template}"`);
  });
}

function emitJoinMethod(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number
): void {
  const methodName = swiftChannelJoinMethodName(join, index, channel.joins.length);
  const topicMethod = swiftChannelTopicMethodName(join, index, channel.joins.length);
  const { topicParams, payloadParams } = swiftChannelJoinParams(
    join.topicPattern,
    join.params
  );

  const sigParts = ["socket: Socket"];
  for (const tp of topicParams) sigParts.push(`${tp.swiftName}: String`);
  for (const { param, swiftName } of payloadParams) {
    const base = typeRefToSwift(unwrapOptional(param.type));
    const optional =
      !param.required ||
      param.type.kind === "optional";
    sigParts.push(optional ? `${swiftName}: ${base}? = nil` : `${swiftName}: ${base}`);
  }

  const topicArgs = topicParams
    .map((tp) => `${tp.swiftName}: ${tp.swiftName.replace(/`/g, "")}`)
    .join(", ");

  emitDocComment(cb, join.description);
  cb.block(
    `public static func ${methodName}(${sigParts.join(", ")}) async throws -> ${channel.className}`,
    () => {
      cb.line(`let topic = ${topicMethod}(${topicArgs})`);
      cb.line("let channel = socket.channel(topic)");
      if (payloadParams.length > 0) {
        cb.line("var payload: [String: JSONValue] = [:]");
        for (const { param, swiftName } of payloadParams) {
          const bare = swiftName.replace(/`/g, "");
          const optional =
            !param.required ||
            param.type.kind === "optional";
          // Wire key preserves the spec's original field name.
          const wireKey = swiftString(param.name);
          if (optional) {
            cb.block(`if let ${bare} = ${swiftName}`, () => {
              cb.line(
                `payload[${wireKey}] = ${swiftToJSONValueExpr(unwrapOptional(param.type), bare)}`
              );
            });
          } else {
            cb.line(
              `payload[${wireKey}] = ${swiftToJSONValueExpr(param.type, bare)}`
            );
          }
        }
        cb.line("let joinResponse = try await channel.join(.object(payload))");
      } else {
        cb.line("let joinResponse = try await channel.join()");
      }
      cb.line(`return ${channel.className}(channel: channel, joinResponse: joinResponse)`);
    }
  );
}

function emitMessageMethod(
  cb: CodeBuilder,
  channel: ChannelDef,
  message: ChannelMessageDef,
  registry: SwiftNameRegistry
): void {
  const methodName = swiftChannelMessageMethodName(message.event);
  const hasInput = message.params.length > 0;
  const payloadType = hasInput
    ? registry.lookup(messageInputKey(channel, message.event))
    : "[String: JSONValue]";

  emitDocComment(cb, message.description);
  cb.block(
    `public func ${methodName}(payload: ${payloadType}${hasInput ? "" : " = [:]"}) async throws -> ChannelReply`,
    () => {
      cb.line(
        `return try await channel.push(${swiftString(message.event)}, payload: payload)`
      );
    }
  );
}

function emitPushHandler(
  cb: CodeBuilder,
  channel: ChannelDef,
  push: ChannelPushDef,
  registry: SwiftNameRegistry
): void {
  const handlerName = swiftChannelPushHandlerName(push.event);
  const typed =
    push.payloadType.kind === "object" && push.payloadType.fields.length > 0;

  emitDocComment(cb, push.description);
  if (typed) {
    const payloadType = registry.lookup(pushPayloadKey(channel, push.event));
    cb.line("/// Payloads that fail to decode as the declared type are dropped.");
    cb.line("@discardableResult");
    cb.block(
      `public func ${handlerName}(_ callback: @escaping @Sendable (${payloadType}) -> Void) -> @Sendable () -> Void`,
      () => {
        cb.line(`return channel.on(${swiftString(push.event)}) { payload in`);
        cb.indent();
        cb.line(
          `guard let decoded = try? payload.decode(${payloadType}.self) else { return }`
        );
        cb.line("callback(decoded)");
        cb.dedent();
        cb.line("}");
      }
    );
  } else {
    const payloadType =
      push.payloadType.kind === "ref"
        ? registry.has(`schema:${push.payloadType.schema}`)
          ? registry.lookup(`schema:${push.payloadType.schema}`)
          : push.payloadType.schema
        : undefined;
    cb.line("@discardableResult");
    if (payloadType) {
      cb.block(
        `public func ${handlerName}(_ callback: @escaping @Sendable (${payloadType}) -> Void) -> @Sendable () -> Void`,
        () => {
          cb.line(`return channel.on(${swiftString(push.event)}) { payload in`);
          cb.indent();
          cb.line(
            `guard let decoded = try? payload.decode(${payloadType}.self) else { return }`
          );
          cb.line("callback(decoded)");
          cb.dedent();
          cb.line("}");
        }
      );
    } else {
      cb.block(
        `public func ${handlerName}(_ callback: @escaping @Sendable (JSONValue) -> Void) -> @Sendable () -> Void`,
        () => {
          cb.line(
            `return channel.on(${swiftString(push.event)}) { payload in callback(payload) }`
          );
        }
      );
    }
  }
}
