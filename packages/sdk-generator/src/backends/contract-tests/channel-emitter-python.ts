import type {
  ChannelDef,
  ChannelJoinDef,
  ChannelMessageDef,
  ChannelPushDef,
  ParamDef,
} from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import { generateDummyValue } from "./value-generator.js";

/**
 * Emit a pytest channel contract test file for a single channel.
 *
 * The output drives the generated Python channel class (e.g.
 * `LiveDocChannel`) through a real WebSocket against the same
 * harness-service subprocess the TS tests drive. Scenarios are JSON
 * registered over HTTP via `HarnessServiceClient`; there is no
 * in-process shortcut.
 *
 * The test file expects a session fixture `harness_service` (provided by
 * `conftest.py` — see `emitPythonChannelConftest`) that returns the running
 * service's URLs.
 *
 * @param channel                Parsed channel from the AST.
 * @param channelImportModule    Python module path to the generated channel
 *                                (e.g. `archastro.platform.channels.live_doc`).
 */
export function emitPythonChannelContractTestFile(
  channel: ChannelDef,
  channelImportModule: string
): string {
  const cb = new CodeBuilder("    ");

  emitHeader(cb, channel, channelImportModule);
  emitFixture(cb);

  for (let i = 0; i < channel.joins.length; i++) {
    const join = channel.joins[i]!;
    emitJoinTests(cb, channel, join, i);
  }

  if (channel.joins.length > 0) {
    for (const message of channel.messages) {
      emitMessageTests(cb, channel, channel.joins[0]!, message);
    }
    for (const push of channel.pushes) {
      emitPushTest(cb, channel, channel.joins[0]!, push);
    }
    emitLeaveTest(cb, channel, channel.joins[0]!);
  }

  return cb.toString();
}

/** Filename stem for a channel's test file — `LiveDoc` → `test_live_doc`. */
export function pythonChannelTestFileStem(channel: ChannelDef): string {
  return `test_${snakeCase(channel.name)}`;
}

// ─── sections ───────────────────────────────────────────────────

function emitHeader(
  cb: CodeBuilder,
  channel: ChannelDef,
  channelImportModule: string
): void {
  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();
  cb.line('"""');
  cb.line(
    `Contract tests for ${channel.className} — generated from the channel spec.`
  );
  cb.line();
  cb.line(
    "Drives the generated channel class through a real WebSocket against the"
  );
  cb.line(
    "harness-service subprocess (spawned by conftest.py). Scenarios are"
  );
  cb.line(
    "registered over HTTP — there is no in-process closure shortcut, so the"
  );
  cb.line(
    "same service Python, TypeScript, and any future language can target."
  );
  cb.line('"""');
  cb.line();
  cb.line("import asyncio");
  cb.line();
  cb.line("import pytest");
  cb.line("import pytest_asyncio");
  cb.line();
  cb.line("from archastro.phx_channel import HarnessServiceClient");
  cb.line("from archastro.phx_channel.channel import ChannelError");
  cb.line(
    `from ${channelImportModule} import ${channel.className}`
  );
  cb.line();
  cb.line(
    "# Mark every coroutine in this file as async. Generated tests are imported"
  );
  cb.line(
    "# into arbitrary SDK projects whose pytest config may or may not set"
  );
  cb.line(
    "# asyncio_mode=auto — pytestmark keeps them runnable either way."
  );
  cb.line("pytestmark = pytest.mark.asyncio");
  cb.line();
}

function emitFixture(cb: CodeBuilder): void {
  cb.line("@pytest_asyncio.fixture");
  cb.pyBlock("async def rig(harness_service)", () => {
    cb.line("client = HarnessServiceClient(");
    cb.line('    ws_url=harness_service["wsUrl"],');
    cb.line('    control_url=harness_service["controlUrl"],');
    cb.line(")");
    cb.line("await client.reset()");
    cb.line("socket = await client.open_socket()");
    cb.pyBlock("try", () => {
      cb.line("yield (client, socket)");
    });
    cb.pyBlock("finally", () => {
      cb.line("await client.close()");
    });
  });
  cb.line();
}

