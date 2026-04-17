import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../ast/types.js";
import { pascalCase } from "../utils/naming.js";
import { jsonSchemaToTypeRef } from "./schema-parser.js";

// ─── x-channels extension shape ─────────────────────────────────

interface XChannel {
  name: string;
  description?: string;
  joins?: XChannelJoin[];
  messages?: XChannelMessage[];
  pushes?: XChannelPush[];
  "x-auth"?: string[];
}

interface XChannelJoin {
  pattern: string;
  name?: string;
  description?: string;
  params?: JsonSchema;
  returns?: JsonSchema;
}

interface XChannelMessage {
  event: string;
  description?: string;
  params?: JsonSchema;
  returns?: JsonSchema;
}

interface XChannelPush {
  event: string;
  description?: string;
  payload?: JsonSchema;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  $ref?: string;
  [key: string]: unknown;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse the `x-channels` OpenAPI extension into ChannelDef[].
 */
export function parseChannels(xChannels: XChannel[] | undefined): ChannelDef[] {
  if (!xChannels || xChannels.length === 0) return [];

  return xChannels.map(parseChannel);
}

// ─── Internal ────────────────────────────────────────────────────

function parseChannel(ch: XChannel): ChannelDef {
  const pc = pascalCase(ch.name);
  const className = pc.endsWith("Channel") ? pc : pc + "Channel";
  return {
    name: ch.name,
    className,
    description: ch.description ?? undefined,
    joins: (ch.joins ?? []).map(parseJoin),
    messages: (ch.messages ?? []).map(parseMessage),
    pushes: (ch.pushes ?? []).map(parsePush),
    auth: ch["x-auth"],
  };
}

function parseJoin(join: XChannelJoin): ChannelJoinDef {
  return {
    topicPattern: join.pattern,
    name: join.name,
    description: join.description ?? undefined,
    params: extractParamsFromSchema(join.params),
    returnType: join.returns
      ? jsonSchemaToTypeRef(join.returns)
      : { kind: "unknown" },
  };
}

function parseMessage(msg: XChannelMessage): ChannelMessageDef {
  return {
    event: msg.event,
    description: msg.description ?? undefined,
    params: extractParamsFromSchema(msg.params),
    returnType: msg.returns
      ? jsonSchemaToTypeRef(msg.returns)
      : { kind: "unknown" },
  };
}

function parsePush(push: XChannelPush): ChannelPushDef {
  return {
    event: push.event,
    description: push.description ?? undefined,
    payloadType: push.payload
      ? jsonSchemaToTypeRef(push.payload)
      : { kind: "unknown" },
  };
}

function extractParamsFromSchema(schema: JsonSchema | undefined): ParamDef[] {
  if (!schema?.properties) return [];

  const requiredSet = new Set(schema.required ?? []);

  // Preserve the spec's original field name — that's the wire key. Each
  // language backend decides how to surface it to users (camelCase method
  // signature for TS, snake_case kwarg for Python), but the serialized key
  // must match what the server expects. Camel-casing here would silently
  // rename `message_id` → `messageId` on the wire and break validation.
  return Object.entries(schema.properties).map(([name, fieldSchema]) => ({
    name,
    type: jsonSchemaToTypeRef(fieldSchema),
    required: requiredSet.has(name),
    description:
      typeof fieldSchema.description === "string"
        ? fieldSchema.description
        : undefined,
  }));
}
