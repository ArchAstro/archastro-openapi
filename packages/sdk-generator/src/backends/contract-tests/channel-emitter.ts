import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase, pascalCase, snakeCase } from "../../utils/naming.js";
import { generateDummyValue } from "./value-generator.js";

/**
 * Emit a vitest contract test file for a single channel.
 *
 * The output drives the generated channel class (e.g. `LiveDocChannel`)
 * through a real WebSocket against a `HarnessService` subprocess — the same
 * service Python (or any other language) tests drive. Scenarios are JSON
 * registered over HTTP; there is no in-process closure shortcut.
 *
 * Expects two environment variables set by the contract test globalSetup:
 *
 *   ARCHASTRO_HARNESS_WS_URL       — ws://host:port/socket/websocket
 *   ARCHASTRO_HARNESS_CONTROL_URL  — http://host:port
 *
 * @param channel              Parsed channel from the AST.
 * @param channelImportPath    Import path to the generated channel class
 *                              (e.g. `../../../src/channels/live_doc.js`).
 */
export function emitChannelContractTestFile(
  channel: ChannelDef,
  channelImportPath: string
): string {
  const cb = new CodeBuilder();

  emitHeader(cb, channel, channelImportPath);
  emitHelpers(cb);

  for (let i = 0; i < channel.joins.length; i++) {
    const join = channel.joins[i]!;
    emitJoinDescribe(cb, channel, join, i);
  }

  if (channel.joins.length > 0) {
    for (const message of channel.messages) {
      emitMessageDescribe(cb, channel, channel.joins[0]!, message);
    }
    for (const push of channel.pushes) {
      emitPushDescribe(cb, channel, channel.joins[0]!, push);
    }
    emitLeaveDescribe(cb, channel, channel.joins[0]!);
  }

  return cb.toString();
}

/** Filename stem for a channel's test file — `LiveDoc` → `live_doc`. */
export function channelTestFileStem(channel: ChannelDef): string {
  return snakeCase(channel.name);
}

// ─── section emitters ────────────────────────────────────────────

function emitHeader(
  cb: CodeBuilder,
  channel: ChannelDef,
  channelImportPath: string
): void {
  cb.line(generatedHeader());
  cb.line(
    '// Contract tests for the generated channel class. Drives the channel'
  );
  cb.line(
    '// through a real WebSocket against the harness-service subprocess —'
  );
  cb.line(
    "// the same service Python tests connect to. Scenario closures are"
  );
  cb.line(
    "// serialized over an HTTP control API, not passed in-process."
  );
  cb.line();
  cb.line(
    'import { describe, it, expect, beforeEach, afterEach } from "vitest";'
  );
  cb.line("import {");
  cb.line("  ChannelJoinError,");
  cb.line("  ChannelReplyError,");
  cb.line("  HarnessServiceClient,");
  cb.line("  type HarnessSocket,");
  cb.line('} from "@archastro/channel-harness";');
  cb.line(`import { ${channel.className} } from "${channelImportPath}";`);
  cb.line();
  cb.line("interface Rig {");
  cb.line("  client: HarnessServiceClient;");
  cb.line("  socket: HarnessSocket;");
  cb.line("}");
  cb.line();
  cb.line(
    "// Check the env vars inside bootHarness() rather than at module scope:"
  );
  cb.line(
    "// a module-level throw would surface as a vitest collection error for the"
  );
  cb.line(
    "// whole file, while a thrown inside bootHarness() becomes a normal test"
  );
  cb.line("// failure that doesn't tear down the rest of the suite.");
  cb.line("async function bootHarness(): Promise<Rig> {");
  cb.line("  const wsUrl = process.env.ARCHASTRO_HARNESS_WS_URL;");
  cb.line("  const controlUrl = process.env.ARCHASTRO_HARNESS_CONTROL_URL;");
  cb.line("  if (!wsUrl || !controlUrl) {");
  cb.line("    throw new Error(");
  cb.line(
    '      "Channel contract tests require ARCHASTRO_HARNESS_WS_URL and " +'
  );
  cb.line(
    '        "ARCHASTRO_HARNESS_CONTROL_URL — set by global-setup.ts."'
  );
  cb.line("    );");
  cb.line("  }");
  cb.line(
    "  const client = new HarnessServiceClient({ wsUrl, controlUrl });"
  );
  cb.line("  await client.reset();");
  cb.line("  const socket = await client.openSocket();");
  cb.line("  return { client, socket };");
  cb.line("}");
  cb.line();
}

