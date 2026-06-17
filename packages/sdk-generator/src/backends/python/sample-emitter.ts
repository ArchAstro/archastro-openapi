import type { ChannelDef, OperationDef, ParamDef, SdkSpec } from "../../ast/types.js";
import { snakeCase } from "../../utils/naming.js";
import { generateDummyValue } from "../contract-tests/value-generator.js";
import {
  buildMethodCalls,
  type MethodCallInfo,
} from "../contract-tests/method-chain-builder.js";
import {
  emptySampleBundle,
  includesChannels,
  includesOperations,
  type SdkChannelSamples,
  type SdkOperationSamples,
  type SdkSampleBundle,
  type SdkSampleOptions,
} from "../samples.js";
import { pythonParameterName, uniquePythonParameterNames } from "./identifiers.js";
import {
  pyChannelJoinMethodName,
  pyChannelJoinParams,
  pyChannelMessageMethodName,
  pyChannelPushHandlerName,
} from "./channel-emitter.js";
import { pyAuthMethodName } from "./auth-emitter.js";

export function generatePythonSamples(
  spec: SdkSpec,
  options: SdkSampleOptions = {}
): SdkSampleBundle {
  if (!includesChannels(options) && !includesOperations(options)) {
    return emptySampleBundle();
  }

  return {
    channels: includesChannels(options)
      ? spec.channels.map((channel) => emitChannelSamples(spec, channel))
      : [],
    operations: includesOperations(options) ? emitOperationSamples(spec) : [],
  };
}

function emitOperationSamples(spec: SdkSpec): SdkOperationSamples[] {
  const resourceSamples: SdkOperationSamples[] = spec.versions.flatMap((versionSet) =>
    buildMethodCalls(spec, versionSet, "python", {
      useExamples: true,
      includeOptional: true,
    }).map((call) => ({
      operationId: call.operation.operationId,
      method: call.httpMethod,
      path: call.httpPath,
      samples: [
        {
          language: "python",
          label: "Python",
          code: emitOperationSample(spec, call),
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
        language: "python" as const,
        label: "Python",
        code: emitAuthOperationSample(spec, operation),
      },
    ],
  }));
}

function emitOperationSample(spec: SdkSpec, call: MethodCallInfo): string {
  const args = buildPythonArgs(call);
  const chain = call.accessorChain.replace("client.", "");
  const methodCall = `client.${chain}.${pythonParameterName(call.methodName)}(${args})`;
  const assignment = call.operation.returnType.kind === "void" && !call.operation.rawResponse
    ? `    await ${methodCall}`
    : `    result = await ${methodCall}`;

  return [
    "from archastro.platform import AsyncPlatformClient",
    "",
    `async with ${clientFactoryExpression(spec)} as client:`,
    assignment,
  ].join("\n");
}

function emitAuthOperationSample(spec: SdkSpec, operation: OperationDef): string {
  const methodName = pyAuthMethodName(operation);
  const args = authInputArgs(operation).join(", ");

  return [
    "from archastro.platform import AsyncPlatformClient",
    "",
    `async with ${authClientFactoryExpression(spec)} as client:`,
    `    result = await client.auth.${methodName}(${args})`,
  ].join("\n");
}

function authInputArgs(operation: OperationDef): string[] {
  return authInputFields(operation).map(({ name, type }) =>
    generateDummyValue(type, name, "python")
  );
}

function authInputFields(operation: OperationDef): Array<{ name: string; type: ParamDef["type"] }> {
  const entries: Array<{ originalName: string; type: ParamDef["type"]; required: boolean }> = [];

  for (const param of operation.queryParams) {
    entries.push({ originalName: param.name, type: param.type, required: param.required });
  }

  for (const field of operation.body?.fields ?? []) {
    if (!field.sdkRole) {
      entries.push({
        originalName: field.name,
        type: field.type,
        required: field.required,
      });
    }
  }

  if (entries.length === 0) {
    for (const param of operation.pathParams) {
      entries.push({ originalName: param.name, type: param.type, required: true });
    }
  }

  const sortedEntries = [
    ...entries.filter((entry) => entry.required),
    ...entries.filter((entry) => !entry.required),
  ];
  const names = uniquePythonParameterNames(sortedEntries.map((entry) => entry.originalName));
  return sortedEntries.map((entry, index) => ({
    name: names[index]!,
    type: entry.type,
  }));
}

function authClientFactoryExpression(spec: SdkSpec): string {
  const schemes = spec.auth?.schemes ?? {};

  if (schemes.publishable_key) {
    const header = schemes.publishable_key.name ?? "x-archastro-api-key";
    return `AsyncPlatformClient(default_headers={${JSON.stringify(header)}: api_key})`;
  }

  if (schemes.secret_key) {
    return "AsyncPlatformClient.with_secret_key(secret_key)";
  }

  return "AsyncPlatformClient()";
}

function buildPythonArgs(call: MethodCallInfo): string {
  const positional = call.args
    .filter((arg) => arg.kind !== "query")
    .map((arg) => arg.value);
  const queryArgs = call.args.filter((arg) => arg.kind === "query");
  const parts = [...positional];

  if (queryArgs.length > 0) {
    const queryNameMap = buildPythonQueryNameMap(call);
    for (const queryArg of queryArgs) {
      const match = queryArg.value.match(/\{(.+)\}/);
      if (!match) continue;

      for (const pair of match[1]!.split(/,\s*/)) {
        const [rawKey, value] = pair.split(/:\s*/);
        const key = rawKey!.replace(/"/g, "").trim();
        parts.push(`${queryNameMap.get(key) ?? pythonParameterName(key)}=${value!.trim()}`);
      }
    }
  }

  return parts.join(", ");
}

function buildPythonQueryNameMap(call: MethodCallInfo): Map<string, string> {
  const entries: Array<{ kind: "scope" | "path" | "body" | "query"; name: string }> = [];
  for (const param of call.resource.scopeParams) {
    entries.push({ kind: "scope", name: param.name });
  }
  for (const param of call.operation.pathParams) {
    entries.push({ kind: "path", name: param.name });
  }
  if (call.operation.body) {
    entries.push({ kind: "body", name: "input" });
  }
  for (const param of call.operation.queryParams) {
    entries.push({ kind: "query", name: param.name });
  }

  const names = uniquePythonParameterNames(entries.map((entry) => entry.name));
  const queryNames = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "query") {
      queryNames.set(entries[i]!.name, names[i]!);
    }
  }
  return queryNames;
}

