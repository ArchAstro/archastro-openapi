import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import { goExportedName, goFileStem, goString } from "../go/identifiers.js";
import {
  buildChannelMembers,
  goChannelJoinParams,
  joinFuncKey,
  messageInputKey,
  pushPayloadKey,
} from "../go/channel-emitter.js";
import { renderGoFile, typeRefToGo, unwrapOptional } from "../go/type-map.js";
import { generateDummyValue, stringValueForField } from "./value-generator.js";
import {
  goInlineStructValue,
  goPlainTypedValue,
  goQualifiedRef,
  type GoValueContext,
} from "./go-values.js";

/**
 * Emit a Go channel contract-test file for a single channel.
 *
 * Drives the generated channel type through a real WebSocket against the
 * harness-service subprocess. Scenarios are registered over HTTP via the
 * handwritten `harnessClient` in the test package — the same service the
 * TypeScript, Python, and Swift suites drive; there is no in-process
 * shortcut.
 */
export function emitGoChannelContractTestFile(
  channel: ChannelDef,
  ctx: GoValueContext,
  importPath: string,
  claimTestName: (base: string) => string
): string {
  const cb = new CodeBuilder("\t");
  let firstTest = true;
  const emit = (fn: () => void): void => {
    if (!firstTest) cb.line();
    firstTest = false;
    fn();
  };

  for (let i = 0; i < channel.joins.length; i++) {
    for (const test of joinTests(channel, channel.joins[i]!, i, ctx, claimTestName)) {
      emit(() => renderTest(cb, test));
    }
  }

  if (channel.joins.length > 0) {
    const members = buildChannelMembers(channel);
    for (let i = 0; i < channel.messages.length; i++) {
      for (const test of messageTests(
        channel,
        channel.joins[0]!,
        channel.messages[i]!,
        members.messageMethods[i]!,
        ctx,
        claimTestName
      )) {
        emit(() => renderTest(cb, test));
      }
    }
    for (let i = 0; i < channel.pushes.length; i++) {
      emit(() =>
        renderTest(
          cb,
          pushTest(
            channel,
            channel.joins[0]!,
            channel.pushes[i]!,
            members.pushHandlers[i]!,
            ctx,
            claimTestName
          )
        )
      );
    }
    emit(() => renderTest(cb, leaveTest(channel, channel.joins[0]!, ctx, claimTestName)));
  }

  // Channel tests always name the SDK's Socket type in the harness
  // callback, so the SDK import is unconditional here.
  return renderGoFile(
    "contracttests",
    ["context", "testing", importPath],
    cb.toString()
  );
}

/** Filename stem for a channel's generated test file. */
export function goChannelTestFileStem(channel: ChannelDef): string {
  return `channels_${goFileStem(channel.className)}_test`;
}

// ─── helpers ────────────────────────────────────────────────────

interface GoTest {
  name: string;
  body: (cb: CodeBuilder) => void;
}

function renderTest(cb: CodeBuilder, test: GoTest): void {
  cb.block(`func ${test.name}(t *testing.T)`, () => test.body(cb));
}

interface ResolvedTopic {
  concrete: string;
  params: Array<{ goName: string; stringValue: string }>;
}

function resolveTopic(join: ChannelJoinDef): ResolvedTopic {
  const params: ResolvedTopic["params"] = [];
  const { topicParams } = goChannelJoinParams(join.topicPattern, join.params);
  let index = 0;
  const concrete = join.topicPattern.replace(/\{(\w+)\}/g, (_m, raw: string) => {
    const goName = topicParams[index]?.goName ?? raw;
    index++;
    const stringValue = dummyStringValue(goName);
    params.push({ goName, stringValue });
    return stringValue;
  });
  return { concrete, params };
}

function dummyStringValue(fieldName: string): string {
  const lit = stringValueForField(fieldName);
  return lit.startsWith('"') && lit.endsWith('"') ? lit.slice(1, -1) : lit;
}

function joinCall(
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number,
  topic: ResolvedTopic,
  ctx: GoValueContext
): string {
  const funcName = ctx.registry.lookup(joinFuncKey(channel, index));
  const { payloadParams } = goChannelJoinParams(join.topicPattern, join.params);

  const args = ["ctx", "socket"];
  for (const tp of topic.params) args.push(goString(tp.stringValue));
  for (const { param } of payloadParams) args.push(joinPayloadValue(param, ctx));
  return `${ctx.pkg}.${funcName}(${args.join(", ")})`;
}

/** Typed value for a join payload parameter, matching the join signature. */
function joinPayloadValue(param: ParamDef, ctx: GoValueContext): string {
  const value = goPlainTypedValue(param.type, param.name, ctx);
  const base = typeRefToGo(
    unwrapOptional(param.type),
    (schema) => goQualifiedRef(ctx, schema),
    `${ctx.pkg}.`
  );
  const optional = !param.required || param.type.kind === "optional";
  const pointer = optional && !base.startsWith("[]") && !base.startsWith("map[");
  return pointer ? `${ctx.pkg}.Ptr(${value})` : value;
}

