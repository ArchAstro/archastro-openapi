import type { SdkSpec } from "../ast/types.js";

export type SdkSampleLanguage = "typescript" | "python";
export type SdkSampleInclude = "channels" | "operations";

export interface SdkCodeSample {
  language: SdkSampleLanguage;
  label: string;
  code: string;
}

export interface SdkChannelJoinSamples {
  name?: string;
  pattern: string;
  samples: SdkCodeSample[];
}

export interface SdkChannelMessageSamples {
  event: string;
  samples: SdkCodeSample[];
}

export interface SdkChannelPushSamples {
  event: string;
  samples: SdkCodeSample[];
}

export interface SdkChannelSamples {
  name: string;
  className: string;
  joins: SdkChannelJoinSamples[];
  messages: SdkChannelMessageSamples[];
  pushes: SdkChannelPushSamples[];
}

export interface SdkOperationSamples {
  operationId: string;
  method: string;
  path: string;
  samples: SdkCodeSample[];
}

export interface SdkSampleBundle {
  channels: SdkChannelSamples[];
  operations: SdkOperationSamples[];
}

export interface SdkSampleOptions {
  include?: SdkSampleInclude[];
}

export interface SdkSampleAggregateOptions extends SdkSampleOptions {
  languages?: SdkSampleLanguage[];
}

export type SdkSampleGenerator = (
  spec: SdkSpec,
  options?: SdkSampleOptions
) => SdkSampleBundle;

export function includesChannels(options: SdkSampleOptions = {}): boolean {
  return !options.include || options.include.includes("channels");
}

export function includesOperations(options: SdkSampleOptions = {}): boolean {
  return !options.include || options.include.includes("operations");
}

export function emptySampleBundle(): SdkSampleBundle {
  return { channels: [], operations: [] };
}

export function mergeSampleBundles(bundles: SdkSampleBundle[]): SdkSampleBundle {
  const channels = new Map<string, SdkChannelSamples>();
  const operations = new Map<string, SdkOperationSamples>();

  for (const bundle of bundles) {
    for (const channel of bundle.channels) {
      const key = channel.name;
      const existing =
        channels.get(key) ??
        {
          name: channel.name,
          className: channel.className,
          joins: channel.joins.map((join) => ({
            name: join.name,
            pattern: join.pattern,
            samples: [],
          })),
          messages: channel.messages.map((message) => ({
            event: message.event,
            samples: [],
          })),
          pushes: channel.pushes.map((push) => ({
            event: push.event,
            samples: [],
          })),
        };

      mergeJoinSamples(existing, channel);
      mergeMessageSamples(existing, channel);
      mergePushSamples(existing, channel);
      channels.set(key, existing);
    }

    for (const operation of bundle.operations) {
      const existing =
        operations.get(operation.operationId) ??
        {
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          samples: [],
        };
      existing.samples.push(...operation.samples);
      operations.set(operation.operationId, existing);
    }
  }

  return { channels: [...channels.values()], operations: [...operations.values()] };
}

function mergeJoinSamples(target: SdkChannelSamples, source: SdkChannelSamples): void {
  for (const join of source.joins) {
    const existing =
      target.joins.find((candidate) => candidate.pattern === join.pattern) ??
      addJoin(target, join);
    existing.samples.push(...join.samples);
  }
}

function mergeMessageSamples(target: SdkChannelSamples, source: SdkChannelSamples): void {
  for (const message of source.messages) {
    const existing =
      target.messages.find((candidate) => candidate.event === message.event) ??
      addMessage(target, message);
    existing.samples.push(...message.samples);
  }
}

function mergePushSamples(target: SdkChannelSamples, source: SdkChannelSamples): void {
  for (const push of source.pushes) {
    const existing =
      target.pushes.find((candidate) => candidate.event === push.event) ??
      addPush(target, push);
    existing.samples.push(...push.samples);
  }
}

function addJoin(target: SdkChannelSamples, join: SdkChannelJoinSamples): SdkChannelJoinSamples {
  const next = { name: join.name, pattern: join.pattern, samples: [] };
  target.joins.push(next);
  return next;
}

function addMessage(
  target: SdkChannelSamples,
  message: SdkChannelMessageSamples
): SdkChannelMessageSamples {
  const next = { event: message.event, samples: [] };
  target.messages.push(next);
  return next;
}

function addPush(target: SdkChannelSamples, push: SdkChannelPushSamples): SdkChannelPushSamples {
  const next = { event: push.event, samples: [] };
  target.pushes.push(next);
  return next;
}