function emitJoinTests(
  cb: CodeBuilder,
  channel: ChannelDef,
  join: ChannelJoinDef,
  index: number
): void {
  const joinMethod = pythonJoinMethodName(join, index, channel.joins.length);
  const topic = resolveTopic(join);
  const payloadParams = joinPayloadParams(join);
  const requiredPayload = payloadParams.filter((p) => p.required);
  const hasRequiredPayload = requiredPayload.length > 0;
  const happyCall = joinCall(channel.className, joinMethod, topic, payloadParams);

  const prefix = testPrefix(channel, joinMethod);

  cb.pyBlock(`async def ${prefix}_joins_and_receives_contract_valid_reply(rig)`, () => {
    cb.line("_, socket = rig");
    cb.line(`channel = await ${happyCall}`);
    cb.line(`assert isinstance(channel, ${channel.className})`);
    cb.line("assert channel.join_response is not None");
  });
  cb.line();

  cb.pyBlock(
    `async def ${prefix}_surfaces_server_error_reply_as_channel_error(rig)`,
    () => {
      cb.line("client, socket = rig");
      cb.line("await client.register_scenario({");
      cb.line(`    "topic": ${pyString(topic.concrete)},`);
      cb.line(
        '    "onJoin": [{"type": "replyError", "payload": {"reason": "test_error"}}],'
      );
      cb.line("})");
      cb.pyBlock('with pytest.raises(ChannelError)', () => {
        cb.line(`await ${happyCall}`);
      });
    }
  );
  cb.line();

  if (hasRequiredPayload) {
    cb.pyBlock(
      `async def ${prefix}_rejects_when_required_params_missing(rig)`,
      () => {
        cb.line("_, socket = rig");
        cb.line(
          `# Drive the raw socket to bypass the typed kwarg guard — the server`
        );
        cb.line(`# must enforce the contract regardless of SDK-side type checks.`);
        cb.line(
          `channel = socket.channel(${pyString(topic.concrete)})`
        );
        cb.pyBlock('with pytest.raises(ChannelError)', () => {
          cb.line("await channel.join({})");
        });
      }
    );
    cb.line();
  }
}

function emitMessageTests(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  message: ChannelMessageDef
): void {
  const methodName = pythonMessageMethodName(message.event);
  const topic = resolveTopic(firstJoin);
  const joinMethod = pythonJoinMethodName(
    firstJoin,
    0,
    channel.joins.length
  );
  const payloadParams = joinPayloadParams(firstJoin);
  const happyCall = joinCall(
    channel.className,
    joinMethod,
    topic,
    payloadParams
  );
  const msgRequired = message.params.filter((p) => p.required);
  const msgDict = pyDictLiteralForWire(message.params);
  const prefix = testPrefix(channel, methodName);

  cb.pyBlock(
    `async def ${prefix}_sends_valid_push_and_receives_contract_valid_reply(rig)`,
    () => {
      cb.line("client, socket = rig");
      cb.line("await client.register_scenario({");
      cb.line(`    "topic": ${pyString(topic.concrete)},`);
      cb.line('    "onJoin": [{"type": "autoReply"}],');
      cb.line('    "onMessage": {');
      cb.line(
        `        ${pyString(message.event)}: [{"type": "autoReply"}],`
      );
      cb.line("    },");
      cb.line("})");
      cb.line(`channel = await ${happyCall}`);
      cb.line(`reply = await channel.${methodName}(${msgDict})`);
      cb.line('assert reply["status"] == "ok"');
      cb.line();
      cb.line(
        `observed = await client.observations(${pyString(topic.concrete)}, ${pyString(message.event)})`
      );
      cb.line("assert len(observed) == 1");
      if (msgRequired.length > 0) {
        for (const p of msgRequired) {
          const py = generatePyValue(p);
          cb.line(
            `assert observed[0]["params"][${pyString(p.name)}] == ${py}`
          );
        }
      } else {
        cb.line('assert observed[0]["params"] is not None');
      }
    }
  );
  cb.line();

  if (msgRequired.length > 0) {
    cb.pyBlock(
      `async def ${prefix}_returns_error_envelope_when_required_missing(rig)`,
      () => {
        cb.line("client, socket = rig");
        cb.line("await client.register_scenario({");
        cb.line(`    "topic": ${pyString(topic.concrete)},`);
        cb.line('    "onJoin": [{"type": "autoReply"}],');
        cb.line("})");
        cb.line(`channel = await ${happyCall}`);
        cb.line(`reply = await channel.${methodName}({})`);
        cb.line('assert reply["status"] == "error"');
      }
    );
    cb.line();
  }
}

function emitPushTest(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef,
  push: ChannelPushDef
): void {
  const handlerName = pythonPushHandlerName(push.event);
  const topic = resolveTopic(firstJoin);
  const joinMethod = pythonJoinMethodName(
    firstJoin,
    0,
    channel.joins.length
  );
  const payloadParams = joinPayloadParams(firstJoin);
  const happyCall = joinCall(
    channel.className,
    joinMethod,
    topic,
    payloadParams
  );
  const prefix = testPrefix(channel, handlerName);

  cb.pyBlock(
    `async def ${prefix}_delivers_contract_valid_payloads(rig)`,
    () => {
      cb.line("client, socket = rig");
      cb.line("await client.register_scenario({");
      cb.line(`    "topic": ${pyString(topic.concrete)},`);
      cb.line('    "onJoin": [');
      cb.line('        {"type": "autoReply"},');
      cb.line(
        `        {"type": "autoPush", "event": ${pyString(push.event)}},`
      );
      cb.line("    ],");
      cb.line("})");
      cb.line(`channel = await ${happyCall}`);
      cb.line(
        "future: asyncio.Future = asyncio.get_event_loop().create_future()"
      );
      cb.pyBlock("def handler(payload)", () => {
        cb.pyBlock("if not future.done()", () => {
          cb.line("future.set_result(payload)");
        });
      });
      cb.line(`channel.${handlerName}(handler)`);
      cb.line("payload = await asyncio.wait_for(future, timeout=1.0)");
      cb.line("assert payload is not None");
    }
  );
  cb.line();
}