function emitHelpers(cb: CodeBuilder): void {
  cb.line("function nextPush(");
  cb.line("  subscribe: (cb: (payload: unknown) => void) => () => void,");
  cb.line("  timeoutMs = 500");
  cb.line("): Promise<unknown> {");
  cb.line("  return new Promise((resolve, reject) => {");
  cb.line("    let settled = false;");
  cb.line("    let unsubscribe: (() => void) | null = null;");
  cb.line("    const timer = setTimeout(() => {");
  cb.line("      if (settled) return;");
  cb.line("      settled = true;");
  cb.line("      unsubscribe?.();");
  cb.line('      reject(new Error("push not received in time"));');
  cb.line("    }, timeoutMs);");
  cb.line("    unsubscribe = subscribe((payload) => {");
  cb.line("      if (settled) return;");
  cb.line("      settled = true;");
  cb.line("      clearTimeout(timer);");
  cb.line("      unsubscribe?.();");
  cb.line("      resolve(payload);");
  cb.line("    });");
  cb.line("    if (settled) unsubscribe();");
  cb.line("  });");
  cb.line("}");
  cb.line();
}

function emitRigLifecycle(cb: CodeBuilder): void {
  cb.line("let rig: Rig;");
  cb.line("beforeEach(async () => {");
  cb.line("  rig = await bootHarness();");
  cb.line("});");
  cb.line("afterEach(() => {");
  cb.line("  rig.client.closeAllSockets();");
  cb.line("});");
  cb.line();
}

function emitJoinDescribe(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number
): void {
  const joinMethod = joinMethodName(join, index, channel.joins.length);
  const topic = resolveTopic(join);
  const payloadParams = joinPayloadParams(join);
  const requiredPayload = payloadParams.filter((p) => p.required);
  const hasRequiredPayload = requiredPayload.length > 0;
  const happyPayload = buildObjectLiteral(payloadParams);
  const joinArgs = joinCallArgs(topic.params, happyPayload, payloadParams);
  const joinArgsEmpty = joinCallArgs(topic.params, "{}", payloadParams);

  cb.line(
    `describe("${channel.className}.${joinMethod} (${join.topicPattern})", () => {`
  );
  cb.indent();
  emitRigLifecycle(cb);

  cb.line('it("joins and receives a contract-valid reply", async () => {');
  cb.indent();
  cb.line(
    `const channel = await ${channel.className}.${joinMethod}(${joinArgs});`
  );
  cb.line(`expect(channel).toBeInstanceOf(${channel.className});`);
  cb.line("expect(channel.joinResponse).toBeDefined();");
  cb.dedent();
  cb.line("});");
  cb.line();

  cb.line(
    'it("surfaces an application-level error reply as ChannelJoinError", async () => {'
  );
  cb.indent();
  cb.line("await rig.client.registerScenario({");
  cb.line(`  topic: ${JSON.stringify(topic.concrete)},`);
  cb.line(
    '  onJoin: [{ type: "replyError", payload: { reason: "test_error" } }],'
  );
  cb.line("});");
  cb.line();
  cb.line(
    `const err = await ${channel.className}.${joinMethod}(${joinArgs}).catch((e: unknown) => e);`
  );
  cb.line("expect(err).toBeInstanceOf(ChannelJoinError);");
  cb.line(
    'expect((err as ChannelJoinError).response).toEqual({ reason: "test_error" });'
  );
  cb.dedent();
  cb.line("});");

  if (hasRequiredPayload) {
    cb.line();
    cb.line(
      'it("rejects with ChannelJoinError when required params are missing", async () => {'
    );
    cb.indent();
    cb.line("await expect(");
    cb.line(
      "  // @ts-expect-error — deliberately violating the generated type to prove"
    );
    cb.line(
      "  // the server enforces the contract regardless of TS-level guards."
    );
    cb.line(`  ${channel.className}.${joinMethod}(${joinArgsEmpty})`);
    cb.line(").rejects.toBeInstanceOf(ChannelJoinError);");
    cb.dedent();
    cb.line("});");
  }

  cb.dedent();
  cb.line("});");
  cb.line();
}

