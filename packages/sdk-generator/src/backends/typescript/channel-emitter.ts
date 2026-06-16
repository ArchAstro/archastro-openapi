import type { ChannelDef, ParamDef } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase, pascalCase } from "../../utils/naming.js";
import { typeRefToTS } from "./resource-emitter.js";

/**
 * Generate a TypeScript channel class that wraps Channel from @archastro/phx-channel.
 *
 * ```ts
 * import type { Channel } from "../phx_channel/channel.js";
 * import type { Socket } from "../phx_channel/socket.js";
 *
 * export class ChatChannel {
 *   constructor(private channel: Channel) {}
 *   static topic(teamId: string, threadId: string): string { ... }
 *   static join(socket: Socket, teamId: string, threadId: string): Promise<ChatChannel> { ... }
 *   async leave(): Promise<void> { ... }
 *   async sendMessage(input: SendMessageInput): Promise<Message> { ... }
 *   onMessageAdded(callback: (payload: MessageAddedPayload) => void): () => void { ... }
 * }
 * ```
 */
export function emitChannelFile(channel: ChannelDef): string {
  const cb = new CodeBuilder();

  cb.line(generatedHeader());
  cb.line(`import type { Channel } from "../phx_channel/channel.js";`);
  cb.line(`import type { Socket } from "../phx_channel/socket.js";`);
  cb.line();

  if (channel.description) {
    const lines = channel.description
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 1) {
      cb.line(`/** ${lines[0]} */`);
    } else {
      cb.line("/**");
      for (const line of lines) {
        cb.line(` * ${line}`);
      }
      cb.line(" */");
    }
  }

  cb.block(`export class ${channel.className}`, () => {
    cb.line(
      "constructor(private channel: Channel, public readonly joinResponse?: unknown) {}"
    );

    // Static topic builder + join method for each join pattern
    for (let i = 0; i < channel.joins.length; i++) {
      const join = channel.joins[i]!;
      const topicName = tsChannelTopicMethodName(join, i, channel.joins.length);
      const joinName = tsChannelJoinMethodName(join, i, channel.joins.length);
      cb.line();
      emitTopicBuilder(
        cb,
        join.topicPattern,
        join.description,
        topicName
      );
      cb.line();
      emitJoinMethod(
        cb,
        channel.className,
        join.topicPattern,
        join.params,
        join.description,
        joinName,
        topicName
      );
    }

    // leave() passthrough
    cb.line();
    cb.line("/** Leave the underlying channel. */");
    cb.block("async leave(): Promise<void>", () => {
      cb.line("await this.channel.leave();");
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
  methodName = "topic"
): void {
  // Extract param names from pattern: "api:chat:team:{team_id}:thread:{thread_id}"
  const params = tsChannelTopicParamNames(pattern);
  const sig = params.map((p) => `${p}: string`).join(", ");

  // Build template literal: `api:chat:team:${teamId}:thread:${threadId}`
  const template = pattern.replace(/\{(\w+)\}/g, (_match, name: string) => {
    return `\${${camelCase(name)}}`;
  });

  if (description) {
    cb.line(`/** ${description} */`);
  }

  cb.block(`static ${methodName}(${sig}): string`, () => {
    cb.line(`return \`${template}\`;`);
  });
}

function emitJoinMethod(
  cb: CodeBuilder,
  className: string,
  pattern: string,
  joinParams: ParamDef[],
  description?: string,
  methodName = "join",
  topicMethod = "topic"
): void {
  const topicParams = tsChannelTopicParamNames(pattern);
  // Topic vars in the pattern are written as they appear in the URL
  // (typically snake_case). Param names preserve the spec's casing. Compare
  // both in a case-normalized form so `{team_id}` matches a param named
  // `team_id` whether the spec used snake or camel for the topic var.
  const payloadParams = tsChannelJoinPayloadParams(pattern, joinParams);
  const hasRequiredPayload = payloadParams.some((p) => p.required);

  const sigParts = [
    "socket: Socket",
    ...topicParams.map((p) => `${p}: string`),
  ];
  if (payloadParams.length > 0) {
    // Use the spec's original field names in the TS interface. The SDK
    // forwards the payload to `channel.push(event, payload)` unchanged,
    // so the type field name IS the wire key. Camel-casing here would
    // silently rename fields on the wire and break server-side validation.
    const fields = payloadParams
      .map((p) => `${p.name}${p.required ? "" : "?"}: ${typeRefToTS(p.type)}`)
      .join("; ");
    sigParts.push(`payload${hasRequiredPayload ? "" : "?"}: { ${fields} }`);
  }
  const sig = sigParts.join(", ");
  const topicArgs = topicParams.join(", ");

  if (description) {
    cb.line(`/** ${description} */`);
  }

  cb.block(`static async ${methodName}(${sig}): Promise<${className}>`, () => {
    cb.line(`const topic = ${className}.${topicMethod}(${topicArgs});`);
    cb.line("const channel = socket.channel(topic);");
    if (payloadParams.length > 0) {
      cb.line("const joinResponse = await channel.join(payload);");
    } else {
      cb.line("const joinResponse = await channel.join();");
    }
    cb.line(`return new ${className}(channel, joinResponse);`);
  });
}

function emitMessageMethod(
  cb: CodeBuilder,
  event: string,
  description?: string
): void {
  const methodName = tsChannelMessageMethodName(event);

  if (description) {
    cb.line(`/** ${description} */`);
  }

  cb.block(
    `async ${methodName}(payload: Record<string, unknown>): Promise<unknown>`,
    () => {
      cb.line(`return this.channel.push("${event}", payload);`);
    }
  );
}

function emitPushHandler(
  cb: CodeBuilder,
  event: string,
  description?: string
): void {
  const handlerName = tsChannelPushHandlerName(event);

  if (description) {
    cb.line(`/** ${description} */`);
  }

  cb.block(
    `${handlerName}(callback: (payload: unknown) => void): () => void`,
    () => {
      cb.line(`return this.channel.on("${event}", callback);`);
    }
  );
}

export function tsChannelTopicMethodName(
  join: { name?: string },
  index: number,
  total: number
): string {
  if (join.name) return camelCase(join.name.replace(/^join_/, "topic_"));
  return total > 1 ? `topic${index + 1}` : "topic";
}

export function tsChannelJoinMethodName(
  join: { name?: string },
  index: number,
  total: number
): string {
  if (join.name) return camelCase(join.name);
  return total > 1 ? `join${index + 1}` : "join";
}

export function tsChannelMessageMethodName(event: string): string {
  return camelCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

export function tsChannelPushHandlerName(event: string): string {
  return "on" + pascalCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

export function tsChannelTopicParamNames(pattern: string): string[] {
  return [...pattern.matchAll(/\{(\w+)\}/g)].map(([, name]) => camelCase(name!));
}

export function tsChannelJoinPayloadParams(
  pattern: string,
  joinParams: ParamDef[]
): ParamDef[] {
  const topicSet = new Set(tsChannelTopicParamNames(pattern));
  return joinParams.filter((param) => !topicSet.has(camelCase(param.name)));
}