function testName(
  channel: ChannelDef,
  suffix: string,
  claimTestName: (base: string) => string
): string {
  return claimTestName(`Test${channel.className}${goExportedName(suffix)}`);
}

// ─── join tests ─────────────────────────────────────────────────

function joinTests(
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number,
  ctx: GoValueContext,
  claimTestName: (base: string) => string
): GoTest[] {
  const topic = resolveTopic(join);
  const { payloadParams } = goChannelJoinParams(join.topicPattern, join.params);
  const requiredPayload = payloadParams.filter(({ param }) => param.required);
  const call = joinCall(channel, join, index, topic, ctx);
  const label = channel.joins.length > 1 ? `Join${index + 1}` : "Join";
  const tests: GoTest[] = [];

  tests.push({
    name: testName(channel, `${label}ReceivesContractValidReply`, claimTestName),
    body: (cb) =>
      emitSocketBody(cb, ctx, () => {
        cb.line(`channel, err := ${call}`);
        cb.block("if err != nil", () => {
          cb.line('t.Fatalf("join failed: %v", err)');
        });
        cb.block("if channel.JoinResponse.IsNull()", () => {
          cb.line('t.Fatal("expected a join response payload")');
        });
      }),
  });

  tests.push({
    name: testName(channel, `${label}SurfacesServerErrorReply`, claimTestName),
    body: (cb) =>
      emitSocketBody(cb, ctx, () => {
        cb.line("h.registerScenario(t, map[string]any{");
        cb.indent();
        cb.line(`"topic": ${goString(topic.concrete)},`);
        cb.line(
          '"onJoin": []any{map[string]any{"type": "replyError", "payload": map[string]any{"reason": "test_error"}}},'
        );
        cb.dedent();
        cb.line("})");
        cb.line(`_, err := ${call}`);
        cb.line("requireChannelError(t, err)");
      }),
  });

  if (requiredPayload.length > 0) {
    tests.push({
      name: testName(channel, `${label}RejectsMissingRequiredParams`, claimTestName),
      body: (cb) =>
        emitSocketBody(cb, ctx, () => {
          cb.line("// Drive the raw channel to bypass the typed signature — the");
          cb.line("// server must enforce the contract regardless of SDK types.");
          cb.line(`channel := socket.Channel(${goString(topic.concrete)})`);
          cb.line("_, err := channel.Join(ctx, map[string]any{})");
          cb.line("requireChannelError(t, err)");
        }),
    });
  }

  return tests;
}

function emitSocketBody(
  cb: CodeBuilder,
  ctx: GoValueContext,
  body: () => void
): void {
  cb.line("requireChannelTests(t)");
  cb.line("ctx := context.Background()");
  cb.line(`withHarnessSocket(t, func(h *harnessClient, socket *${ctx.pkg}.Socket) {`);
  cb.indent();
  body();
  cb.dedent();
  cb.line("})");
}

// ─── message tests ──────────────────────────────────────────────

function messageTests(
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  message: ChannelMessageDef,
  methodName: string,
  ctx: GoValueContext,
  claimTestName: (base: string) => string
): GoTest[] {
  const topic = resolveTopic(firstJoin);
  const call = joinCall(channel, firstJoin, 0, topic, ctx);
  const required = message.params.filter((p) => p.required);
  const payloadExpr =
    message.params.length > 0
      ? messagePayloadLiteral(channel, message, ctx)
      : `map[string]${ctx.pkg}.JSONValue{}`;
  const tests: GoTest[] = [];

  tests.push({
    name: testName(channel, `${methodName}SendsValidPush`, claimTestName),
    body: (cb) =>
      emitSocketBody(cb, ctx, () => {
        cb.line("h.registerScenario(t, map[string]any{");
        cb.indent();
        cb.line(`"topic": ${goString(topic.concrete)},`);
        cb.line('"onJoin": []any{map[string]any{"type": "autoReply"}},');
        cb.line(
          `"onMessage": map[string]any{${goString(message.event)}: []any{map[string]any{"type": "autoReply"}}},`
        );
        cb.dedent();
        cb.line("})");
        cb.line(`channel, err := ${call}`);
        cb.block("if err != nil", () => {
          cb.line('t.Fatalf("join failed: %v", err)');
        });
        cb.line(`reply, err := channel.${methodName}(ctx, ${payloadExpr})`);
        cb.block("if err != nil", () => {
          cb.line('t.Fatalf("push failed: %v", err)');
        });
        cb.block('if reply.Status != "ok"', () => {
          cb.line('t.Fatalf("expected an ok reply, got %q", reply.Status)');
        });
        cb.line(
          `observed := h.observations(t, ${goString(topic.concrete)}, ${goString(message.event)})`
        );
        cb.block("if len(observed) != 1", () => {
          cb.line('t.Fatalf("expected 1 observation, got %d", len(observed))');
        });
        if (required.length > 0) {
          for (const param of required) {
            cb.line(
              `requireJSON(t, observed[0].Get("params").Get(${goString(param.name)}), ${ctx.pkg}.JSONOf(${generateDummyValue(param.type, param.name, "go")}))`
            );
          }
        } else {
          cb.block('if observed[0].Get("params").IsNull()', () => {
            cb.line('t.Fatal("expected the observed frame to carry params")');
          });
        }
      }),
  });

  if (required.length > 0) {
    tests.push({
      name: testName(channel, `${methodName}RejectsMissingRequired`, claimTestName),
      body: (cb) =>
        emitSocketBody(cb, ctx, () => {
          cb.line("h.registerScenario(t, map[string]any{");
          cb.indent();
          cb.line(`"topic": ${goString(topic.concrete)},`);
          cb.line('"onJoin": []any{map[string]any{"type": "autoReply"}},');
          cb.dedent();
          cb.line("})");
          cb.line(`channel, err := ${call}`);
          cb.block("if err != nil", () => {
            cb.line('t.Fatalf("join failed: %v", err)');
          });
          cb.line("// Raw push bypasses the typed payload struct.");
          cb.line(
            `reply, err := channel.Channel.Push(ctx, ${goString(message.event)}, map[string]any{})`
          );
          cb.block("if err != nil", () => {
            cb.line('t.Fatalf("push failed: %v", err)');
          });
          cb.block('if reply.Status != "error"', () => {
            cb.line('t.Fatalf("expected an error reply, got %q", reply.Status)');
          });
        }),
    });
  }

  return tests;
}

