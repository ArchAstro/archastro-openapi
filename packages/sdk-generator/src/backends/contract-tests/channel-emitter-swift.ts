import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "../swift/identifiers.js";
import {
  messageInputKey,
  swiftChannelJoinMethodName,
  swiftChannelJoinParams,
  swiftChannelMessageMethodName,
  swiftChannelPushHandlerName,
} from "../swift/channel-emitter.js";
import { generateDummyValue, stringValueForField } from "./value-generator.js";
import { swiftTypedValue } from "./swift-values.js";

/**
 * Emit a swift-testing channel contract test file for a single channel.
 *
 * Drives the generated channel class through a real WebSocket against the
 * harness-service subprocess. Scenarios are registered over HTTP via the
 * handwritten `HarnessServiceClient` in the test support module — the same
 * service the TypeScript and Python tests drive; there is no in-process
 * shortcut.
 */
export function emitSwiftChannelContractTestFile(
  channel: ChannelDef,
  registry: SwiftNameRegistry
): string {
  const cb = new CodeBuilder("    ");

  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line("import Testing");
  cb.line("import ArchAstroPlatform");
  cb.line();

  cb.block(
    `@Suite(.serialized, .enabled(if: ContractSupport.channelTestsEnabled)) struct ${channel.className}ContractTests`,
    () => {
      for (let i = 0; i < channel.joins.length; i++) {
        emitJoinTests(cb, channel, channel.joins[i]!, i);
      }

      if (channel.joins.length > 0) {
        for (const message of channel.messages) {
          emitMessageTests(cb, channel, channel.joins[0]!, message, registry);
        }
        for (const push of channel.pushes) {
          emitPushTest(cb, channel, channel.joins[0]!, push);
        }
        emitLeaveTest(cb, channel, channel.joins[0]!);
      }
    }
  );

  return cb.toString();
}

/** Filename stem for a channel's test file. */
export function swiftChannelTestFileStem(channel: ChannelDef): string {
  return `${channel.className}ContractTests`;
}

// ─── helpers ────────────────────────────────────────────────────

interface ResolvedTopic {
  concrete: string;
  params: Array<{ swiftName: string; stringValue: string }>;
}

function resolveTopic(join: ChannelJoinDef): ResolvedTopic {
  const params: ResolvedTopic["params"] = [];
  const { topicParams } = swiftChannelJoinParams(join.topicPattern, join.params);
  let index = 0;
  const concrete = join.topicPattern.replace(/\{(\w+)\}/g, (_m, raw: string) => {
    const swiftName = topicParams[index]?.swiftName ?? raw;
    index++;
    const stringValue = dummyStringValue(swiftName);
    params.push({ swiftName, stringValue });
    return stringValue;
  });
  return { concrete, params };
}

