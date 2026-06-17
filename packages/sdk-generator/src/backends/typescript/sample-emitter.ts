import type { ChannelDef, OperationDef, ParamDef, SdkSpec } from "../../ast/types.js";
import {
  emptySampleBundle,
  includesChannels,
  includesOperations,
  type SdkChannelSamples,
  type SdkOperationSamples,
  type SdkSampleBundle,
  type SdkSampleOptions,
} from "../samples.js";
import { generateDummyValue } from "../contract-tests/value-generator.js";
import {
  buildMethodCalls,
  type MethodCallInfo,
} from "../contract-tests/method-chain-builder.js";
import {
  tsChannelJoinMethodName,
  tsChannelJoinPayloadParams,
  tsChannelMessageMethodName,
  tsChannelPushHandlerName,
  tsChannelTopicMethodName,
  tsChannelTopicParamNames,
} from "./channel-emitter.js";
import { authMethodName } from "./auth-emitter.js";
import { camelCase } from "../../utils/naming.js";

export function generateTypeScriptSamples(
  spec: SdkSpec,
  options: SdkSampleOptions = {}
): SdkSampleBundle {
  if (!includesChannels(options) && !includesOperations(options)) {
    return emptySampleBundle();
  }

  return {
    channels: includesChannels(options)
      ? spec.channels.map((channel) => emitChannelSamples(channel))
      : [],
    operations: includesOperations(options) ? emitOperationSamples(spec) : [],
  };
}

function emitOperationSamples(spec: SdkSpec): SdkOperationSamples[] {
  const resourceSamples: SdkOperationSamples[] = spec.versions.flatMap((versionSet) =>
    buildMethodCalls(spec, versionSet, "typescript", {
      useExamples: true,
      includeOptional: true,
    }).map((call) => ({
      operationId: call.operation.operationId,
      method: call.httpMethod,
      path: call.httpPath,
      samples: [
        {
          language: "typescript",
          label: "TypeScript",
          code: emitOperationSample(call),
        },
      ],
    }))
  );

  return [...resourceSamples, ...emitAuthOperationSamples(spec)];
}

function emitAuthOperationSamples(spec: SdkSpec): SdkOperationSamples[] {
  return (spec.authOperations ?? []).map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    samples: [
      {
        language: "typescript" as const,
        label: "TypeScript",
        code: emitAuthOperationSample(operation),
      },
    ],
  }));
}

function emitOperationSample(call: MethodCallInfo): string {
  const args = call.args.map((arg) => arg.value).join(", ");
  const methodCall = `${call.accessorChain}.${call.methodName}(${args})`;
  const assignment = call.operation.returnType.kind === "void" && !call.operation.rawResponse
    ? `await ${methodCall};`
    : `const result = await ${methodCall};`;

  return [
    `import { PlatformClient } from "@archastro/sdk";`,
    "",
    "const client = new PlatformClient({",
    "  accessToken: process.env.ARCHASTRO_ACCESS_TOKEN,",
    "  defaultHeaders: { \"x-archastro-api-key\": process.env.ARCHASTRO_API_KEY ?? \"\" },",
    "});",
    "",
    assignment,
  ].join("\n");
}

function emitAuthOperationSample(operation: OperationDef): string {
  const methodName = authMethodName(operation);
  const args = authInputArgs(operation, "typescript").join(", ");
  return [
    `import { PlatformClient } from "@archastro/sdk";`,
    "",
    "const client = new PlatformClient({",
    "  defaultHeaders: { \"x-archastro-api-key\": process.env.ARCHASTRO_API_KEY ?? \"\" },",
    "});",
    "",
    `const result = await client.auth.${methodName}(${args});`,
  ].join("\n");
}

function authInputArgs(operation: OperationDef, lang: "typescript"): string[] {
  return authInputFields(operation).map(({ name, type }) =>
    generateDummyValue(type, name, lang)
  );
}

