import type {
  OperationDef,
  ResourceDef,
  SdkSpec,
  VersionedResourceSet,
} from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import {
  goExportedName,
  goFileStem,
  goString,
  uniqueGoFieldNames,
} from "../go/identifiers.js";
import { prepareGoSpec } from "../go/index.js";
import { uniqueVersionResources } from "../go/namespace-emitter.js";
import {
  buildResourceMembers,
  goMethodName,
  hasInlineBody,
  inputKey,
} from "../go/resource-emitter.js";
import { goResponseShape } from "../go/response-type.js";
import { renderGoFile } from "../go/type-map.js";
import {
  buildMethodCalls,
  buildStreamCalls,
  groupByTopLevelResource,
  type MethodCallInfo,
} from "./method-chain-builder.js";
import { generateDummyValue } from "./value-generator.js";
import {
  goBodyValue,
  goParamsValue,
  type GoValueContext,
} from "./go-values.js";
import {
  emitGoChannelContractTestFile,
  goChannelTestFileStem,
} from "./channel-emitter-go.js";

type GeneratedFiles = Record<string, string>;

/** Directory (relative to the module root) generated Go tests land in. */
export const GO_TESTS_DIR = "contracttests";

/** Go package the generated contract tests declare. */
export const GO_TESTS_PACKAGE = "contracttests";

/** Default import path of the generated SDK package. */
export const GO_DEFAULT_IMPORT_PATH = "github.com/ArchAstro/archastro-go/platform";

export interface GoContractTestOptions {
  outDir: string;
  /** Import path of the generated SDK package. */
  importPath?: string;
  /** Package alias generated tests reference the SDK through. */
  packageAlias?: string;
}

/**
 * Emission-wide state. Go test functions share one package namespace, so
 * every generated `TestXxx` name is uniquified across every file.
 */
interface GoTestNamer {
  used: Set<string>;
  claim(base: string): string;
}

