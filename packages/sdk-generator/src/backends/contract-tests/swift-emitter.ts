import type { OperationDef, ResourceDef, SdkSpec } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { pascalCase, snakeCase } from "../../utils/naming.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "../swift/identifiers.js";
import {
  buildOperationSwiftNames,
  hasInlineBody,
  inputKey,
  swiftMethodName,
} from "../swift/resource-emitter.js";
import { swiftResponseShape } from "../swift/response-type.js";
import { prepareSwiftSpec } from "../swift/index.js";
import {
  buildMethodCalls,
  buildStreamCalls,
  groupByTopLevelResource,
  type MethodCallInfo,
} from "./method-chain-builder.js";
import { generateDummyValue } from "./value-generator.js";
import { swiftBodyValue } from "./swift-values.js";
import {
  emitSwiftChannelContractTestFile,
  swiftChannelTestFileStem,
} from "./channel-emitter-swift.js";

type GeneratedFiles = Record<string, string>;

/** Directory (relative to the package root) that generated tests land in. */
export const SWIFT_TESTS_DIR = "Tests/ArchAstroPlatformContractTests";

/**
 * Generate Swift (swift-testing) contract test files from the SdkSpec AST.
 *
 * Produces (under Tests/ArchAstroPlatformContractTests/):
 * - {V1}/{Resource}ContractTests.swift    — per-resource REST tests (Prism)
 * - Channels/{Channel}ContractTests.swift — per-channel harness tests
 * - Streams/{Resource}StreamContractTests.swift — SSE harness tests
 *
 * The handwritten `Support/` module in the consuming package provides
 * `ContractSupport` (Prism/harness lifecycle + client factories) and
 * `isoDate` — mirroring how the Python SDK's handwritten runtime provides
 * `HarnessServiceClient`.
 */
export function emitSwiftContractTests(
  spec: SdkSpec,
  options: { outDir: string }
): GeneratedFiles {
  const { spec: prepared, registry } = prepareSwiftSpec(spec);
  const files: GeneratedFiles = {};
  const testDir = `${options.outDir}/${SWIFT_TESTS_DIR}`;

  // REST tests per version.
  for (const versionSet of prepared.versions) {
    const calls = buildMethodCalls(prepared, versionSet, "swift");
    const groups = groupByTopLevelResource(calls);
    const versionDir = versionSet.version.toUpperCase();

    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/${versionDir}/${pascalCase(resourceName)}ContractTests.swift`;
      files[filePath] = emitResourceTestFile(
        prepared,
        resourceName,
        resourceCalls,
        registry
      );
    }
  }

  // Channel tests.
  for (const channel of prepared.channels) {
    const filePath = `${testDir}/Channels/${swiftChannelTestFileStem(channel)}.swift`;
    files[filePath] = emitSwiftChannelContractTestFile(channel, registry);
  }

  // SSE stream tests.
  for (const versionSet of prepared.versions) {
    const streamCalls = buildStreamCalls(prepared, versionSet, "swift");
    const groups = groupByTopLevelResource(streamCalls);
    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/Streams/${pascalCase(resourceName)}StreamContractTests.swift`;
      files[filePath] = emitStreamTestFile(
        prepared,
        resourceName,
        resourceCalls,
        registry
      );
    }
  }

  return files;
}

// ─── Shared call rendering ───────────────────────────────────────

/**
 * `client.v1.agents.agentComputers` — camelCased accessor chain from the
 * builder's raw chain (`client.v1.agents.agent_computers`).
 */
function swiftAccessorChain(call: MethodCallInfo): string {
  const segments = call.accessorChain.split(".");
  return segments
    .map((segment, i) =>
      i < 2 ? segment : uniqueSwiftMemberNames([segment])[0]!
    )
    .join(".");
}

