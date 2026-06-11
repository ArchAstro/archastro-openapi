import type {
  ChannelDef,
  ChannelMessageDef,
  ChannelPushDef,
  FieldDef,
  ParamDef,
  TypeRef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import { pythonParameterName, uniquePythonParameterNames } from "./identifiers.js";
import { typeRefToPython, typeRefsUseDatetime } from "./pydantic-emitter.js";
import { hoistInlineObjects } from "./inline-object-hoist.js";
import {
  collectTypedDictImports,
  emitTypedDictClass,
} from "./typeddict-emitter.js";

/**
 * Generate a Python async channel class.
 *
 * ```python
 * class ChatPostMessageInput(TypedDict, total=False):
 *     thread_id: Required[str]
 *     content: Required[str]
 *
 * class ChatChannel:
 *     async def post_message(self, payload: ChatPostMessageInput) -> dict[str, object]:
 *         return await self._channel.push("post_message", payload)
 *
 *     def on_message_added(
 *         self, callback: Callable[[ChatMessageAddedPayload], None]
 *     ) -> Callable[[], None]:
 *         return self._channel.on("message_added", callback)
 * ```
 */
export function emitPythonChannelFile(channel: ChannelDef): string {
  const cb = new CodeBuilder("    ");

  // Inline TypedDicts for client→server message inputs and server→client
  // push payloads. Built up-front so signatures can reference them by name.
  // Hoist nested inline objects out as siblings so deeply-nested payloads
  // don't collapse to dict[str, object].
  const messageInputs = collectMessageInputs(channel);
  const pushPayloads = collectPushPayloads(channel);
  const inputNameByEvent = new Map(
    messageInputs.map((g) => [g.event, g.className] as const)
  );
  const payloadNameByEvent = new Map(
    pushPayloads.map((g) => [g.event, g.className] as const)
  );

  type EmitGroup = { name: string; fields: typeof messageInputs[number]["fields"]; description?: string };
  const emitOrder: EmitGroup[] = [];
  for (const group of [...messageInputs, ...pushPayloads]) {
    const hoist = hoistInlineObjects(group.fields, group.className, "typeddict");
    for (const child of hoist.hoisted) {
      emitOrder.push({ name: child.name, fields: child.fields, description: child.description });
    }
    emitOrder.push({ name: group.className, fields: hoist.fields, description: group.description });
  }

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();

  const typingImports = collectTypedDictImports(emitOrder);
  const needsCallable = channel.pushes.length > 0;
  const emitFieldTypes = emitOrder.flatMap((g) => g.fields.map((f) => f.type));
  if (typeRefsUseDatetime(emitFieldTypes)) {
    cb.line("from datetime import datetime");
  }
  const typingNames = [...typingImports, "TYPE_CHECKING"].sort();
  cb.line(`from typing import ${typingNames.join(", ")}`);
  if (needsCallable) {
    cb.line("from collections.abc import Callable");
  }
  cb.line();
  cb.line("if TYPE_CHECKING:");
  cb.line("    from archastro.phx_channel.socket import Socket");
  cb.line();

  // TypedDict classes — emitted before the channel class so signatures
  // can reference them. Hoisted nested objects come before their parents
  // in the emit order; consumers never see a forward ref.
  for (const group of emitOrder) {
    emitTypedDictClass(cb, group.name, group.fields, group.description);
    cb.line();
    cb.line();
  }

  if (channel.description) {
    for (const line of channel.description.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        cb.line(`# ${trimmed.replace(/[^\x20-\x7E]/g, " ")}`);
      }
    }
  }

  cb.pyBlock(`class ${channel.className}`, () => {
    cb.pyBlock("def __init__(self, channel, join_response=None)", () => {
      cb.line("self._channel = channel");
      cb.line("self.join_response = join_response");
    });

    // Static topic builder + join method for each join pattern
    for (let i = 0; i < channel.joins.length; i++) {
      const join = channel.joins[i]!;
      const suffix = channel.joins.length > 1 ? `_${i + 1}` : "";
      const topicName = join.name
        ? pythonParameterName(join.name.replace(/^join_/, "topic_"))
        : undefined;
      const joinName = join.name ? pythonParameterName(join.name) : undefined;
      cb.line();
      emitTopicBuilder(
        cb,
        join.topicPattern,
        join.description,
        suffix,
        topicName
      );
      cb.line();
      emitJoinMethod(
        cb,
        channel.className,
        join.topicPattern,
        join.params,
        join.description,
        suffix,
        joinName,
        topicName
      );
    }

    // leave() passthrough
    cb.line();
    cb.line("# Leave the underlying channel.");
    cb.pyBlock("async def leave(self)", () => {
      cb.line("await self._channel.leave()");
    });

    // Message methods (client → server)
    for (const msg of channel.messages) {
      cb.line();
      emitMessageMethod(cb, msg, inputNameByEvent.get(msg.event));
    }

    // Push handlers (server → client)
    for (const push of channel.pushes) {
      cb.line();
      emitPushHandler(cb, push, payloadNameByEvent.get(push.event));
    }
  });

  return cb.toString();
}