function newTestNamer(): GoTestNamer {
  const used = new Set<string>();
  return {
    used,
    claim(base: string): string {
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}${suffix}`;
        suffix++;
      }
      used.add(candidate);
      return candidate;
    },
  };
}

/**
 * Generate Go contract test files from the SdkSpec AST.
 *
 * Produces (under contracttests/):
 * - {version}_{resource}_test.go — per-resource REST tests (Prism)
 * - channels_{channel}_test.go   — per-channel harness tests
 * - streams_{resource}_test.go   — SSE harness tests
 *
 * The handwritten support files in the same package provide the Prism and
 * channel-harness lifecycle (`restClient`, `withHarness`, `harnessClient`)
 * — mirroring how the Swift suite's `Support/` module and the Python
 * suite's `conftest.py` do it.
 */
export function emitGoContractTests(
  spec: SdkSpec,
  options: GoContractTestOptions
): GeneratedFiles {
  const { spec: prepared, registry } = prepareGoSpec(spec);
  const files: GeneratedFiles = {};
  const testDir = `${options.outDir}/${GO_TESTS_DIR}`;
  const ctx: GoValueContext = {
    pkg: options.packageAlias ?? "platform",
    registry,
    schemas: prepared.schemas,
  };
  const importPath = options.importPath ?? GO_DEFAULT_IMPORT_PATH;
  const namer = newTestNamer();

  // REST tests per version.
  for (const versionSet of prepared.versions) {
    const calls = buildMethodCalls(prepared, versionSet, "go");
    const groups = groupByTopLevelResource(calls);
    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/${goFileStem(versionSet.version)}_${goFileStem(resourceName)}_test.go`;
      files[filePath] = emitResourceTestFile(
        versionSet,
        resourceCalls,
        ctx,
        importPath,
        namer
      );
    }
  }

  // Channel tests.
  for (const channel of prepared.channels) {
    const filePath = `${testDir}/${goChannelTestFileStem(channel)}.go`;
    files[filePath] = emitGoChannelContractTestFile(
      channel,
      ctx,
      importPath,
      namer.claim.bind(namer)
    );
  }

  // SSE stream tests.
  for (const versionSet of prepared.versions) {
    const streamCalls = buildStreamCalls(prepared, versionSet, "go");
    const groups = groupByTopLevelResource(streamCalls);
    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/streams_${goFileStem(resourceName)}_test.go`;
      files[filePath] = emitStreamTestFile(
        versionSet,
        resourceCalls,
        ctx,
        importPath,
        namer
      );
    }
  }

  return files;
}

// ─── Shared call rendering ───────────────────────────────────────

/**
 * `client.V1.Agents.AgentComputers` — the Go accessor chain, resolved by
 * walking the resource tree so it always matches the field names the
 * namespace and resource emitters generated.
 */
export function goAccessorChain(
  versionSet: VersionedResourceSet,
  call: MethodCallInfo
): string {
  const segments = call.accessorChain.split(".").slice(2);
  const parts = ["client", versionSet.version.toUpperCase()];

  let level: ResourceDef[] = uniqueVersionResources(versionSet);
  let fieldNames = uniqueGoFieldNames(level.map((r) => r.name));

  for (const segment of segments) {
    const index = level.findIndex((r) => r.name === segment);
    if (index === -1) {
      // Defensive: an unmatched segment means the chain and the tree drifted.
      parts.push(goExportedName(segment));
      break;
    }
    parts.push(fieldNames[index]!);
    const resource = level[index]!;
    level = resource.children;
    fieldNames = buildResourceMembers(resource).childFields;
  }

  return parts.join(".");
}

/** Build the Go argument list for a call, after the leading context. */
function buildGoArgs(call: MethodCallInfo, ctx: GoValueContext): string[] {
  const op = call.operation;
  const resource = call.resource;
  const args: string[] = [];

  for (const param of resource.scopeParams) {
    args.push(generateDummyValue(param.type, param.name, "go"));
  }
  for (const param of op.pathParams) {
    args.push(generateDummyValue(param.type, param.name, "go"));
  }
  if (op.body) {
    const inputStructName = hasInlineBody(op)
      ? ctx.registry.lookup(inputKey(op))
      : undefined;
    args.push(goBodyValue(op.body, inputStructName, ctx));
  }
  if (op.queryParams.length > 0) {
    args.push(goParamsValue(op, ctx));
  }
  return args;
}

function buildTestName(
  versionSet: VersionedResourceSet,
  call: MethodCallInfo,
  suffix: string
): string {
  const groupParts = call.groupLabel.split(" > ").map(goExportedName).join("");
  return `Test${versionSet.version.toUpperCase()}${groupParts}${goExportedName(call.methodName)}${suffix}`;
}

function callExpression(
  versionSet: VersionedResourceSet,
  call: MethodCallInfo,
  ctx: GoValueContext
): string {
  const args = ["ctx", ...buildGoArgs(call, ctx)];
  return `${goAccessorChain(versionSet, call)}.${goMethodName(call.operation, call.resource)}(${args.join(", ")})`;
}

/**
 * Imports for one generated test file. The SDK package is only imported when
 * the file actually names a type from it — an unused import is a Go compile
 * error, and plenty of resources take no typed arguments at all.
 */
function testFileImports(
  importPath: string,
  packageAlias: string,
  body: string
): string[] {
  const imports = ["context", "testing"];
  if (body.includes(`${packageAlias}.`)) imports.push(importPath);
  return imports;
}

// ─── REST tests ──────────────────────────────────────────────────

function emitResourceTestFile(
  versionSet: VersionedResourceSet,
  calls: MethodCallInfo[],
  ctx: GoValueContext,
  importPath: string,
  namer: GoTestNamer
): string {
  const cb = new CodeBuilder("\t");
  let first = true;
  for (const call of calls) {
    if (!first) cb.line();
    first = false;
    emitHappyPathTest(cb, versionSet, call, ctx, namer);
    emitErrorTests(cb, versionSet, call, ctx, namer);
  }
  const body = cb.toString();
  return renderGoFile(
    GO_TESTS_PACKAGE,
    testFileImports(importPath, ctx.pkg, body),
    body
  );
}

function emitHappyPathTest(
  cb: CodeBuilder,
  versionSet: VersionedResourceSet,
  call: MethodCallInfo,
  ctx: GoValueContext,
  namer: GoTestNamer
): void {
  const testName = namer.claim(buildTestName(versionSet, call, "Success"));
  const invocation = callExpression(versionSet, call, ctx);
  const shape = goResponseShape(call.operation);

  cb.block(`func ${testName}(t *testing.T)`, () => {
    cb.line("ctx := context.Background()");
    cb.line("client := restClient(t)");
    if (shape === "void") {
      cb.block(`if err := ${invocation}; err != nil`, () => {
        cb.line('t.Fatalf("unexpected error: %v", err)');
      });
      return;
    }
    cb.line(`result, err := ${invocation}`);
    cb.block("if err != nil", () => {
      cb.line('t.Fatalf("unexpected error: %v", err)');
    });
    switch (shape) {
      case "raw":
        cb.block('if result.MimeType == ""', () => {
          cb.line('t.Fatal("expected a MIME type on the raw response")');
        });
        break;
      case "model":
        if (returnTypeHasDataArray(call.operation)) {
          cb.line("use(result, result.Data)");
        } else {
          cb.line("use(result)");
        }
        break;
      default:
        cb.line("use(result)");
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
  versionSet: VersionedResourceSet,
  call: MethodCallInfo,
  ctx: GoValueContext,
  namer: GoTestNamer
): void {
  for (const code of call.errorCodes) {
    if (code < 400) continue;
    const testName = namer.claim(buildTestName(versionSet, call, `Error${code}`));
    const invocation = callExpression(versionSet, call, ctx);
    const isVoid = goResponseShape(call.operation) === "void";

    cb.line();
    cb.block(`func ${testName}(t *testing.T)`, () => {
      cb.line("ctx := context.Background()");
      cb.line(`client := errorClient(t, ${code})`);
      cb.line(isVoid ? `err := ${invocation}` : `_, err := ${invocation}`);
      cb.line(`requireAPIError(t, err, ${code})`);
    });
  }
}

// ─── SSE stream tests ────────────────────────────────────────────

function emitStreamTestFile(
  versionSet: VersionedResourceSet,
  calls: MethodCallInfo[],
  ctx: GoValueContext,
  importPath: string,
  namer: GoTestNamer
): string {
  const cb = new CodeBuilder("\t");
  let first = true;
  for (const call of calls) {
    if (!first) cb.line();
    first = false;
    emitStreamTests(cb, versionSet, call, ctx, namer);
  }
  const body = cb.toString();
  return renderGoFile(
    GO_TESTS_PACKAGE,
    testFileImports(importPath, ctx.pkg, body),
    body
  );
}

function emitStreamTests(
  cb: CodeBuilder,
  versionSet: VersionedResourceSet,
  call: MethodCallInfo,
  ctx: GoValueContext,
  namer: GoTestNamer
): void {
  const routeKey = `${call.httpMethod} ${call.httpPath}`;
  const events = call.operation.streaming?.events ?? [];
  const invocation = callExpression(versionSet, call, ctx);
  const autoEmit = events
    .map((e) => `map[string]any{"type": "autoEmit", "event": ${goString(e.event)}}`)
    .join(", ");
  const expected = events.map((e) => goString(e.event)).join(", ");

  // Happy path: the SDK yields the declared events, in order.
  cb.block(
    `func ${namer.claim(buildTestName(versionSet, call, "YieldsSSEEvents"))}(t *testing.T)`,
    () => {
      cb.line("requireChannelTests(t)");
      cb.line("ctx := context.Background()");
      cb.line("withHarness(t, func(h *harnessClient) {");
      cb.indent();
      cb.line("h.registerStreamScenario(t, map[string]any{");
      cb.indent();
      cb.line(`"route": ${goString(routeKey)},`);
      cb.line(`"actions": []any{${autoEmit}},`);
      cb.dedent();
      cb.line("})");
      cb.line("client := h.sdkClient()");
      cb.line(`stream, err := ${invocation}`);
      cb.block("if err != nil", () => {
        cb.line('t.Fatalf("stream failed to open: %v", err)');
      });
      cb.line("defer stream.Close()");
      cb.line("var events []string");
      cb.block("for stream.Next()", () => {
        cb.line("events = append(events, stream.Event().Event)");
      });
      cb.block("if err := stream.Err(); err != nil", () => {
        cb.line('t.Fatalf("stream failed: %v", err)');
      });
      cb.line(`requireStrings(t, events, []string{${expected}})`);
      cb.dedent();
      cb.line("})");
    }
  );

  // Error path: a non-2xx status surfaces as an APIError.
  cb.line();
  cb.block(
    `func ${namer.claim(buildTestName(versionSet, call, "RejectsNon2xx"))}(t *testing.T)`,
    () => {
      cb.line("requireChannelTests(t)");
      cb.line("ctx := context.Background()");
      cb.line("withHarness(t, func(h *harnessClient) {");
      cb.indent();
      cb.line("h.registerStreamScenario(t, map[string]any{");
      cb.indent();
      cb.line(`"route": ${goString(routeKey)},`);
      cb.line(
        '"actions": []any{map[string]any{"type": "status", "code": 402, "body": map[string]any{"error": map[string]any{"code": "plan_not_entitled"}}}},'
      );
      cb.dedent();
      cb.line("})");
      cb.line("client := h.sdkClient()");
      cb.line(`stream, err := ${invocation}`);
      // A stream that opened before the status landed still surfaces the
      // error through Err() — drain it so both orderings assert the same way.
      cb.block("if err == nil", () => {
        cb.line("for stream.Next() {");
        cb.line("}");
        cb.line("err = stream.Err()");
        cb.line("stream.Close()");
      });
      cb.line("requireAPIError(t, err, 402)");
      cb.dedent();
      cb.line("})");
    }
  );
}

// Re-exports used by unit tests.
export type { ResourceDef };