/** Build the labeled Swift argument list for a call. */
function buildSwiftArgs(
  spec: SdkSpec,
  call: MethodCallInfo,
  registry: SwiftNameRegistry
): string {
  const op = call.operation;
  const resource = call.resource;
  const names = buildOperationSwiftNames(op, resource);
  const parts: string[] = [];

  for (let i = 0; i < resource.scopeParams.length; i++) {
    const param = resource.scopeParams[i]!;
    parts.push(
      `${names.scope[i]}: ${generateDummyValue(param.type, param.name, "swift")}`
    );
  }
  for (let i = 0; i < op.pathParams.length; i++) {
    const param = op.pathParams[i]!;
    parts.push(
      `${names.path[i]}: ${generateDummyValue(param.type, param.name, "swift")}`
    );
  }
  if (op.body) {
    const inputStructName = hasInlineBody(op)
      ? registry.lookup(inputKey(op))
      : undefined;
    parts.push(`${names.body}: ${swiftBodyValue(op.body, inputStructName, spec.schemas)}`);
  }
  for (let i = 0; i < op.queryParams.length; i++) {
    const param = op.queryParams[i]!;
    if (!param.required) continue;
    parts.push(
      `${names.query[i]}: ${generateDummyValue(param.type, param.name, "swift")}`
    );
  }

  return parts.join(", ");
}

function buildTestName(call: MethodCallInfo, suffix: string): string {
  const parts = call.groupLabel.split(" > ").map((s) => snakeCase(s));
  return `${parts.join("_")}_${snakeCase(call.methodName)}_${suffix}`;
}

// ─── REST tests ──────────────────────────────────────────────────

function emitResourceTestFile(
  spec: SdkSpec,
  resourceName: string,
  calls: MethodCallInfo[],
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
    `@Suite(.serialized) struct ${pascalCase(resourceName)}ContractTests`,
    () => {
      for (const call of calls) {
        emitHappyPathTest(cb, spec, call, registry);
        emitErrorTests(cb, spec, call, registry);
      }
    }
  );

  return cb.toString();
}

function emitHappyPathTest(
  cb: CodeBuilder,
  spec: SdkSpec,
  call: MethodCallInfo,
  registry: SwiftNameRegistry
): void {
  const testName = buildTestName(call, "success");
  const args = buildSwiftArgs(spec, call, registry);
  const chain = swiftAccessorChain(call);
  const method = swiftMethodName(call.operation);
  const methodCall = `${chain}.${method}(${args})`;
  const shape = swiftResponseShape(call.operation);

  cb.line();
  cb.block(`@Test func ${testName}() async throws`, () => {
    cb.line("let client = try await ContractSupport.client()");
    switch (shape) {
      case "void":
        cb.line(`try await ${methodCall}`);
        break;
      case "raw":
        cb.line(`let result = try await ${methodCall}`);
        cb.line("#expect(!result.mimeType.isEmpty)");
        break;
      case "model": {
        cb.line(`let result = try await ${methodCall}`);
        if (returnTypeHasDataArray(call.operation)) {
          cb.line("ContractSupport.use(result.data)");
        }
        cb.line("ContractSupport.use(result)");
        break;
      }
      case "model_list":
        cb.line(`let result = try await ${methodCall}`);
        cb.line("#expect(result.count >= 0)");
        break;
      case "untyped":
        cb.line(`let result = try await ${methodCall}`);
        cb.line("#expect(result != JSONValue.null)");
        break;
    }
  });
}

/** True when the return type is pagination-shaped ({data: [...]}). */
function returnTypeHasDataArray(op: OperationDef): boolean {
  if (op.returnType.kind !== "object") return false;
  const dataField = op.returnType.fields.find((f) => f.name === "data");
  return Boolean(dataField && dataField.type.kind === "array");
}