function emitMessageDescribe(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  message: ChannelMessageDef
): void {
  const methodName = messageMethodName(message.event);
  const topic = resolveTopic(firstJoin);
  const joinMethod = joinMethodName(firstJoin, 0, channel.joins.length);
  const payloadParams = joinPayloadParams(firstJoin);
  const joinArgs = joinCallArgs(
    topic.params,
    buildObjectLiteral(payloadParams),
    payloadParams
  );

  const msgRequired = message.params.filter((p) => p.required);
  const msgHappyPayload = buildObjectLiteral(message.params);

  cb.line(
    `describe("${channel.className}.${methodName} (${message.event})", () => {`
  );
  cb.indent();
  emitRigLifecycle(cb);

  cb.line('it("sends a valid push and receives a contract-valid reply", async () => {');
  cb.indent();
  cb.line("await rig.client.registerScenario({");
  cb.line(`  topic: ${JSON.stringify(topic.concrete)},`);
  cb.line('  onJoin: [{ type: "autoReply" }],');
  cb.line("  onMessage: {");
  cb.line(
    `    ${JSON.stringify(message.event)}: [{ type: "autoReply" }],`
  );
  cb.line("  },");
  cb.line("});");
  cb.line();
  cb.line(
    `const channel = await ${channel.className}.${joinMethod}(${joinArgs});`
  );
  cb.line(`const reply = await channel.${methodName}(${msgHappyPayload});`);
  cb.line("expect(reply).toBeDefined();");
  cb.line();
  cb.line(
    `const observed = await rig.client.observations(${JSON.stringify(topic.concrete)}, ${JSON.stringify(message.event)});`
  );
  cb.line("expect(observed).toHaveLength(1);");
  if (msgRequired.length > 0) {
    cb.line(
      `expect(observed[0]!.params).toEqual(expect.objectContaining(${buildObjectLiteral(msgRequired)}));`
    );
  } else {
    cb.line("expect(observed[0]!.params).toBeDefined();");
  }
  cb.dedent();
  cb.line("});");

  if (msgRequired.length > 0) {
    cb.line();
    cb.line(
      'it("rejects with ChannelReplyError when required params are missing", async () => {'
    );
    cb.indent();
    cb.line("await rig.client.registerScenario({");
    cb.line(`  topic: ${JSON.stringify(topic.concrete)},`);
    cb.line('  onJoin: [{ type: "autoReply" }],');
    cb.line("});");
    cb.line(
      `const channel = await ${channel.className}.${joinMethod}(${joinArgs});`
    );
    cb.line();
    cb.line(
      `await expect(channel.${methodName}({})).rejects.toBeInstanceOf(ChannelReplyError);`
    );
    cb.dedent();
    cb.line("});");
  }

  cb.dedent();
  cb.line("});");
  cb.line();
}

function emitPushDescribe(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  push: ChannelPushDef
): void {
  const handlerName = pushHandlerName(push.event);
  const topic = resolveTopic(firstJoin);
  const joinMethod = joinMethodName(firstJoin, 0, channel.joins.length);
  const payloadParams = joinPayloadParams(firstJoin);
  const joinArgs = joinCallArgs(
    topic.params,
    buildObjectLiteral(payloadParams),
    payloadParams
  );

  cb.line(
    `describe("${channel.className}.${handlerName} (${push.event})", () => {`
  );
  cb.indent();
  emitRigLifecycle(cb);

  cb.line(
    `it("delivers contract-valid payloads to ${handlerName}", async () => {`
  );
  cb.indent();
  cb.line("await rig.client.registerScenario({");
  cb.line(`  topic: ${JSON.stringify(topic.concrete)},`);
  cb.line("  onJoin: [");
  cb.line('    { type: "autoReply" },');
  cb.line(
    `    { type: "autoPush", event: ${JSON.stringify(push.event)} },`
  );
  cb.line("  ],");
  cb.line("});");
  cb.line();
  cb.line(
    `const channel = await ${channel.className}.${joinMethod}(${joinArgs});`
  );
  cb.line(
    `const payload = await nextPush((cb) => channel.${handlerName}(cb));`
  );
  cb.line("expect(payload).toBeDefined();");
  cb.dedent();
  cb.line("});");

  cb.dedent();
  cb.line("});");
  cb.line();
}

