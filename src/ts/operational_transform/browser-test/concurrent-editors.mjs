#!/usr/bin/env node
/**
 * End-to-end concurrent-editing test, driven through real browsers with
 * agent-browser (https://github.com/vercel-labs/agent-browser).
 *
 * What it does:
 *   1. builds the demo bundle and boots the example Phoenix server,
 *   2. opens the same document in two isolated browser sessions,
 *   3. fires deliberately colliding edits (same-position inserts, keyboard
 *      typing, overlapping delete-vs-insert) from both sessions in parallel,
 *   4. waits for both clients to report `synchronized`,
 *   5. asserts editor A content === editor B content === server content, and
 *      that every marker survived.
 *
 * Requirements: `agent-browser` on PATH, elixir/mix, and `npm install` done
 * in this package. Usage: `npm run test:browser` (env: OT_E2E_PORT).
 */

import { execFile, spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const exampleDir = resolve(pkgRoot, "../../elixir/operational_transform/examples/ot_example");

const PORT = Number(process.env.OT_E2E_PORT ?? 4399);
const BASE = `http://localhost:${PORT}`;
const RUN_ID = Date.now().toString(36);
const DOC_ID = `e2e-${RUN_ID}`;
const SESSION_A = `ot-e2e-alice-${RUN_ID}`;
const SESSION_B = `ot-e2e-bob-${RUN_ID}`;
const artifactsDir = mkdtempSync(join(tmpdir(), "ot-e2e-"));

let serverProcess = null;
let failed = false;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function ab(session, args, options = {}) {
  return execFileP("agent-browser", ["--session", session, ...args], {
    timeout: 60_000,
    ...options,
  });
}

async function abEval(session, js) {
  const { stdout } = await ab(session, ["eval", js]);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitFor(description, fn, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function fetchServerDoc() {
  const response = await fetch(`${BASE}/api/docs/${DOC_ID}`);
  if (!response.ok) throw new Error(`GET /api/docs/${DOC_ID} -> ${response.status}`);
  return response.json();
}

async function startServer() {
  // Refuse to reuse a foreign server: the port must be free.
  const alreadyUp = await fetch(`${BASE}/`).then(() => true).catch(() => false);
  if (alreadyUp) {
    throw new Error(`port ${PORT} is already serving; set OT_E2E_PORT to a free port`);
  }

  log(`starting example Phoenix server on :${PORT} …`);
  serverProcess = spawn("mix", ["run", "--no-halt"], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(PORT), MIX_ENV: "dev" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  serverProcess.stdout.on("data", (chunk) => (serverLog += chunk));
  serverProcess.stderr.on("data", (chunk) => (serverLog += chunk));
  serverProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && !failed) {
      console.error(`[e2e] server exited with ${code}:\n${serverLog.slice(-2000)}`);
    }
  });

  await waitFor(
    "server to accept HTTP",
    () => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false),
    120_000,
    500,
  );
  log("server is up");
}

async function openEditor(session, name, color, actorId) {
  const url = `${BASE}/d/${DOC_ID}?name=${name}&color=${encodeURIComponent(color)}&actor_id=${actorId}`;
  await ab(session, ["open", url]);
  await ab(session, ["wait", ".cm-content"]);
  await waitFor(`${name}'s session to synchronize`, async () => {
    const status = await abEval(session, "window.__otDemo.status()");
    return status === "synchronized/synchronized";
  });
  log(`${name} joined ${DOC_ID}`);
}

async function bothSynchronized() {
  const [a, b] = await Promise.all([
    abEval(SESSION_A, "JSON.stringify({s: window.__otDemo.status(), r: window.__otDemo.revision()})"),
    abEval(SESSION_B, "JSON.stringify({s: window.__otDemo.status(), r: window.__otDemo.revision()})"),
  ]);
  const pa = typeof a === "string" ? JSON.parse(a) : a;
  const pb = typeof b === "string" ? JSON.parse(b) : b;
  return (
    pa.s === "synchronized/synchronized" &&
    pb.s === "synchronized/synchronized" &&
    pa.r === pb.r
  );
}