function messagePayloadLiteral(
  channel: ChannelDef,
  message: ChannelMessageDef,
  ctx: GoValueContext
): string {
  const structName = ctx.registry.lookup(messageInputKey(channel, message.event));
  // All params — required and optional — mirroring the Python/Swift tests.
  return goInlineStructValue(message.params, structName, ctx);
}

// ─── push tests ─────────────────────────────────────────────────

function pushTest(
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  push: ChannelPushDef,
  handlerName: string,
  ctx: GoValueContext,
  claimTestName: (base: string) => string
): GoTest {
  const topic = resolveTopic(firstJoin);
  const call = joinCall(channel, firstJoin, 0, topic, ctx);
  const typed =
    push.payloadType.kind === "object" && push.payloadType.fields.length > 0;
  const payloadType = typed
    ? `${ctx.pkg}.${ctx.registry.lookup(pushPayloadKey(channel, push.event))}`
    : push.payloadType.kind === "ref"
      ? goQualifiedRef(ctx, push.payloadType.schema)
      : `${ctx.pkg}.JSONValue`;

  return {
    name: testName(channel, `${handlerName}DeliversPayloads`, claimTestName),
    body: (cb) =>
      emitSocketBody(cb, ctx, () => {
        cb.line("h.registerScenario(t, map[string]any{");
        cb.indent();
        cb.line(`"topic": ${goString(topic.concrete)},`);
        cb.line('"onJoin": []any{');
        cb.indent();
        cb.line('map[string]any{"type": "autoReply"},');
        cb.line(
          `map[string]any{"type": "autoPush", "event": ${goString(push.event)}},`
        );
        cb.dedent();
        cb.line("},");
        cb.dedent();
        cb.line("})");
        cb.line(`channel, err := ${call}`);
        cb.block("if err != nil", () => {
          cb.line('t.Fatalf("join failed: %v", err)');
        });
        cb.line(`payloads := make(chan ${payloadType}, 8)`);
        cb.line(
          `channel.${handlerName}(func(payload ${payloadType}) { payloads <- payload })`
        );
        cb.line("use(awaitFirst(t, payloads))");
      }),
  };
}

// ─── leave test ─────────────────────────────────────────────────

function leaveTest(
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  ctx: GoValueContext,
  claimTestName: (base: string) => string
): GoTest {
  const topic = resolveTopic(firstJoin);
  const call = joinCall(channel, firstJoin, 0, topic, ctx);

  return {
    name: testName(channel, "LeavesCleanly", claimTestName),
    body: (cb) =>
      emitSocketBody(cb, ctx, () => {
        cb.line("h.registerScenario(t, map[string]any{");
        cb.indent();
        cb.line(`"topic": ${goString(topic.concrete)},`);
        cb.line('"onJoin": []any{map[string]any{"type": "autoReply"}},');
        cb.dedent();
        cb.line("})");
        cb.line(`channel, err := ${call}`);
        cb.block("if err != nil", () => {
          cb.line('t.Fatalf("join failed: %v", err)');
        });
        cb.block("if err := channel.Leave(ctx); err != nil", () => {
          cb.line('t.Fatalf("leave failed: %v", err)');
        });
      }),
  };
}
