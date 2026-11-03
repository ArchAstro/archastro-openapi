import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPrismProxyScript } from "../../src/backends/contract-tests/prism-proxy.js";

// Stands in for Prism: listens on the `--port` it is given (after an optional
// delay) and echoes each request back, or exits with `--exit <code>`.
const FAKE_PRISM = `
import http from "node:http";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
if (arg("--exit")) process.exit(Number(arg("--exit")));
console.log("pid:" + process.pid);
setTimeout(() => {
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, header: req.headers["x-test"] }));
    });
  }).listen(Number(arg("--port")), "127.0.0.1");
}, Number(arg("--delay") ?? 0));
`;

let dir: string;
let proxyPath: string;
let fakePrismPath: string;
let running: ChildProcess[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "prism-proxy-test-"));
  proxyPath = join(dir, "prism-proxy.mjs");
  fakePrismPath = join(dir, "fake-prism.mjs");
  writeFileSync(proxyPath, emitPrismProxyScript());
  writeFileSync(fakePrismPath, FAKE_PRISM);
});

afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running = [];
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function startProxy(port: number, ...fakeArgs: string[]) {
  const child = spawn(process.execPath, [proxyPath, String(port), process.execPath, fakePrismPath, ...fakeArgs]);
  running.push(child);
  let stdout = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, stdout: () => stdout };
}

async function fetchWhenListening(url: string, init?: RequestInit): Promise<Response> {
  for (;;) {
    try {
      return await fetch(url, init);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe("Prism proxy script", () => {
  it("rewrites bracketed array query names and forwards everything else unchanged", async () => {
    const port = await freePort();
    startProxy(port);

    const res = await fetchWhenListening(
      `http://127.0.0.1:${port}/api/v1/things/a%5B%5D?tags%5B%5D=a&tags[]=b&empty%5B%5D&q=x%5B%5D&plain=1`,
      { method: "DELETE", body: "payload", headers: { "x-test": "kept" } }
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      method: "DELETE",
      url: "/api/v1/things/a%5B%5D?tags=a&tags=b&empty&q=x%5B%5D&plain=1",
      body: "payload",
      header: "kept",
    });
  });

  it("only starts listening once Prism answers", async () => {
    const port = await freePort();
    startProxy(port, "--delay", "500");

    // The first connection that succeeds must already reach Prism, so the
    // generated setups' readiness checks can't pass before Prism is up.
    const res = await fetchWhenListening(`http://127.0.0.1:${port}/ready?a[]=1`);
    expect(res.status).toBe(201);
  });

  it("exits with Prism's exit code when Prism exits", async () => {
    const port = await freePort();
    const { exited } = startProxy(port, "--exit", "3");

    expect(await exited).toBe(3);
  });

  it("stops Prism when it is terminated", async () => {
    const port = await freePort();
    const { child, exited, stdout } = startProxy(port);
    await fetchWhenListening(`http://127.0.0.1:${port}/`);
    const prismPid = Number(/pid:(\d+)/.exec(stdout())![1]);

    child.kill("SIGTERM");
    await exited;

    expect(() => process.kill(prismPid, 0)).toThrow();
  });
});