function dummyStringValue(fieldName: string): string {
  const lit = stringValueForField(fieldName.replace(/`/g, ""));
  return lit.startsWith('"') && lit.endsWith('"') ? lit.slice(1, -1) : lit;
}

function joinCall(
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number,
  topic: ResolvedTopic
): string {
  const methodName = swiftChannelJoinMethodName(join, index, channel.joins.length);
  const { payloadParams } = swiftChannelJoinParams(join.topicPattern, join.params);

  const parts = ["socket: socket"];
  for (const tp of topic.params) {
    parts.push(`${tp.swiftName}: ${swiftString(tp.stringValue)}`);
  }
  for (const { param, swiftName } of payloadParams) {
    parts.push(`${swiftName}: ${swiftPayloadValue(param)}`);
  }
  return `${channel.className}.${methodName}(${parts.join(", ")})`;
}

/** Typed value for a join payload parameter (typed method signature). */
function swiftPayloadValue(param: ParamDef): string {
  return swiftTypedValue(param.type, param.name, pascalCase(param.name), []);
}

function testPrefix(channel: ChannelDef, suffix: string): string {
  return `${snakeCase(channel.name)}_${snakeCase(suffix.replace(/`/g, ""))}`;
}

// ─── join tests ─────────────────────────────────────────────────

function emitJoinTests(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number
): void {
  const joinMethod = swiftChannelJoinMethodName(join, index, channel.joins.length);
  const topic = resolveTopic(join);
  const { payloadParams } = swiftChannelJoinParams(join.topicPattern, join.params);
  const requiredPayload = payloadParams.filter(({ param }) => param.required);
  const happyCall = joinCall(channel, join, index, topic);
  const prefix = testPrefix(channel, joinMethod);

  cb.line();
  cb.block(
    `@Test func ${prefix}_joins_and_receives_contract_valid_reply() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarnessSocket { _, socket in");
      cb.indent();
      cb.line(`let channel = try await ${happyCall}`);
      cb.line("#expect(channel.joinResponse != nil)");
      cb.dedent();
      cb.line("}");
    }
  );

  cb.line();
  cb.block(
    `@Test func ${prefix}_surfaces_server_error_reply_as_channel_error() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarnessSocket { harness, socket in");
      cb.indent();
      cb.line("try await harness.registerScenario([");
      cb.indent();
      cb.line(`"topic": ${swiftString(topic.concrete)},`);
      cb.line('"onJoin": [["type": "replyError", "payload": ["reason": "test_error"]]],');
      cb.dedent();
      cb.line("])");
      cb.block("await #expect(throws: ChannelError.self)", () => {
        cb.line(`_ = try await ${happyCall}`);
      });
      cb.dedent();
      cb.line("}");
    }
  );

  if (requiredPayload.length > 0) {
    cb.line();
    cb.block(
      `@Test func ${prefix}_rejects_when_required_params_missing() async throws`,
      () => {
        cb.line("try await ContractSupport.withHarnessSocket { _, socket in");
        cb.indent();
        cb.line("// Drive the raw channel to bypass the typed signature — the");
        cb.line("// server must enforce the contract regardless of SDK types.");
        cb.line(`let channel = socket.channel(${swiftString(topic.concrete)})`);
        cb.block("await #expect(throws: ChannelError.self)", () => {
          cb.line("_ = try await channel.join(.object([:]))");
        });
        cb.dedent();
        cb.line("}");
      }
    );
  }
}

// ─── message tests ──────────────────────────────────────────────

function emitMessageTests(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  message: ChannelMessageDef,
  registry: SwiftNameRegistry
): void {
  const methodName = swiftChannelMessageMethodName(message.event);
  const topic = resolveTopic(firstJoin);
  const happyCall = joinCall(channel, firstJoin, 0, topic);
  const msgRequired = message.params.filter((p) => p.required);
  const prefix = testPrefix(channel, methodName);

  const payloadExpr =
    message.params.length > 0
      ? swiftTypedValueForMessage(channel, message, registry)
      : "[:]";

  cb.line();
  cb.block(
    `@Test func ${prefix}_sends_valid_push_and_receives_contract_valid_reply() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarnessSocket { harness, socket in");
      cb.indent();
      cb.line("try await harness.registerScenario([");
      cb.indent();
      cb.line(`"topic": ${swiftString(topic.concrete)},`);
      cb.line('"onJoin": [["type": "autoReply"]],');
      cb.line(
        `"onMessage": [${swiftString(message.event)}: [["type": "autoReply"]]],`
      );
      cb.dedent();
      cb.line("])");
      cb.line(`let channel = try await ${happyCall}`);
      cb.line(`let reply = try await channel.${methodName}(payload: ${payloadExpr})`);
      cb.line('#expect(reply.status == "ok")');
      cb.line();
      cb.line(
        `let observed = try await harness.observations(topic: ${swiftString(topic.concrete)}, event: ${swiftString(message.event)})`
      );
      cb.line("#expect(observed.count == 1)");
      if (msgRequired.length > 0) {
        for (const param of msgRequired) {
          const expected = generateDummyValue(param.type, param.name, "swift");
          cb.line(
            `#expect(observed.first?["params"]?[${swiftString(param.name)}] == ${expected})`
          );
        }
      } else {
        cb.line('#expect(observed.first?["params"] != nil)');
      }
      cb.dedent();
      cb.line("}");
    }
  );

  if (msgRequired.length > 0) {
    cb.line();
    cb.block(
      `@Test func ${prefix}_returns_error_envelope_when_required_missing() async throws`,
      () => {
        cb.line("try await ContractSupport.withHarnessSocket { harness, socket in");
        cb.indent();
        cb.line("try await harness.registerScenario([");
        cb.indent();
        cb.line(`"topic": ${swiftString(topic.concrete)},`);
        cb.line('"onJoin": [["type": "autoReply"]],');
        cb.dedent();
        cb.line("])");
        cb.line(`let channel = try await ${happyCall}`);
        cb.line("// Raw push bypasses the typed payload struct.");
        cb.line(
          `let reply = try await channel.channel.push(${swiftString(message.event)}, payload: [:] as [String: JSONValue])`
        );
        cb.line('#expect(reply.status == "error")');
        cb.dedent();
        cb.line("}");
      }
    );
  }
}

function swiftTypedValueForMessage(
  channel: ChannelDef,
  message: ChannelMessageDef,
  registry: SwiftNameRegistry
): string {
  const structName = registry.lookup(messageInputKey(channel, message.event));
  // All params — required and optional — mirroring the Python tests.
  const parts: string[] = [];
  const memberNames = messageMemberNames(message);
  for (let i = 0; i < message.params.length; i++) {
    const param = message.params[i]!;
    parts.push(
      `${memberNames[i]}: ${swiftTypedValue(param.type, param.name, `${structName}${pascalCase(param.name)}`, [])}`
    );
  }
  return `${structName}(${parts.join(", ")})`;
}

function messageMemberNames(message: ChannelMessageDef): string[] {
  // Mirrors emitSwiftStruct's member naming for the generated input struct.
  return uniqueSwiftMemberNames(message.params.map((p) => p.name));
}

// ─── push tests ─────────────────────────────────────────────────

function emitPushTest(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  push: ChannelPushDef
): void {
  const handlerName = swiftChannelPushHandlerName(push.event);
  const topic = resolveTopic(firstJoin);
  const happyCall = joinCall(channel, firstJoin, 0, topic);
  const prefix = testPrefix(channel, handlerName);

  cb.line();
  cb.block(
    `@Test func ${prefix}_delivers_contract_valid_payloads() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarnessSocket { harness, socket in");
      cb.indent();
      cb.line("try await harness.registerScenario([");
      cb.indent();
      cb.line(`"topic": ${swiftString(topic.concrete)},`);
      cb.line('"onJoin": [');
      cb.indent();
      cb.line('["type": "autoReply"],');
      cb.line(`["type": "autoPush", "event": ${swiftString(push.event)}],`);
      cb.dedent();
      cb.line("],");
      cb.dedent();
      cb.line("])");
      cb.line(`let channel = try await ${happyCall}`);
      cb.line("let payload = try await ContractSupport.awaitFirst { yield in");
      cb.indent();
      cb.line(`channel.${handlerName} { payload in yield(payload) }`);
      cb.dedent();
      cb.line("}");
      cb.line("ContractSupport.use(payload)");
      cb.dedent();
      cb.line("}");
    }
  );
}

// ─── leave test ─────────────────────────────────────────────────

function emitLeaveTest(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef
): void {
  const topic = resolveTopic(firstJoin);
  const happyCall = joinCall(channel, firstJoin, 0, topic);
  const prefix = testPrefix(channel, "leave");

  cb.line();
  cb.block(
    `@Test func ${prefix}_leaves_cleanly_through_generated_leave() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarnessSocket { harness, socket in");
      cb.indent();
      cb.line("try await harness.registerScenario([");
      cb.indent();
      cb.line(`"topic": ${swiftString(topic.concrete)},`);
      cb.line('"onJoin": [["type": "autoReply"]],');
      cb.dedent();
      cb.line("])");
      cb.line(`let channel = try await ${happyCall}`);
      cb.line("try await channel.leave()");
      cb.dedent();
      cb.line("}");
    }
  );
}
