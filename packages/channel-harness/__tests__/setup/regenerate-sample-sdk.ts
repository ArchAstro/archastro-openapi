/**
 * Vitest globalSetup — regenerates `__tests__/generated-sdk/` from the
 * fixture spec and boots a channel-harness service subprocess that the
 * generated contract tests connect to.
 *
 * Why a subprocess: the channel-harness emitter's output is supposed to
 * exercise the real wire protocol end-to-end — over WebSocket for SDK
 * traffic and HTTP for scenario control — so the same generated tests work
 * from any language. Running the service in-process would be a shortcut
 * that masks problems with serialization, lifecycle, and connection
 * handling. We build `dist/` on demand so the CLI always reflects the
 * current source.
 *
 * The generated tree + __generated__ tests are `.gitignore`d — the output
 * of this function is the only source of truth at test time.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  parseOpenApiSpec,
  emitChannelFile,
  channelTestFileStem,
  emitChannelContractTestFile,
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

let serviceProc: ChildProcessWithoutNullStreams | null = null;

export async function setup(): Promise<void> {
  ensureSdkGeneratorBuilt();
  regenerateSampleSdk();
  await startHarnessSubprocess();
}

export async function teardown(): Promise<void> {
  await stopHarnessSubprocess();
  // Leave the regenerated tree in place — useful for editor navigation after
  // a test run, and the next `vitest run` wipes & re-emits from scratch.
}

// ─── sample SDK + generated tests ───────────────────────────────

function regenerateSampleSdk(): void {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf-8"));
  const ast = parseOpenApiSpec(spec);

  if (existsSync(OUT_ROOT)) rmSync(OUT_ROOT, { recursive: true });
  if (existsSync(GENERATED_TESTS_DIR))
    rmSync(GENERATED_TESTS_DIR, { recursive: true });
  mkdirSync(CHANNELS_DIR, { recursive: true });
  mkdirSync(PHX_DIR, { recursive: true });
  mkdirSync(GENERATED_TESTS_DIR, { recursive: true });

  for (const channel of ast.channels) {
    const fileName = snakeCase(channel.name);
    writeFileSync(
      join(CHANNELS_DIR, `${fileName}.ts`),
      emitChannelFile(channel),
      "utf-8"
    );

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
}

// ─── harness subprocess ────────────────────────────────────────

async function startHarnessSubprocess(): Promise<void> {
  ensureDistBuilt();

  serviceProc = spawn("node", [DIST_BIN, SPEC_PATH], {
    cwd: pkgRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  serviceProc.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[harness-service] ${chunk.toString("utf-8")}`);
  });

  const { wsUrl, controlUrl } = await readFirstJsonLine(serviceProc);
  process.env.ARCHASTRO_HARNESS_WS_URL = wsUrl;
  process.env.ARCHASTRO_HARNESS_CONTROL_URL = controlUrl;
}

async function stopHarnessSubprocess(): Promise<void> {
  if (!serviceProc) return;
  const proc = serviceProc;
  serviceProc = null;

  await new Promise<void>((resolve) => {
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

function readFirstJsonLine(
  proc: ChildProcessWithoutNullStreams
): Promise<{ wsUrl: string; controlUrl: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      proc.stdout.off("data", onData);
      try {
        const parsed = JSON.parse(line) as {
          wsUrl: string;
          controlUrl: string;
        };
        if (!parsed.wsUrl || !parsed.controlUrl) {
          throw new Error(
            `harness service did not report URLs: ${JSON.stringify(parsed)}`
          );
        }
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };
    const onExit = (code: number | null): void => {
      reject(
        new Error(
          `harness service exited before emitting URLs (code=${code})`
        )
      );
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

function ensureSdkGeneratorBuilt(): void {
  const sdkDist = resolve(sdkGeneratorRoot, "dist/index.js");
  if (existsSync(sdkDist) && newestMtime(resolve(sdkGeneratorRoot, "dist")) >= newestMtime(resolve(sdkGeneratorRoot, "src"))) {
    return;
  }
  const result = spawnSync("npx", ["tsc"], {
    cwd: sdkGeneratorRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`@archastro/sdk-generator tsc build failed with status ${result.status ?? "null"}`);
  }
  if (!existsSync(sdkDist)) {
    throw new Error(`tsc build did not produce ${sdkDist}`);
  }
}

function ensureDistBuilt(): void {
  if (existsSync(DIST_BIN) && distIsFresh()) return;

  // `tsc` is the project's build script. Invoke it directly so we don't
  // depend on whoever is running the tests having installed extra tools.
  const result = spawnSync("npx", ["tsc"], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`tsc build failed with status ${result.status ?? "null"}`);
  }
  if (!existsSync(DIST_BIN)) {
    throw new Error(`tsc build did not produce ${DIST_BIN}`);
  }
}

/**
 * Cheap staleness check: compare newest mtime under dist/ against newest
 * mtime under src/. If src has been touched since the last build, rebuild.
 * Skips deep content hashing — a few seconds of tsc is acceptable when it's
 * actually needed.
 */
function distIsFresh(): boolean {
  try {
    const distDir = resolve(pkgRoot, "dist");
    const distTime = newestMtime(distDir);
    const srcTime = newestMtime(SRC_DIR);
    return distTime >= srcTime;
  } catch {
    return false;
  }
}

function newestMtime(dir: string): number {
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
