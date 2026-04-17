import type { ChannelDef, ParamDef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { snakeCase } from "../../utils/naming.js";
import { typeRefToPython } from "./pydantic-emitter.js";

/**
 * Generate a Python async channel class.
 *
 * ```python
 * class ChatChannel:
 *     def __init__(self, channel):
 *         self._channel = channel
 *
 *     @staticmethod
 *     def topic(team_id: str, thread_id: str) -> str:
 *         return f"api:chat:team:{team_id}:thread:{thread_id}"
 *
 *     async def send_message(self, payload: dict) -> dict:
 *         return await self._channel.push("send_message", payload)
 *
 *     def on_message_added(self, callback) -> callable:
 *         return self._channel.on("message_added", callback)
 * ```
 */
export function emitPythonChannelFile(channel: ChannelDef): string {
  const cb = new CodeBuilder("    ");

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();
  cb.line("from typing import TYPE_CHECKING");
  cb.line();
  cb.line("if TYPE_CHECKING:");
  cb.line("    from phx_channel.socket import Socket");
  cb.line();

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
      emitMessageMethod(cb, msg.event, msg.description);
    }

    // Push handlers (server → client)
    for (const push of channel.pushes) {
      cb.line();
      emitPushHandler(cb, push.event, push.description);
    }
  });

  return cb.toString();
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
  event: string,
  description?: string
): void {
  const methodName = snakeCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));

  if (description) {
    cb.line(`# ${description}`);
  }

  cb.pyBlock(`async def ${methodName}(self, payload: dict) -> dict`, () => {
    cb.line(`return await self._channel.push("${event}", payload)`);
  });
}

function emitPushHandler(
  cb: CodeBuilder,
  rawEvent: string,
  description?: string
): void {
  const event = rawEvent.replace(/[^a-zA-Z0-9_]/g, "_");
  const handlerName = "on_" + snakeCase(event);

  if (description) {
    cb.line(`# ${description}`);
  }

  cb.pyBlock(`def ${handlerName}(self, callback)`, () => {
    cb.line(`return self._channel.on("${rawEvent}", callback)`);
  });
}