function authInputFields(operation: OperationDef): Array<{ name: string; type: ParamDef["type"] }> {
  const fields: Array<{ name: string; type: ParamDef["type"]; required: boolean }> = [];

  for (const param of operation.queryParams) {
    fields.push({ name: camelCase(param.name), type: param.type, required: param.required });
  }

  for (const field of operation.body?.fields ?? []) {
    if (!field.sdkRole) {
      fields.push({
        name: camelCase(field.name),
        type: field.type,
        required: field.required,
      });
    }
  }

  if (fields.length === 0) {
    for (const param of operation.pathParams) {
      fields.push({ name: camelCase(param.name), type: param.type, required: true });
    }
  }

  return [
    ...fields.filter((field) => field.required),
    ...fields.filter((field) => !field.required),
  ];
}

function emitChannelSamples(channel: ChannelDef): SdkChannelSamples {
  return {
    name: channel.name,
    className: channel.className,
    joins: channel.joins.map((join, index) => ({
      name: join.name,
      pattern: join.topicPattern,
      samples: [
        {
          language: "typescript",
          label: "TypeScript",
          code: emitJoinSample(channel, index),
        },
      ],
    })),
    messages: channel.messages.map((message) => ({
      event: message.event,
      samples: [
        {
          language: "typescript",
          label: "TypeScript",
          code: emitMessageSample(message.event, message.params),
        },
      ],
    })),
    pushes: channel.pushes.map((push) => ({
      event: push.event,
      samples: [
        {
          language: "typescript",
          label: "TypeScript",
          code: emitPushSample(push.event),
        },
      ],
    })),
  };
}

function emitJoinSample(channel: ChannelDef, index: number): string {
  const join = channel.joins[index]!;
  const topicMethod = tsChannelTopicMethodName(join, index, channel.joins.length);
  const joinMethod = tsChannelJoinMethodName(join, index, channel.joins.length);
  const topicArgs = topicArgValues(join.topicPattern);
  const payloadParams = tsChannelJoinPayloadParams(join.topicPattern, join.params);
  const joinArgs = ["socket", ...topicArgs];
  const lines = [
    `import { ${channel.className} } from "@archastro/sdk";`,
    `import { Socket } from "@archastro/sdk/phx_channel";`,
    "",
    `const socket = new Socket("wss://platform.archastro.ai/socket/api/websocket", {`,
    "  params: { token: process.env.ARCHASTRO_ACCESS_TOKEN ?? \"\" },",
    "});",
    "await socket.connect();",
    "",
  ];

  if (topicArgs.length > 0) {
    lines.push(
      `const topic = ${channel.className}.${topicMethod}(${topicArgs.join(", ")});`
    );
  }

  if (payloadParams.length > 0) {
    joinArgs.push(objectLiteral(payloadParams, "typescript"));
  }

  lines.push(
    `const channel = await ${channel.className}.${joinMethod}(${joinArgs.join(", ")});`
  );

  return lines.join("\n");
}

function emitMessageSample(event: string, params: ParamDef[]): string {
  const methodName = tsChannelMessageMethodName(event);
  return [
    `const reply = await channel.${methodName}(${objectLiteral(params, "typescript")});`,
  ].join("\n");
}

function emitPushSample(event: string): string {
  const handlerName = tsChannelPushHandlerName(event);
  return [
    `const unsubscribe = channel.${handlerName}((payload) => {`,
    `  console.log(${JSON.stringify(event)}, payload);`,
    "});",
  ].join("\n");
}

function topicArgValues(pattern: string): string[] {
  return tsChannelTopicParamNames(pattern).map((name) =>
    generateDummyValue({ kind: "primitive", type: "string" }, name, "typescript")
  );
}

function objectLiteral(params: ParamDef[], lang: "typescript"): string {
  if (params.length === 0) return "{}";

  const entries = params.map(
    (param) =>
      `${propertyKey(param.name)}: ${generateDummyValue(param.type, param.name, lang, param.example)}`
  );
  return `{ ${entries.join(", ")} }`;
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
