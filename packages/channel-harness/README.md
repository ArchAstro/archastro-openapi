# @archastro/channel-harness

Runtime contract-testing harness for Phoenix `x-channels` declared in an
OpenAPI spec. Boot a `ContractServer` from a spec, register per-topic
scenarios, and exercise them through either an in-process transport or a
real WebSocket server. A built-in HTTP control API lets Python (or any
other language) drive the same server that backs the TypeScript tests.

## Install

```bash
# ad-hoc
npx @archastro/channel-harness ./openapi.json

# global
npm install -g @archastro/channel-harness
channel-harness ./openapi.json --ws-port 0 --control-port 0
```

On startup the CLI prints one JSON line on stdout:

```json
{"wsUrl":"ws://127.0.0.1:51234/socket/websocket","controlUrl":"http://127.0.0.1:51235"}
```

Test harnesses parse this to discover the ephemeral ports. The service
handles `SIGTERM` / `SIGINT` for clean shutdown.

## Programmatic API

```ts
import {
  startHarnessService,
  HarnessServiceClient,
} from "@archastro/channel-harness";

const service = await startHarnessService({ spec: "./openapi.json" });

const client = new HarnessServiceClient({
  wsUrl: service.wsUrl,
  controlUrl: service.controlUrl,
});
await client.reset();

// Register a scenario via HTTP …
await fetch(`${service.controlUrl}/scenarios`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    topic: "doc:doc_42",
    onJoin: { reply: { ok: true, payload: { version: 1 } } },
  }),
});

// … open a socket and run the SDK channel class.
const socket = await client.openSocket();

// shutdown
client.closeAllSockets();
await service.stop();
```

For in-process usage (same-process TS tests), import `ContractServer` and
`createInProcessPair` directly — no WebSocket needed.

## CLI options

```
channel-harness <spec-path> [--ws-port N] [--control-port M] [--host H]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--ws-port` | `0` (ephemeral) | WebSocket listen port |
| `--control-port` | `0` (ephemeral) | HTTP control listen port |
| `--host` | `127.0.0.1` | Bind address for both listeners |

## Development

This package lives inside the
[`archastro-openapi`](https://github.com/archastro/archastro-openapi)
workspace. Its integration tests regenerate a sample SDK via
`@archastro/sdk-generator` and then drive the generated channels through
the harness end-to-end. See the root README for details.