function emitChannelSamples(spec: SdkSpec, channel: ChannelDef): SdkChannelSamples {
  return {
    name: channel.name,
    className: channel.className,
    joins: channel.joins.map((join, index) => ({
      name: join.name,
      pattern: join.topicPattern,
      samples: [
        {
          language: "python",
          label: "Python",
          code: emitJoinSample(spec, channel, index),
        },
      ],
    })),
    messages: channel.messages.map((message) => ({
      event: message.event,
      samples: [
        {
          language: "python",
          label: "Python",
          code: emitMessageSample(message.event, message.params),
        },
      ],
    })),
    pushes: channel.pushes.map((push) => ({
      event: push.event,
      samples: [
        {
          language: "python",
          label: "Python",
          code: emitPushSample(push.event),
        },
      ],
    })),
  };
}

function emitJoinSample(spec: SdkSpec, channel: ChannelDef, index: number): string {
  const join = channel.joins[index]!;
  const joinMethod = pyChannelJoinMethodName(join, index, channel.joins.length);
  const { topicParams, payloadParams } = pyChannelJoinParams(
    join.topicPattern,
    join.params
  );
  const joinArgs = [
    "socket",
    ...topicParams.map((param) =>
      generateDummyValue({ kind: "primitive", type: "string" }, param.rawName, "python")
    ),
    ...payloadParams.map(
      ({ param, pyName }) =>
        `${pyName}=${generateDummyValue(param.type, param.name, "python", param.example)}`
    ),
  ];

  return [
    "from archastro.platform import AsyncPlatformClient",
    `from archastro.platform.channels.${snakeCase(channel.name)} import ${channel.className}`,
    "",
    `async with ${clientFactoryExpression(spec)} as client:`,
    "    socket = await client.open_socket()",
    `    channel = await ${channel.className}.${joinMethod}(`,
    ...joinArgs.map((arg) => `        ${arg},`),
    "    )",
  ].join("\n");
}

function clientFactoryExpression(spec: SdkSpec): string {
  const schemes = spec.auth?.schemes ?? {};

  if (schemes.publishable_key) {
    return "AsyncPlatformClient.with_token(api_key, access_token)";
  }

  if (schemes.secret_key) {
    return "AsyncPlatformClient.with_secret_key(secret_key)";
  }

  const hasBearer =
    Object.values(schemes).some((scheme) => scheme.type === "http" && scheme.scheme === "bearer") ||
    (spec.auth?.channelAuth ?? []).some((scheme) => scheme === "bearer" || scheme === "device_flow");
  if (hasBearer) {
    return "AsyncPlatformClient(access_token=access_token)";
  }

  return "AsyncPlatformClient()";
}

function emitMessageSample(event: string, params: ParamDef[]): string {
  const methodName = pyChannelMessageMethodName(event);
  const payloadLines = pythonDictLines(params, 4);

  return [
    `reply = await channel.${methodName}({`,
    ...payloadLines,
    "})",
  ].join("\n");
}

function emitPushSample(event: string): string {
  const handlerName = pyChannelPushHandlerName(event);
  const fnName = `handle_${handlerName.replace(/^on_/, "")}`;

  return [
    `def ${fnName}(payload):`,
    "    print(payload)",
    "",
    `unsubscribe = channel.${handlerName}(${fnName})`,
  ].join("\n");
}

function pythonDictLines(params: ParamDef[], indent: number): string[] {
  if (params.length === 0) return [];

  const prefix = " ".repeat(indent);
  return params.map(
    (param) =>
      `${prefix}${JSON.stringify(param.name)}: ${generateDummyValue(param.type, param.name, "python", param.example)},`
  );
}