function emitLeaveDescribe(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef
): void {
  const topic = resolveTopic(firstJoin);
  const joinMethod = joinMethodName(firstJoin, 0, channel.joins.length);
  const payloadParams = joinPayloadParams(firstJoin);
  const joinArgs = joinCallArgs(
    topic.params,
    buildObjectLiteral(payloadParams),
    payloadParams
  );

  cb.line(`describe("${channel.className}.leave", () => {`);
  cb.indent();
  emitRigLifecycle(cb);
  cb.line('it("leaves cleanly through the generated leave()", async () => {');
  cb.indent();
  cb.line("await rig.client.registerScenario({");
  cb.line(`  topic: ${JSON.stringify(topic.concrete)},`);
  cb.line('  onJoin: [{ type: "autoReply" }],');
  cb.line("});");
  cb.line(
    `const channel = await ${channel.className}.${joinMethod}(${joinArgs});`
  );
  cb.line("await channel.leave();");
  cb.dedent();
  cb.line("});");
  cb.dedent();
  cb.line("});");
  cb.line();
}

// ─── helpers ─────────────────────────────────────────────────────

interface ResolvedTopic {
  pattern: string;
  concrete: string;
  params: Array<{ camelName: string; rawName: string; stringValue: string }>;
}

function resolveTopic(join: ChannelJoinDef): ResolvedTopic {
  const params: ResolvedTopic["params"] = [];
  const concrete = join.topicPattern.replace(/\{(\w+)\}/g, (_, raw: string) => {
    const camel = camelCase(raw);
    const stringValue = dummyStringValue(camel);
    params.push({ camelName: camel, rawName: raw, stringValue });
    return stringValue;
  });
  return { pattern: join.topicPattern, concrete, params };
}

function joinMethodName(
  join: ChannelJoinDef,
  index: number,
  total: number
): string {
  if (join.name) return camelCase(join.name);
  return total > 1 ? `join${index + 1}` : "join";
}

function messageMethodName(event: string): string {
  return camelCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function pushHandlerName(event: string): string {
  return "on" + pascalCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function joinPayloadParams(join: ChannelJoinDef): ParamDef[] {
  const topicVars = new Set(
    [...join.topicPattern.matchAll(/\{(\w+)\}/g)].map(([, n]) => snakeCase(n!))
  );
  // Params preserve the spec's original casing; topic pattern vars are
  // typically snake_case already. Normalize both before comparing so a
  // `{docId}` pattern still matches a `doc_id` param and vice versa.
  return join.params.filter((p) => !topicVars.has(snakeCase(p.name)));
}

function joinCallArgs(
  topicParams: ResolvedTopic["params"],
  payloadLiteral: string,
  payloadParams: ParamDef[]
): string {
  const parts = ["rig.socket"];
  for (const tp of topicParams) {
    parts.push(JSON.stringify(tp.stringValue));
  }
  if (payloadParams.length > 0) {
    parts.push(payloadLiteral);
  }
  return parts.join(", ");
}

function buildObjectLiteral(params: ParamDef[]): string {
  if (params.length === 0) return "{}";
  const parts = params.map(
    (p) => `${p.name}: ${generateDummyValue(p.type, p.name, "typescript")}`
  );
  return `{ ${parts.join(", ")} }`;
}

function dummyStringValue(fieldName: string): string {
  const lit = generateDummyValue(
    { kind: "primitive", type: "string" },
    fieldName,
    "typescript"
  );
  if (lit.startsWith('"') && lit.endsWith('"')) {
    return lit.slice(1, -1);
  }
  return lit;
}
