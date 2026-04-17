#!/usr/bin/env node
/**
 * Harness service CLI — the process TS and Python test suites spawn.
 *
 * Usage:
 *   npx @archastro/channel-harness <spec-path> [--ws-port N] [--control-port M]
 *   channel-harness <spec-path> [...]   # after `npm install -g`
 *
 * On startup, prints a single JSON line to stdout that callers parse to
 * discover the ephemeral port(s):
 *
 *   {"wsUrl":"ws://127.0.0.1:51234/socket/websocket","controlUrl":"http://127.0.0.1:51235"}
 *
 * Handles SIGTERM / SIGINT gracefully so the subprocess tears down cleanly
 * when vitest / pytest finishes.
 */

import { startHarnessService } from "./service/harness-service.js";

interface CliArgs {
  specPath: string;
  wsPort?: number;
  controlPort?: number;
  host?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let specPath: string | undefined;
  let wsPort: number | undefined;
  let controlPort: number | undefined;
  let host: string | undefined;

  const takeValue = (flag: string, i: number): string => {
    const v = args[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const takeNumber = (flag: string, i: number): number => {
    const raw = takeValue(flag, i);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} requires a numeric value, got '${raw}'`);
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--ws-port") {
      wsPort = takeNumber(a, ++i);
    } else if (a === "--control-port") {
      controlPort = takeNumber(a, ++i);
    } else if (a === "--host") {
      host = takeValue(a, ++i);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (!specPath) {
      specPath = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }

  if (!specPath) {
    printHelp();
    throw new Error("missing required <spec-path> argument");
  }

  return { specPath, wsPort, controlPort, host };
}

function printHelp(): void {
  process.stderr.write(
    `Usage: channel-harness <spec-path> [--ws-port N] [--control-port M] [--host H]\n` +
      `\n` +
      `Starts a channel-harness service that combines a Phoenix WebSocket server\n` +
      `with an HTTP control API. Prints a JSON line on stdout with the resolved\n` +
      `URLs; handles SIGTERM/SIGINT for clean shutdown.\n`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const handle = await startHarnessService({
    spec: args.specPath,
    ws: { port: args.wsPort ?? 0, host: args.host },
    control: { port: args.controlPort, host: args.host },
  });

  // Parent processes read this line to discover the ephemeral ports. Must be
  // a single JSON object followed by a newline — keep it trivial to parse
  // from pytest conftest or a node child_process consumer.
  process.stdout.write(
    JSON.stringify({ wsUrl: handle.wsUrl, controlUrl: handle.controlUrl }) +
      "\n"
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[harness-service] received ${signal}, shutting down\n`);
    try {
      await handle.stop();
    } catch (err) {
      process.stderr.write(
        `[harness-service] shutdown error: ${err instanceof Error ? err.stack : String(err)}\n`
      );
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // If the parent dies and leaves stdin closed, exit rather than linger.
  process.stdin.on("close", () => void shutdown("stdin_close"));
  process.stdin.resume();
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[harness-service] fatal: ${err instanceof Error ? err.stack : String(err)}\n`
  );
  process.exit(1);
});
