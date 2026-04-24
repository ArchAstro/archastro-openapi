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
import { typeRefToPython } from "./pydantic-emitter.js";
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
  const messageInputs = collectMessageInputs(channel);
  const pushPayloads = collectPushPayloads(channel);
  const inputNameByEvent = new Map(
    messageInputs.map((g) => [g.event, g.className] as const)
  );
  const payloadNameByEvent = new Map(
    pushPayloads.map((g) => [g.event, g.className] as const)
  );

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();

  const typedDictGroups = [...messageInputs, ...pushPayloads];
  const typingImports = collectTypedDictImports(typedDictGroups);
  const needsCallable = channel.pushes.length > 0;
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
  // can reference them.
  for (const group of typedDictGroups) {
    emitTypedDictClass(cb, group.className, group.fields, group.description);
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
        ? snakeCase(join.name.replace(/^join_/, "topic_"))
        : undefined;
      const joinName = join.name ? snakeCase(join.name) : undefined;
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
  const paramMatches = [...pattern.matchAll(/\{(\w+)\}/g)];
  const params = paramMatches.map(([, name]) => snakeCase(name!));
  const sig = params.map((p) => `${p}: str`).join(", ");

  const template = pattern.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `{${snakeCase(name)}}`;
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
  const paramMatches = [...pattern.matchAll(/\{(\w+)\}/g)];
  const topicParams = paramMatches.map(([, name]) => snakeCase(name!));
  const topicSet = new Set(topicParams);
  const payloadParams = joinParams.filter(
    (p) => !topicSet.has(snakeCase(p.name))
  );

  const sigParts = [
    "cls",
    'socket: "Socket"',
    ...topicParams.map((p) => `${p}: str`),
  ];
  if (payloadParams.length > 0) {
    sigParts.push("*");
    for (const p of payloadParams) {
      const pyName = snakeCase(p.name);
      const pyType = typeRefToPython(p.type);
      if (p.required) {
        sigParts.push(`${pyName}: ${pyType}`);
      } else {
        sigParts.push(`${pyName}: ${pyType} | None = None`);
      }
    }
  }
  const sig = sigParts.join(", ");
  const topicMethod =
    explicitTopicName ?? (suffix ? `topic${suffix}` : "topic");
  const topicArgs = topicParams.join(", ");
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
      for (const p of payloadParams) {
        const pyName = snakeCase(p.name);
        // The wire key must match the spec field name; `p.name` preserves
        // the original casing (typically camelCase), while the Python kwarg
        // is snake_cased for idiom. Using `pyName` on both sides would
        // rename the field mid-flight and fail server-side validation.
        const wireKey = JSON.stringify(p.name);
        if (p.required) {
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

function emitMessageMethod(
  cb: CodeBuilder,
  msg: ChannelMessageDef,
  inputClassName: string | undefined
): void {
  const methodName = snakeCase(msg.event.replace(/[^a-zA-Z0-9_]/g, "_"));
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
  const handlerName = "on_" + snakeCase(event);
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