function emitErrorTests(
  cb: CodeBuilder,
  spec: SdkSpec,
  call: MethodCallInfo,
  registry: SwiftNameRegistry
): void {
  for (const code of call.errorCodes) {
    if (code < 400) continue;
    const testName = buildTestName(call, `error_${code}`);
    const args = buildSwiftArgs(spec, call, registry);
    const chain = swiftAccessorChain(call);
    const method = swiftMethodName(call.operation);
    const methodCall = `${chain}.${method}(${args})`;
    const isVoid = swiftResponseShape(call.operation) === "void";
    const invocation = isVoid
      ? `try await ${methodCall}`
      : `_ = try await ${methodCall}`;

    cb.line();
    cb.block(`@Test func ${testName}() async throws`, () => {
      cb.line(`let client = try await ContractSupport.errorClient(${code})`);
      cb.block("do", () => {
        cb.line(invocation);
        cb.line(`Issue.record("Expected ApiError with status ${code}")`);
      });
      cb.line("catch let error as ApiError {");
      cb.indent();
      cb.line(`#expect(error.status == ${code})`);
      cb.dedent();
      cb.line("}");
    });
  }
}

// ─── SSE stream tests ────────────────────────────────────────────

function emitStreamTestFile(
  spec: SdkSpec,
  resourceName: string,
  calls: MethodCallInfo[],
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
    `@Suite(.serialized, .enabled(if: ContractSupport.channelTestsEnabled)) struct ${pascalCase(resourceName)}StreamContractTests`,
    () => {
      for (const call of calls) emitStreamTests(cb, spec, call, registry);
    }
  );

  return cb.toString();
}

function emitStreamTests(
  cb: CodeBuilder,
  spec: SdkSpec,
  call: MethodCallInfo,
  registry: SwiftNameRegistry
): void {
  const routeKey = `${call.httpMethod} ${call.httpPath}`;
  const events = call.operation.streaming?.events ?? [];
  const args = buildSwiftArgs(spec, call, registry);
  const method = swiftMethodName(call.operation);
  const methodCall = `${swiftAccessorChain(call)}.${method}(${args})`;

  const autoEmitActions = events
    .map((e) => `["type": "autoEmit", "event": ${swiftString(e.event)}]`)
    .join(", ");
  const expectedNames = events.map((e) => swiftString(e.event)).join(", ");

  const emitClientLine = (): void => {
    cb.line("let client = PlatformClient(");
    cb.indent();
    cb.line("baseUrl: harness.controlURL,");
    cb.line('accessToken: "test-token",');
    cb.line('defaultHeaders: ["x-archastro-api-key": "pk_test-key"]');
    cb.dedent();
    cb.line(")");
  };

  // Happy path: the SDK yields the declared events, in order.
  cb.line();
  cb.block(
    `@Test func ${buildTestName(call, "yields_sse_events")}() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarness { harness in");
      cb.indent();
      cb.line("try await harness.registerStreamScenario([");
      cb.indent();
      cb.line(`"route": ${swiftString(routeKey)},`);
      cb.line(`"actions": [${autoEmitActions}],`);
      cb.dedent();
      cb.line("])");
      emitClientLine();
      cb.line("var events: [String] = []");
      cb.block(`for try await event in ${methodCall}`, () => {
        cb.line("events.append(event.event)");
      });
      cb.line(`#expect(events == [${expectedNames}])`);
      cb.dedent();
      cb.line("}");
    }
  );

  // Error path: a non-2xx status surfaces as ApiError.
  cb.line();
  cb.block(
    `@Test func ${buildTestName(call, "rejects_non_2xx")}() async throws`,
    () => {
      cb.line("try await ContractSupport.withHarness { harness in");
      cb.indent();
      cb.line("try await harness.registerStreamScenario([");
      cb.indent();
      cb.line(`"route": ${swiftString(routeKey)},`);
      cb.line(
        '"actions": [["type": "status", "code": 402, "body": ["error": ["code": "plan_not_entitled"]]]],'
      );
      cb.dedent();
      cb.line("])");
      emitClientLine();
      cb.block("await #expect(throws: ApiError.self)", () => {
        cb.line(`for try await _ in ${methodCall} {}`);
      });
      cb.dedent();
      cb.line("}");
    }
  );
}

// Re-exports used by unit tests.
export { buildSwiftArgs, swiftAccessorChain };
export type { ResourceDef };
