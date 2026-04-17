import { posix } from "node:path";
import type { SdkSpec } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import {
  buildMethodCalls,
  groupByTopLevelResource,
  type MethodCallInfo,
} from "./method-chain-builder.js";
import {
  channelTestFileStem,
  emitChannelContractTestFile,
} from "./channel-emitter.js";

type GeneratedFiles = Record<string, string>;

/**
 * Generate TypeScript (vitest) contract test files from the SdkSpec AST.
 *
 * Produces:
 * - __tests__/contract/{version}/{resource}.contract.test.ts — per-resource REST tests (Prism-backed)
 * - __tests__/contract/channels/{channel}.contract.test.ts   — per-channel harness tests
 * - __tests__/contract/global-setup.ts              — Prism lifecycle
 * - __tests__/contract/vitest.contract.config.ts    — vitest config
 */
export function emitTypeScriptContractTests(
  spec: SdkSpec,
  options: { outDir: string }
): GeneratedFiles {
  const files: GeneratedFiles = {};
  const testDir = `${options.outDir}/__tests__/contract`;

  // Generate REST contract tests for every version
  let restCallCount = 0;
  for (const versionSet of spec.versions) {
    const calls = buildMethodCalls(spec, versionSet, "typescript");
    restCallCount += calls.length;
    const groups = groupByTopLevelResource(calls);

    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/${versionSet.version}/${resourceName}.contract.test.ts`;
      files[filePath] = emitResourceTestFile(resourceName, resourceCalls);
    }
  }

  // Generate per-channel harness tests (shared across versions — channel
  // classes live at src/channels/, not under a version directory).
  //
  // The emitter doesn't know the consumer's SDK layout, so derive the import
  // path from the two paths we already control — the test file and the
  // channel source under outDir — instead of hardcoding a relative depth.
  for (const channel of spec.channels) {
    const stem = channelTestFileStem(channel);
    const filePath = `${testDir}/channels/${stem}.contract.test.ts`;
    const channelSrcPath = `${options.outDir}/src/channels/${stem}.js`;
    const channelImportPath = posix.relative(
      posix.dirname(filePath),
      channelSrcPath
    );
    files[filePath] = emitChannelContractTestFile(channel, channelImportPath);
  }

  // Generate global setup — spawns Prism for REST traffic and (if the spec
  // has channels) the harness-service subprocess for channel tests.
  files[`${testDir}/global-setup.ts`] = emitGlobalSetup({
    includePrism: restCallCount > 0,
    includeHarness: spec.channels.length > 0,
  });

  // Generate vitest config
  files[`${testDir}/vitest.contract.config.ts`] = emitVitestConfig();

  return files;
}

function emitResourceTestFile(
  resourceName: string,
  calls: MethodCallInfo[]
): string {
  const cb = new CodeBuilder();

  cb.line(generatedHeader());
  cb.line();
  cb.line('import { describe, it, expect } from "vitest";');
  cb.line('import { PlatformClient } from "../../../src/index.js";');
  cb.line('import { ApiError } from "../../../src/runtime/http-client.js";');
  cb.line();
  cb.line('const PRISM_URL = process.env.PRISM_URL ?? "http://127.0.0.1:4040";');
  cb.line();
  cb.line("const client = new PlatformClient({");
  cb.line("  baseUrl: PRISM_URL,");
  cb.line('  defaultHeaders: { "x-archastro-api-key": "pk_test-key" },');
  cb.line('  accessToken: "test-token",');
  cb.line("});");
  cb.line();
  cb.line("function errorClient(code: number): PlatformClient {");
  cb.line("  return new PlatformClient({");
  cb.line("    baseUrl: PRISM_URL,");
  cb.line('    defaultHeaders: { "x-archastro-api-key": "pk_test-key", "Prefer": `code=${code}` },');
  cb.line('    accessToken: "test-token",');
  cb.line("  });");
  cb.line("}");
  cb.line();

  // Group calls by their group label for nested describes
  const byGroup = new Map<string, MethodCallInfo[]>();
  for (const call of calls) {
    const existing = byGroup.get(call.groupLabel) ?? [];
    existing.push(call);
    byGroup.set(call.groupLabel, existing);
  }

  cb.line(`describe("contract: ${resourceName}", () => {`);
  cb.indent();
  for (const [groupLabel, groupCalls] of byGroup) {
    const label = groupLabel === resourceName ? resourceName : groupLabel;

    cb.line(`describe("${label}", () => {`);
    cb.indent();
    for (const call of groupCalls) {
      emitHappyPathTest(cb, call);
      emitErrorTests(cb, call);
    }
    cb.dedent();
    cb.line("});");
    cb.line();
  }
  cb.dedent();
  cb.line("});");

  return cb.toString();
}

function emitHappyPathTest(cb: CodeBuilder, call: MethodCallInfo): void {
  const argValues = call.args.map((a) => a.value).join(", ");
  const methodCall = `${call.accessorChain}.${call.methodName}(${argValues})`;
  const label = `${call.httpMethod} ${call.httpPath} returns successfully`;
  const hasDataArray = returnTypeHasDataArray(call.operation.returnType);
  const returnsNoContent = call.operation.returnType.kind === "void";

  cb.line(`it("${label}", async () => {`);
  cb.indent();
  if (returnsNoContent) {
    cb.line(`const result = await ${methodCall};`);
    cb.line("expect(result).toBeUndefined();");
  } else if (call.operation.rawResponse) {
    cb.line(`const result = await ${methodCall};`);
    cb.line('expect(result.content).toBeDefined();');
    cb.line('expect(result.mimeType).toBeTruthy();');
  } else {
    cb.line(`const result = await ${methodCall};`);
    cb.line("expect(result).toBeDefined();");
    if (hasDataArray) {
      cb.line(`expect(result).toHaveProperty("data");`);
      cb.line("expect(Array.isArray((result as any).data)).toBe(true);");
    }
  }
  cb.dedent();
  cb.line("});");
  cb.line();
}

/** Check if return type is an object with a `data` field that is an array. */
function returnTypeHasDataArray(returnType: import("../../ast/types.js").TypeRef): boolean {
  if (returnType.kind !== "object") return false;
  const dataField = returnType.fields.find((f) => f.name === "data");
  if (!dataField) return false;
  return dataField.type.kind === "array";
}

function emitErrorTests(cb: CodeBuilder, call: MethodCallInfo): void {
  for (const code of call.errorCodes) {
    if (code < 400) continue;

    const argValues = call.args.map((a) => a.value).join(", ");
    const chainWithoutClient = call.accessorChain.replace("client.", "");
    const label = `${call.httpMethod} ${call.httpPath} returns ${code}`;

    cb.line(`it("${label}", async () => {`);
    cb.indent();
    cb.line(`const ec = errorClient(${code});`);
    cb.line("try {");
    cb.indent();
    cb.line(`await ec.${chainWithoutClient}.${call.methodName}(${argValues});`);
    cb.line('expect.fail("Expected ApiError to be thrown");');
    cb.dedent();
    cb.line("} catch (e) {");
    cb.indent();
    cb.line("expect(e).toBeInstanceOf(ApiError);");
    cb.line(`expect((e as ApiError).status).toBe(${code});`);
    cb.dedent();
    cb.line("}");
    cb.dedent();
    cb.line("});");
    cb.line();
  }
}

function emitGlobalSetup(opts: {
  includePrism: boolean;
  includeHarness: boolean;
}): string {
  const { includePrism, includeHarness } = opts;

  return `${generatedHeader()}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
${includeHarness ? 'import { createRequire } from "node:module";\n' : ""}
const __dirname = dirname(fileURLToPath(import.meta.url));
${includeHarness ? 'const require = createRequire(import.meta.url);\n' : ""}
${includePrism ? `let prismProcess: ChildProcessWithoutNullStreams | undefined;` : ""}
${includeHarness ? `let harnessProcess: ChildProcessWithoutNullStreams | undefined;` : ""}

${includeHarness ? '// Channel contract tests are opt-in. Set ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS=1\n// to spawn the harness-service subprocess and run them; otherwise the channel\n// test files are filtered out by the vitest config and the subprocess is skipped.\nfunction channelTestsEnabled(): boolean {\n  const v = process.env.ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS;\n  return v === "1" || v === "true" || v === "yes";\n}\n' : ""}
export async function setup() {
  const specPath = process.env.OPENAPI_SPEC_PATH
    ?? resolve(__dirname, "../../specs/platform-openapi.json");
${includePrism ? prismSetup() : ""}
${includeHarness ? harnessSetup() : ""}
}

export async function teardown() {
${includePrism ? '  prismProcess?.kill("SIGTERM");' : ""}
${includeHarness ? '  harnessProcess?.kill("SIGTERM");' : ""}
}
${includePrism ? prismWaitFn() : ""}
${includeHarness ? harnessReadUrlsFn() : ""}
`;
}

function prismSetup(): string {
  return `
  const prismPort = process.env.PRISM_PORT ?? "4040";
  prismProcess = spawn("npx", [
    "@stoplight/prism-cli", "mock", specPath,
    "--port", prismPort,
    "--host", "127.0.0.1",
    "--dynamic",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  await waitForPrism(parseInt(prismPort), 30_000);`;
}

function prismWaitFn(): string {
  return `
async function waitForPrism(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (prismProcess!.exitCode !== null) {
      throw new Error(\`Prism exited with code \${prismProcess!.exitCode} before becoming ready\`);
    }
    try {
      const res = await fetch(\`http://127.0.0.1:\${port}/\`);
      if (res) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(\`Prism did not start within \${timeoutMs}ms\`);
}`;
}

function harnessSetup(): string {
  return `
  if (!channelTestsEnabled()) return;

  // Spawn the channel-harness service — the same subprocess Python (or any
  // other language) tests spawn. Tests talk to it over HTTP + WebSocket
  // rather than importing ContractServer in-process: no shortcuts.
  const harnessBin = process.env.ARCHASTRO_HARNESS_BIN
    ?? require.resolve("@archastro/channel-harness/bin");
  harnessProcess = spawn("node", [harnessBin, specPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const urls = await readHarnessUrls(harnessProcess, 15_000);
  process.env.ARCHASTRO_HARNESS_WS_URL = urls.wsUrl;
  process.env.ARCHASTRO_HARNESS_CONTROL_URL = urls.controlUrl;`;
}

function harnessReadUrlsFn(): string {
  return `
async function readHarnessUrls(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ wsUrl: string; controlUrl: string }> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      proc.stdout.off("data", onData);
      try {
        const parsed = JSON.parse(line) as { wsUrl: string; controlUrl: string };
        if (!parsed.wsUrl || !parsed.controlUrl) {
          throw new Error(
            \`harness service did not report URLs: \${JSON.stringify(parsed)}\`
          );
        }
        resolvePromise(parsed);
      } catch (err) {
        reject(err);
      }
    };
    const onExit = (code: number | null): void => {
      reject(
        new Error(\`harness service exited before reporting URLs (code=\${code})\`)
      );
    };
    proc.stdout.on("data", onData);
    proc.once("exit", onExit);
    setTimeout(() => {
      proc.stdout.off("data", onData);
      proc.off("exit", onExit);
      reject(new Error(\`timed out after \${timeoutMs}ms waiting for harness URLs\`));
    }, timeoutMs).unref();
  });
}`;
}

function emitVitestConfig(): string {
  return `${generatedHeader()}

import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(__dirname, "../..");

// Channel contract tests depend on the harness-service subprocess and are
// opt-in: set ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS=1 to include them. CI
// leaves the env var unset so only the REST contract tests run by default.
function channelTestsEnabled(): boolean {
  const v = process.env.ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS;
  return v === "1" || v === "true" || v === "yes";
}

export default defineConfig({
  test: {
    root: sdkRoot,
    include: ["__tests__/contract/**/*.contract.test.ts"],
    exclude: channelTestsEnabled()
      ? []
      : ["__tests__/contract/channels/**/*"],
    globalSetup: ["__tests__/contract/global-setup.ts"],
    testTimeout: 30000,
    // Channel tests share a single harness-service subprocess; scenarios
    // are registered per-topic on that shared service, so running files
    // in parallel lets one test's scenario collide with another's. Serial
    // file execution keeps isolation straightforward without paying the
    // cost of a subprocess per file.
    fileParallelism: false,
  },
});
`;
}
