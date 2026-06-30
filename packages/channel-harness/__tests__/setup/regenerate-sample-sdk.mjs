/**
 * Regenerates `__tests__/generated-sdk/` (channels + SSE resources + runtime)
 * and the generated contract tests under `__tests__/__generated__/` from the
 * fixture spec, then (as vitest globalSetup) boots a channel-harness service
 * subprocess the generated tests connect to.
 *
 * Why a subprocess: the emitter's output should exercise the real wire
 * protocol end-to-end — WebSocket for SDK traffic, HTTP for scenario control —
 * so the same generated tests work from any language. We build `dist/` on
 * demand so the CLI always reflects current source.
 *
 * This file is plain ESM (not TS) so it doubles as the package `pretest` step:
 * `node regenerate-sample-sdk.mjs` regenerates the files WITHOUT booting the
 * subprocess. That matters because vitest globs its test files at startup —
 * *before* globalSetup runs — so on a cold checkout the generated contract
 * tests wouldn't be collected unless they already exist on disk. Running the
 * regeneration as a pretest puts them there first; globalSetup then refreshes
 * them and boots the service.
 *
 * The generated tree + __generated__ tests are `.gitignore`d — this script is
 * the only source of truth at test time.
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  parseOpenApiSpec,
  emitChannelFile,
  emitResourceFile,
  channelTestFileStem,
  emitChannelContractTestFile,
  emitStreamContractTestFile,
  specHasStreamingOps,
  snakeCase,
} from "@archastro/sdk-generator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const repoRoot = resolve(pkgRoot, "../..");
const sdkGeneratorRoot = resolve(repoRoot, "packages/sdk-generator");

const SPEC_PATH = resolve(pkgRoot, "__tests__/fixtures/channel-harness-spec.json");
const OUT_ROOT = resolve(pkgRoot, "__tests__/generated-sdk");
const CHANNELS_DIR = join(OUT_ROOT, "src/channels");
const PHX_DIR = join(OUT_ROOT, "src/phx_channel");
const RESOURCES_DIR = join(OUT_ROOT, "src/resources");
const RUNTIME_DIR = join(OUT_ROOT, "src/runtime");
const SAMPLE_HTTP_CLIENT = resolve(pkgRoot, "__tests__/setup/sample-http-client.ts");
const GENERATED_TESTS_DIR = resolve(pkgRoot, "__tests__/__generated__");
const DIST_BIN = resolve(pkgRoot, "dist/bin.js");
const SRC_DIR = resolve(pkgRoot, "src");

const CHANNEL_STUB = `// Auto-generated test stub. Re-exports the harness adapter so the
// generated channel files can satisfy their phx_channel type imports
// without pulling in a real Phoenix runtime.
export type { Channel } from "@archastro/channel-harness";
`;

const SOCKET_STUB = `// Auto-generated test stub. Re-exports the harness adapter so the
// generated channel files can satisfy their phx_channel type imports
// without pulling in a real Phoenix runtime.
export type { Socket } from "@archastro/channel-harness";
`;

let serviceProc = null;

// ─── vitest globalSetup interface ───────────────────────────────

export async function setup() {
  regenerate();
  await startHarnessSubprocess();
}

export async function teardown() {
  await stopHarnessSubprocess();
  // Leave the regenerated tree in place — useful for editor navigation after
  // a test run, and the next run wipes & re-emits from scratch.
}

// ─── sample SDK + generated tests ───────────────────────────────

/**
 * Build the generator (if stale) and (re)emit the sample SDK + contract tests.
 * Safe to run standalone (pretest) or from globalSetup.
 */
export function regenerate() {
  ensureSdkGeneratorBuilt();
  regenerateSampleSdk();
}

function regenerateSampleSdk() {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf-8"));
  const ast = parseOpenApiSpec(spec);

  if (existsSync(OUT_ROOT)) rmSync(OUT_ROOT, { recursive: true });
  if (existsSync(GENERATED_TESTS_DIR)) rmSync(GENERATED_TESTS_DIR, { recursive: true });
  mkdirSync(CHANNELS_DIR, { recursive: true });
  mkdirSync(PHX_DIR, { recursive: true });
  mkdirSync(GENERATED_TESTS_DIR, { recursive: true });

  for (const channel of ast.channels) {
    const fileName = snakeCase(channel.name);
    writeFileSync(join(CHANNELS_DIR, `${fileName}.ts`), emitChannelFile(channel), "utf-8");

    const testStem = channelTestFileStem(channel);
    const channelImportPath = `../generated-sdk/src/channels/${fileName}.js`;
    writeFileSync(
      join(GENERATED_TESTS_DIR, `${testStem}.contract.test.ts`),
      emitChannelContractTestFile(channel, channelImportPath),
      "utf-8"
    );
  }

  writeFileSync(join(PHX_DIR, "channel.ts"), CHANNEL_STUB, "utf-8");
  writeFileSync(join(PHX_DIR, "socket.ts"), SOCKET_STUB, "utf-8");

  // SSE streaming routes: emit the resource classes, copy in the runtime
  // HttpClient (the streamSSE primitive), and generate the stream contract
  // test that drives the generated stream() against the harness over HTTP.
  if (specHasStreamingOps(ast)) {
    mkdirSync(RESOURCES_DIR, { recursive: true });
    mkdirSync(RUNTIME_DIR, { recursive: true });
    copyFileSync(SAMPLE_HTTP_CLIENT, join(RUNTIME_DIR, "http-client.ts"));

    for (const top of ast.resources) {
      if (!subtreeHasStreaming(top)) continue;
      writeFileSync(
        join(RESOURCES_DIR, `${snakeCase(top.name)}.ts`),
        emitResourceFile(top, "/api"),
        "utf-8"
      );
    }

    writeFileSync(
      join(GENERATED_TESTS_DIR, "stream.contract.test.ts"),
      emitStreamContractTestFile(
        ast,
        "../generated-sdk/src/resources",
        "../generated-sdk/src/runtime/http-client.js"
      ),
      "utf-8"
    );
  }
}