function assertEqual(label, left, right) {
  if (left !== right) {
    failed = true;
    throw new Error(
      `${label}: MISMATCH\n--- left  (${left.length} chars): ${JSON.stringify(left.slice(0, 200))}\n--- right (${right.length} chars): ${JSON.stringify(right.slice(0, 200))}`,
    );
  }
  log(`${label}: OK`);
}

async function screenshotBoth(tag) {
  await Promise.allSettled([
    ab(SESSION_A, ["screenshot", join(artifactsDir, `alice-${tag}.png`)]),
    ab(SESSION_B, ["screenshot", join(artifactsDir, `bob-${tag}.png`)]),
  ]);
  log(`screenshots saved under ${artifactsDir}`);
}

async function main() {
  execFileSync("node", [join(pkgRoot, "scripts/build-demo.mjs")], { stdio: "inherit" });
  await startServer();

  await Promise.all([
    openEditor(SESSION_A, "Alice", "#e8453c", `alice-${RUN_ID}`),
    openEditor(SESSION_B, "Bob", "#12a765", `bob-${RUN_ID}`),
  ]);

  // --- phase 1: same-position insert collisions, fired in parallel ---------
  log("phase 1: colliding same-position inserts");
  const phase1 = [];
  for (let round = 1; round <= 4; round++) {
    phase1.push(abEval(SESSION_A, `window.__otDemo.type("[A${round}] ", 0)`));
    phase1.push(abEval(SESSION_B, `window.__otDemo.type("[B${round}] ", 0)`));
  }
  await Promise.all(phase1);

  // --- phase 2: real keyboard typing in both editors simultaneously --------
  log("phase 2: concurrent keyboard typing");
  await Promise.all([
    (async () => {
      await ab(SESSION_A, ["click", ".cm-content"]);
      await ab(SESSION_A, ["keyboard", "type", " alicekeyboard "]);
    })(),
    (async () => {
      await ab(SESSION_B, ["click", ".cm-content"]);
      await ab(SESSION_B, ["keyboard", "type", " bobkeyboard "]);
    })(),
  ]);

  // --- phase 3: concurrent delete vs insert --------------------------------
  // A deletes inside the original "# Welcome…" heading (positions 45..51,
  // past the 40 chars of phase-1 markers) while B appends at the end. The
  // two CLI evals race: sometimes truly concurrent (delete must transform
  // around the insert), sometimes serialized — the asserted marker is placed
  // where either ordering leaves it intact. Exact-overlap collisions are
  // covered deterministically in the unit/fuzz suites.
  log("phase 3: concurrent delete vs insert");
  await Promise.all([
    abEval(SESSION_A, "window.__otDemo.remove(45, 6)"),
    abEval(SESSION_B, 'window.__otDemo.type("\\n[Bfinal]\\n")'),
  ]);

  // --- convergence ----------------------------------------------------------
  log("waiting for quiescence…");
  await waitFor("both clients synchronized at the same revision", bothSynchronized, 30_000);

  const [contentA, contentB, serverDoc] = await Promise.all([
    abEval(SESSION_A, "window.__otDemo.content()"),
    abEval(SESSION_B, "window.__otDemo.content()"),
    fetchServerDoc(),
  ]);

  assertEqual("editor A == editor B", contentA, contentB);
  assertEqual("editor A == server", contentA, serverDoc.content);

  const markers = [
    ...[1, 2, 3, 4].flatMap((n) => [`[A${n}]`, `[B${n}]`]),
    "alicekeyboard",
    "bobkeyboard",
    "[Bfinal]",
  ];
  for (const marker of markers) {
    if (!contentA.includes(marker)) {
      failed = true;
      throw new Error(`marker ${marker} missing from converged content`);
    }
  }
  log(`all markers present; converged at server revision ${serverDoc.revision}`);

  await screenshotBoth("final");
  writeFileSync(join(artifactsDir, "converged.md"), contentA);
  log("PASS ✅  two real browsers + server converged under concurrent editing");
}

async function cleanup() {
  await Promise.allSettled([
    ab(SESSION_A, ["close"]),
    ab(SESSION_B, ["close"]),
  ]);
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
  }
}

main()
  .catch(async (error) => {
    failed = true;
    console.error(`[e2e] FAIL ❌ ${error.message}`);
    await screenshotBoth("failure").catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