interface InlineGroup {
  event: string;
  className: string;
  fields: FieldDef[];
  description?: string;
}

/**
 * Collect TypedDicts for client→server message payloads. Names follow the
 * `{EventInPascal}Input` convention; channel files are self-contained, so
 * collisions across channels are fine.
 */
function collectMessageInputs(channel: ChannelDef): InlineGroup[] {
  return channel.messages
    .filter((m) => m.params.length > 0)
    .map((m) => ({
      event: m.event,
      className: `${eventToPascal(m.event)}Input`,
      fields: m.params,
      description: m.description,
    }));
}

/**
 * Collect TypedDicts for server→client push payloads when the schema is an
 * inline object. Refs and primitives stay as-is via typeRefToPython.
 */
function collectPushPayloads(channel: ChannelDef): InlineGroup[] {
  const groups: InlineGroup[] = [];
  for (const push of channel.pushes) {
    if (push.payloadType.kind === "object" && push.payloadType.fields.length > 0) {
      groups.push({
        event: push.event,
        className: `${eventToPascal(push.event)}Payload`,
        fields: push.payloadType.fields,
        description: push.description,
      });
    }
  }
  return groups;
}

function eventToPascal(event: string): string {
  return pascalCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function emitTopicBuilder(
  cb: CodeBuilder,
  pattern: string,
  description?: string,
  suffix = "",
  explicitName?: string
): void {
  const params = topicPythonParams(pattern);
  const sig = params.map((p) => `${p.pyName}: str`).join(", ");

  let paramIndex = 0;
  const template = pattern.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `{${params[paramIndex++]?.pyName ?? pythonParameterName(name)}}`;
  });

  if (description) {
    cb.line(`# ${description}`);
  }
  const methodName = explicitName ?? (suffix ? `topic${suffix}` : "topic");

  cb.line("@staticmethod");
  cb.pyBlock(`def ${methodName}(${sig}) -> str`, () => {
    cb.line(`return f"${template}"`);
  });
}

function emitJoinMethod(
  cb: CodeBuilder,
  className: string,
  pattern: string,
  joinParams: ParamDef[],
  description?: string,
  suffix = "",
  explicitName?: string,
  explicitTopicName?: string
): void {
  const { topicParams, payloadParams } = joinPythonParams(pattern, joinParams);

  const sigParts = [
    "cls",
    'socket: "Socket"',
    ...topicParams.map((p) => `${p.pyName}: str`),
  ];
  if (payloadParams.length > 0) {
    sigParts.push("*");
    for (const { param, pyName } of payloadParams) {
      const pyType = typeRefToPython(param.type);
      if (param.required) {
        sigParts.push(`${pyName}: ${pyType}`);
      } else {
        sigParts.push(`${pyName}: ${pyType} | None = None`);
      }
    }
  }
  const sig = sigParts.join(", ");
  const topicMethod =
    explicitTopicName ?? (suffix ? `topic${suffix}` : "topic");
  const topicArgs = topicParams.map((p) => p.pyName).join(", ");
  const methodName = explicitName ?? (suffix ? `join${suffix}` : "join");

  if (description) {
    cb.line(`# ${description}`);
  }

  cb.line("@classmethod");
  cb.pyBlock(`async def ${methodName}(${sig}) -> "${className}"`, () => {
    cb.line(`topic = cls.${topicMethod}(${topicArgs})`);
    cb.line("channel = socket.channel(topic)");
    if (payloadParams.length > 0) {
      cb.line("payload: dict[str, object] = {}");
      for (const { param, pyName } of payloadParams) {
        // The wire key must match the spec field name; `p.name` preserves
        // the original casing (typically camelCase), while the Python kwarg
        // is snake_cased for idiom. Using `pyName` on both sides would
        // rename the field mid-flight and fail server-side validation.
        const wireKey = JSON.stringify(param.name);
        if (param.required) {
          cb.line(`payload[${wireKey}] = ${pyName}`);
        } else {
          cb.line(`if ${pyName} is not None:`);
          cb.line(`    payload[${wireKey}] = ${pyName}`);
        }
      }
      cb.line("join_response = await channel.join(payload)");
    } else {
      cb.line("join_response = await channel.join()");
    }
    cb.line(`return cls(channel, join_response)`);
  });
}

