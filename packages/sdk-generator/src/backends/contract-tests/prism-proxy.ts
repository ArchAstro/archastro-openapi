/**
 * Prism proxy emitter — shared by the TypeScript and Python contract tests.
 *
 * The SDKs send array query params as `name[]=value`, the form Platform
 * expects. Prism looks params up by their exact name, so it reports a required
 * array param as missing and never validates an optional one. The emitted
 * script starts Prism on a free port and serves a proxy on the test port that
 * rewrites `name[]=` to `name=` before forwarding, so Prism validates array
 * params against the unmodified spec.
 */

import { generatedHeader } from "../../utils/codegen.js";

export const PRISM_PROXY_FILE = "prism-proxy.mjs";

export function emitPrismProxyScript(): string {
  return `${generatedHeader()}
// Runs Prism behind a proxy that rewrites \`name[]=value\` query params to
// \`name=value\`. The SDKs send arrays in the bracket form Platform expects,
// but Prism looks params up by their exact name.
//
// Usage: node prism-proxy.mjs <port> <prism command...>
// The Prism command gets \`--port <free port>\` appended. The proxy listens on
// <port> once Prism answers, and exits when Prism exits.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const [port, command, ...args] = process.argv.slice(2);
const prismPort = await freePort();
const prism = spawn(command, [...args, "--port", String(prismPort)], {
  stdio: "inherit",
});
prism.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => prism.kill(signal));
}

await waitForPrism();

http
  .createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: prismPort,
        method: req.method,
        path: toPrismPath(req.url ?? "/"),
        headers: req.headers,
      },
      (prismRes) => {
        res.writeHead(prismRes.statusCode ?? 502, prismRes.headers);
        prismRes.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    req.pipe(upstream);
  })
  .listen(Number(port), "127.0.0.1");

function toPrismPath(url) {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;
  const query = url
    .slice(queryStart)
    .replace(/([?&][^=&]*?)(?:\\[\\]|%5B%5D)(?=[=&]|$)/gi, "$1");
  return url.slice(0, queryStart) + query;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPrism() {
  for (;;) {
    const ready = await new Promise((resolve) => {
      http
        .get({ host: "127.0.0.1", port: prismPort, path: "/" }, (res) => {
          res.resume();
          resolve(true);
        })
        .on("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
`;
}
