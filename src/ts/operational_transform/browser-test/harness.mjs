/** Shared plumbing for the agent-browser end-to-end tests. */

import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

export const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const exampleDir = resolve(
  pkgRoot,
  "../../elixir/operational_transform/examples/ot_example",
);

export function makeArtifactsDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function log(message) {
  console.log(`[e2e] ${message}`);
}

export function ab(session, args, options = {}) {
  return execFileP("agent-browser", ["--session", session, ...args], {
    timeout: 60_000,
    ...options,
  });
}

export async function abEval(session, js) {
  const { stdout } = await ab(session, ["eval", js]);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function waitFor(description, fn, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Boots the example Phoenix server on `port`. Returns a handle with `stop()`.
 * Fails fast when the port is already in use.
 */
export async function startServer(port) {
  const base = `http://localhost:${port}`;
  const alreadyUp = await fetch(`${base}/`).then(() => true).catch(() => false);
  if (alreadyUp) {
    throw new Error(`port ${port} is already serving; choose a free port`);
  }

  log(`starting example Phoenix server on :${port} …`);
  const child = spawn("mix", ["run", "--no-halt"], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port), MIX_ENV: "dev" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => (serverLog += chunk));
  child.stderr.on("data", (chunk) => (serverLog += chunk));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] server exited with ${code}:\n${serverLog.slice(-2000)}`);
    }
  });

  await waitFor(
    "server to accept HTTP",
    () => fetch(`${base}/`).then((r) => r.ok).catch(() => false),
    120_000,
    500,
  );
  log("server is up");

  return {
    base,
    stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

export async function fetchServerDoc(base, docId) {
  const response = await fetch(`${base}/api/docs/${docId}`);
  if (!response.ok) throw new Error(`GET /api/docs/${docId} -> ${response.status}`);
  return response.json();
}

export async function openEditor(session, base, docId, name, color, actorId, waitSelector = ".cm-content") {
  const url = `${base}/d/${docId}?name=${name}&color=${encodeURIComponent(color)}&actor_id=${actorId}`;
  await ab(session, ["open", url]);
  await ab(session, ["wait", waitSelector]);
  await waitFor(`${name}'s session to synchronize`, async () => {
    const status = await abEval(session, "window.__otDemo.status()");
    return status === "synchronized/synchronized";
  });
  log(`${name} joined ${docId}`);
}

/** Center of an element, for mouse-primitive interactions. */
export async function elementCenter(session, selector) {
  const { stdout } = await ab(session, ["get", "box", selector]);
  const vals = {};
  for (const line of stdout.split("\n")) {
    const [key, value] = line.split(":");
    if (key && value) vals[key.trim()] = parseFloat(value);
  }
  return { x: Math.round(vals.x + vals.width / 2), y: Math.round(vals.y + vals.height / 2) };
}

export async function rightClick(session, selector) {
  const { x, y } = await elementCenter(session, selector);
  await ab(session, ["mouse", "move", String(x), String(y)]);
  await ab(session, ["mouse", "down", "right"]);
  await ab(session, ["mouse", "up", "right"]);
}

export async function drag(session, selector, dx, dy) {
  const { x, y } = await elementCenter(session, selector);
  await ab(session, ["mouse", "move", String(x), String(y)]);
  await ab(session, ["mouse", "down"]);
  await ab(session, ["mouse", "move", String(x + dx), String(y + dy)]);
  await ab(session, ["mouse", "up"]);
}

export function assertEqual(label, left, right) {
  if (left !== right) {
    throw new Error(
      `${label}: MISMATCH\n--- left  (${String(left).length} chars): ${JSON.stringify(String(left).slice(0, 200))}\n--- right (${String(right).length} chars): ${JSON.stringify(String(right).slice(0, 200))}`,
    );
  }
  log(`${label}: OK`);
}

export function assert(label, condition) {
  if (!condition) throw new Error(`${label}: FAILED`);
  log(`${label}: OK`);
}