interface TopicParamName {
  rawName: string;
  pyName: string;
}

interface PayloadParamName {
  param: ParamDef;
  pyName: string;
}

function topicPythonParams(pattern: string): TopicParamName[] {
  const rawNames = topicRawNames(pattern);
  const pyNames = uniquePythonParameterNames(rawNames);
  return rawNames.map((rawName, index) => ({
    rawName,
    pyName: pyNames[index]!,
  }));
}

function joinPythonParams(
  pattern: string,
  joinParams: ParamDef[]
): { topicParams: TopicParamName[]; payloadParams: PayloadParamName[] } {
  const rawTopicNames = topicRawNames(pattern);
  const topicMatcher = topicParamMatcher(rawTopicNames, joinParams);
  const payloadParams = joinParams.filter(
    (param) => !topicMatcher(param.name)
  );
  const pyNames = uniquePythonParameterNames([
    ...rawTopicNames,
    ...payloadParams.map((param) => param.name),
  ]);
  const topicParams = rawTopicNames.map((rawName, index) => ({
    rawName,
    pyName: pyNames[index]!,
  }));
  const namedPayloadParams = payloadParams.map((param, index) => ({
    param,
    pyName: pyNames[rawTopicNames.length + index]!,
  }));

  return { topicParams, payloadParams: namedPayloadParams };
}

function topicRawNames(pattern: string): string[] {
  return [...pattern.matchAll(/\{(\w+)\}/g)].map(([, name]) => name!);
}

function topicParamMatcher(
  rawTopicNames: string[],
  joinParams: ParamDef[]
): (paramName: string) => boolean {
  const exactTopicNames = new Set(rawTopicNames);
  const exactParamNames = new Set(joinParams.map((param) => param.name));
  const legacySnakeTopicKeys = new Set(
    rawTopicNames
      .filter((name) => !exactParamNames.has(name) && snakeCase(name) === name)
      .map((name) => snakeCase(name))
  );

  return (paramName: string) =>
    exactTopicNames.has(paramName) ||
    legacySnakeTopicKeys.has(snakeCase(paramName));
}

function emitMessageMethod(
  cb: CodeBuilder,
  msg: ChannelMessageDef,
  inputClassName: string | undefined
): void {
  const methodName = pythonParameterName(msg.event.replace(/[^a-zA-Z0-9_]/g, "_"));
  const payloadType = inputClassName ?? "dict";
  const returnType = typeRefToPython(msg.returnType);

  if (msg.description) {
    cb.line(`# ${msg.description}`);
  }

  cb.pyBlock(
    `async def ${methodName}(self, payload: ${payloadType}) -> ${returnType}`,
    () => {
      cb.line(`return await self._channel.push("${msg.event}", payload)`);
    }
  );
}

function emitPushHandler(
  cb: CodeBuilder,
  push: ChannelPushDef,
  payloadClassName: string | undefined
): void {
  const event = push.event.replace(/[^a-zA-Z0-9_]/g, "_");
  const handlerName = "on_" + pythonParameterName(event);
  const payloadType = payloadClassName ?? typeRefForPushPayload(push.payloadType);
  // Phoenix channel handlers receive a single payload arg. Returning is
  // unobserved in the runtime, but `None` is the right contract for users.
  const callbackType = `Callable[[${payloadType}], None]`;
  // The runtime returns an unsubscribe callable from `.on(...)`.
  const returnType = "Callable[[], None]";

  if (push.description) {
    cb.line(`# ${push.description}`);
  }

  cb.pyBlock(
    `def ${handlerName}(self, callback: ${callbackType}) -> ${returnType}`,
    () => {
      cb.line(`return self._channel.on("${push.event}", callback)`);
    }
  );
}

function typeRefForPushPayload(ref: TypeRef): string {
  // Empty / unknown object payloads collapse to dict[str, object] for
  // forward-compat with payloads the spec hasn't fully described.
  if (ref.kind === "object" && ref.fields.length === 0) {
    return "dict[str, object]";
  }
  return typeRefToPython(ref);
}