function emitLeaveTest(
  cb: CodeBuilder,
  channel: ChannelDef,
  firstJoin: ChannelJoinDef
): void {
  const topic = resolveTopic(firstJoin);
  const joinMethod = pythonJoinMethodName(
    firstJoin,
    0,
    channel.joins.length
  );
  const payloadParams = joinPayloadParams(firstJoin);
  const happyCall = joinCall(
    channel.className,
    joinMethod,
    topic,
    payloadParams
  );
  const prefix = testPrefix(channel, "leave");

  cb.pyBlock(
    `async def ${prefix}_leaves_cleanly_through_generated_leave(rig)`,
    () => {
      cb.line("client, socket = rig");
      cb.line("await client.register_scenario({");
      cb.line(`    "topic": ${pyString(topic.concrete)},`);
      cb.line('    "onJoin": [{"type": "autoReply"}],');
      cb.line("})");
      cb.line(`channel = await ${happyCall}`);
      cb.line("await channel.leave()");
    }
  );
  cb.line();
}

// ─── helpers ────────────────────────────────────────────────────

interface ResolvedTopic {
  pattern: string;
  concrete: string;
  params: Array<{ pyName: string; rawName: string; stringValue: string }>;
}

function resolveTopic(join: ChannelJoinDef): ResolvedTopic {
  const params: ResolvedTopic["params"] = [];
  const concrete = join.topicPattern.replace(/\{(\w+)\}/g, (_, raw: string) => {
    const pyName = snakeCase(raw);
    const stringValue = dummyStringValue(pyName);
    params.push({ pyName, rawName: raw, stringValue });
    return stringValue;
  });
  return { pattern: join.topicPattern, concrete, params };
}

function pythonJoinMethodName(
  join: ChannelJoinDef,
  index: number,
  total: number
): string {
  if (join.name) return snakeCase(join.name);
  return total > 1 ? `join_${index + 1}` : "join";
}

function pythonMessageMethodName(event: string): string {
  return snakeCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function pythonPushHandlerName(event: string): string {
  return "on_" + snakeCase(event.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function joinPayloadParams(join: ChannelJoinDef): ParamDef[] {
  const topicVars = new Set(
    [...join.topicPattern.matchAll(/\{(\w+)\}/g)].map(([, n]) => n!)
  );
  // Use snake_case for comparison because the Python generator snake_cases
  // kwargs; params whose snake_case matches a topic var name are the topic
  // params and don't appear in the payload.
  const topicSnakeSet = new Set(Array.from(topicVars).map((n) => snakeCase(n)));
  return join.params.filter((p) => !topicSnakeSet.has(snakeCase(p.name)));
}

function joinCall(
  className: string,
  methodName: string,
  topic: ResolvedTopic,
  payloadParams: ParamDef[]
): string {
  const parts: string[] = ["socket"];
  for (const tp of topic.params) {
    parts.push(pyString(tp.stringValue));
  }
  if (payloadParams.length > 0) {
    // Python generator takes payload params as keyword args in snake_case.
    for (const p of payloadParams) {
      const kwarg = snakeCase(p.name);
      parts.push(`${kwarg}=${generatePyValue(p)}`);
    }
  }
  return `${className}.${methodName}(${parts.join(", ")})`;
}

/** Build a dict literal keyed by the SPEC field name (wire key). */
function pyDictLiteralForWire(params: ParamDef[]): string {
  if (params.length === 0) return "{}";
  const entries = params.map(
    (p) => `${pyString(p.name)}: ${generatePyValue(p)}`
  );
  return `{${entries.join(", ")}}`;
}

function generatePyValue(param: ParamDef): string {
  return generateDummyValue(param.type, param.name, "python");
}

function dummyStringValue(fieldName: string): string {
  const lit = generateDummyValue(
    { kind: "primitive", type: "string" },
    fieldName,
    "python"
  );
  if (lit.startsWith('"') && lit.endsWith('"')) return lit.slice(1, -1);
  return lit;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function testPrefix(channel: ChannelDef, suffix: string): string {
  return `test_${snakeCase(channel.name)}_${suffix}`;
}

// Keep reference to pascalCase so tree-shake doesn't flag it; channel-emitter
// uses pascalCase for handler names in other generators — not here, but
// keeping it imported makes the cross-language parity obvious when scanning.
void pascalCase;