function subtreeHasStreaming(resource) {
  if (resource.operations.some((op) => op.streaming)) return true;
  return resource.children.some(subtreeHasStreaming);
}

// ─── harness subprocess ────────────────────────────────────────

async function startHarnessSubprocess() {
  ensureDistBuilt();

  serviceProc = spawn("node", [DIST_BIN, SPEC_PATH], {
    cwd: pkgRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  serviceProc.stderr.on("data", (chunk) => {
    process.stderr.write(`[harness-service] ${chunk.toString("utf-8")}`);
  });

  const { wsUrl, controlUrl } = await readFirstJsonLine(serviceProc);
  process.env.ARCHASTRO_HARNESS_WS_URL = wsUrl;
  process.env.ARCHASTRO_HARNESS_CONTROL_URL = controlUrl;
}

async function stopHarnessSubprocess() {
  if (!serviceProc) return;
  const proc = serviceProc;
  serviceProc = null;

  await new Promise((resolve) => {
    const onExit = () => resolve();
    proc.once("exit", onExit);
    proc.kill("SIGTERM");
    // Hard-stop after 2s if the child ignores SIGTERM.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 2000).unref();
  });
}

function readFirstJsonLine(proc) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      proc.stdout.off("data", onData);
      try {
        const parsed = JSON.parse(line);
        if (!parsed.wsUrl || !parsed.controlUrl) {
          throw new Error(`harness service did not report URLs: ${JSON.stringify(parsed)}`);
        }
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };
    const onExit = (code) => {
      reject(new Error(`harness service exited before emitting URLs (code=${code})`));
    };
    proc.stdout.on("data", onData);
    proc.once("exit", onExit);
    setTimeout(() => {
      proc.stdout.off("data", onData);
      proc.off("exit", onExit);
      reject(new Error("timed out waiting for harness service to report URLs"));
    }, 15_000).unref();
  });
}

// ─── dist/ bootstrap ───────────────────────────────────────────

function ensureSdkGeneratorBuilt() {
  const sdkDist = resolve(sdkGeneratorRoot, "dist/index.js");
  if (
    existsSync(sdkDist) &&
    newestMtime(resolve(sdkGeneratorRoot, "dist")) >= newestMtime(resolve(sdkGeneratorRoot, "src"))
  ) {
    return;
  }
  const result = spawnSync("npx", ["tsc"], { cwd: sdkGeneratorRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `@archastro/sdk-generator tsc build failed with status ${result.status ?? "null"}`
    );
  }
  if (!existsSync(sdkDist)) {
    throw new Error(`tsc build did not produce ${sdkDist}`);
  }
}

function ensureDistBuilt() {
  if (existsSync(DIST_BIN) && distIsFresh()) return;

  // `tsc` is the project's build script. Invoke it directly so we don't depend
  // on whoever is running the tests having installed extra tools.
  const result = spawnSync("npx", ["tsc"], { cwd: pkgRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tsc build failed with status ${result.status ?? "null"}`);
  }
  if (!existsSync(DIST_BIN)) {
    throw new Error(`tsc build did not produce ${DIST_BIN}`);
  }
}

/**
 * Cheap staleness check: compare newest mtime under dist/ against newest mtime
 * under src/. If src has been touched since the last build, rebuild.
 */
function distIsFresh() {
  try {
    return newestMtime(resolve(pkgRoot, "dist")) >= newestMtime(SRC_DIR);
  } catch {
    return false;
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  }
  return newest;
}

// ─── pretest CLI entry ──────────────────────────────────────────
// When invoked directly (`node regenerate-sample-sdk.mjs`), regenerate the
// files only — no subprocess. globalSetup imports this module instead, so the
// guard keeps the regeneration from running twice at import time.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  regenerate();
}
