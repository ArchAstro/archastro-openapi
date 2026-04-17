import type { ChannelContract, JoinContract, LoadedSpec } from "../spec/loader.js";
import { matchTopic } from "../spec/loader.js";

export interface TopicMatch {
  channel: ChannelContract;
  join: JoinContract;
  joinIndex: number;
  vars: Record<string, string>;
}

/**
 * Resolve an inbound topic string to the channel + join it satisfies.
 * Returns null if no channel owns this topic.
 */
export function resolveTopic(
  loaded: LoadedSpec,
  topic: string
): TopicMatch | null {
  for (const channel of loaded.contracts.values()) {
    for (let i = 0; i < channel.joins.length; i++) {
      const join = channel.joins[i]!;
      const vars = matchTopic(topic, join);
      if (vars) {
        return { channel, join, joinIndex: i, vars };
      }
    }
  }
  return null;
}
