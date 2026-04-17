# archastro-openapi

OpenAPI tooling for the ArchAstro platform. Two tools live here:

| Package | What it does | Install / run |
| --- | --- | --- |
| [`@archastro/sdk-generator`](./packages/sdk-generator) | Reads an OpenAPI spec and emits typed TypeScript / Python SDKs plus cross-language contract tests. | `npx @archastro/sdk-generator` / `sdk-generator` |
| [`@archastro/channel-harness`](./packages/channel-harness) | Runtime contract-testing harness for Phoenix `x-channels` declared in the spec. Exposes a WebSocket + HTTP control API so TS, Python, (or any other) test suites can drive the same server. | `npx @archastro/channel-harness` / `channel-harness` |

---

## Installing the tools

Both packages are plain npm modules. You can run them ad-hoc with `npx` or
install them globally.

### `@archastro/sdk-generator`

```bash
# One-shot via npx
npx @archastro/sdk-generator --spec ./openapi.json --lang typescript --out ./sdk

# Or install globally and use the `sdk-generator` bin
npm install -g @archastro/sdk-generator
sdk-generator --spec ./openapi.json --lang typescript --out ./sdk
```

Supported `--lang` values:

- `typescript` — emit a typed TS SDK (resources, channel classes, auth helpers)
- `python` — emit a typed Python SDK (Pydantic models, resources, channels)
- `contract-tests-ts` — emit TS contract tests that drive the channel harness
- `contract-tests-py` — emit Python contract tests (pytest + prism mock server)

Other flags:

- `--config <config.json>` — package metadata (name, version, baseUrl, apiBase, defaultVersion)
- `--ast-only` — skip codegen; write the intermediate SDK AST as JSON

### `@archastro/channel-harness`

The channel harness is a CLI + library. The CLI boots a contract-testing
service (WebSocket + HTTP control API) from an OpenAPI spec and prints a
single JSON line with the resolved URLs. Test runners spawn it as a
subprocess and talk to it over the wire — so the same server services TS,
Python, or any language.

```bash
# One-shot via npx
npx @archastro/channel-harness ./openapi.json

# Or install globally
npm install -g @archastro/channel-harness
channel-harness ./openapi.json --ws-port 0 --control-port 0
```

First line of stdout on startup:

```json
{"wsUrl":"ws://127.0.0.1:51234/socket/websocket","controlUrl":"http://127.0.0.1:51235"}
```

Both ports default to `0` (ephemeral). The service handles `SIGTERM` /
`SIGINT` for clean shutdown, which is what test harnesses rely on.

You can also import the harness programmatically:

```ts
import { startHarnessService, HarnessServiceClient } from "@archastro/channel-harness";

const service = await startHarnessService({ spec: "./openapi.json" });
const client = new HarnessServiceClient({ wsUrl: service.wsUrl, controlUrl: service.controlUrl });
// ... register scenarios, open sockets, etc.
await service.stop();
```

---

## OpenAPI extensions (`x-*`)

ArchAstro specs are standard OpenAPI 3.0 documents enriched with a handful of
proprietary `x-*` extensions. The generator and the harness both consume
these — if you're authoring a spec from scratch or hand-editing a generated
one, here's what each extension does.

### Root-level extensions

| Key | Shape | Purpose |
| --- | --- | --- |
| `x-channels` | `XChannel[]` | Declare Phoenix-style channels alongside the HTTP `paths`. Each entry describes `joins`, `messages` (client-to-server RPC), and `pushes` (server-to-client events). The harness and the `typescript` / `python` channel emitters read from here. |
| `x-auth-schemes` | `Record<string, AuthScheme>` | Named auth schemes (`apiKey`, `http`). Referenced by `x-auth` on operations / channels to opt into one or more schemes. Each scheme can carry an `x-token-use` hint (`"access"` / `"refresh"`) that steers the auth emitter. |
| `x-token-flows` | `Record<string, TokenFlow>` | OAuth-style token flows — login, refresh, device code. The auth emitter turns each flow into an `AuthClient` method (`login()`, `refresh()`, etc.) whose shape comes from this definition. |
| `x-channel-auth` | `string[]` | Default auth-scheme names applied to every channel. Per-channel `x-auth` overrides this. |

### Operation-level extensions

Placed on a path+verb object (e.g. `paths."/v1/teams".get`).

| Key | Shape | Purpose |
| --- | --- | --- |
| `x-sdk-pagination` | `{ type: "offset" \| "cursor" }` | Marks an endpoint as paginated. Backends emit a matching pagination helper (auto-iterating or cursor-based) instead of a bare list return. |
| `x-sdk-streaming` | `{ type: "sse" }` | Marks an endpoint as Server-Sent Events. Backends emit an async iterator that yields parsed event payloads. |
| `x-sdk-name` | `string` | Explicit SDK method name override. Useful when `operationId` is awkward or collides — e.g. an HTTP handler called `listTeamsV1` becomes `.teams.list()` in the SDK. |
| `x-auth` | `string[]` | Auth schemes required for the operation (names from `x-auth-schemes`). The generator wires these into request headers / token resolution. |

### Schema / field-level extensions

Placed on a schema in `components.schemas` or inline on a property.

| Key | Shape | Purpose |
| --- | --- | --- |
| `x-sdk` | `string` | Field role marker (e.g. `"access_token"`, `"refresh_token"`). The auth emitter discovers token-bearing fields from these markers — there are no hardcoded field names. |

### Channel-level extensions

Placed on an entry inside `x-channels`.

| Key | Shape | Purpose |
| --- | --- | --- |
| `x-auth` | `string[]` | Auth schemes required to `join` this channel. Overrides `x-channel-auth` on a per-channel basis. |

### Minimal example

```jsonc
{
  "openapi": "3.0.3",
  "info": { "title": "Example", "version": "1.0.0" },
  "x-auth-schemes": {
    "secret_key": {
      "type": "apiKey",
      "in": "header",
      "name": "x-archastro-api-key",
      "x-token-use": "access"
    }
  },
  "paths": {
    "/v1/teams": {
      "get": {
        "operationId": "listTeams",
        "x-sdk-name": "list",
        "x-sdk-pagination": { "type": "cursor" },
        "x-auth": ["secret_key"],
        "responses": { "200": { "description": "ok" } }
      }
    }
  },
  "x-channels": [
    {
      "name": "Chat",
      "x-auth": ["secret_key"],
      "joins": [{ "pattern": "api:chat:team:{team_id}:thread:{thread_id}" }],
      "messages": [{ "event": "send", "params": { "type": "object", "properties": { "body": { "type": "string" } }, "required": ["body"] } }],
      "pushes":   [{ "event": "message.created", "payload": { "$ref": "#/components/schemas/ChatMessage" } }]
    }
  ]
}
```

> These extensions are proprietary to ArchAstro. Standard OpenAPI tooling
> will ignore them (per the spec), so the document stays compatible with
> Swagger UI, redocly, Prism, etc.

---

## Using them together

For a repo that ships a typed SDK and needs cross-language contract tests,
the usual wiring is:

1. Generate OpenAPI from your API source of truth.
2. Run `sdk-generator` once per target language to emit the SDK tree
   and the contract-test tree.
3. Add `@archastro/channel-harness` as a `devDependency` — the generated
   TS tests `require.resolve("@archastro/channel-harness/bin")` and the
   generated Python tests look for `node_modules/@archastro/channel-harness/dist/bin.js`.
4. `npm test` / `pytest` spawns the harness automatically.

---

## Repository layout

This repo is an npm workspace:

```
archastro-openapi/
├── package.json              # workspace root
├── tsconfig.base.json
├── packages/
│   ├── sdk-generator/        # @archastro/sdk-generator
│   └── channel-harness/      # @archastro/channel-harness
└── README.md
```

`channel-harness` depends on `sdk-generator` as a dev-only workspace
dependency, because its integration tests regenerate a sample SDK from a
fixture spec and then exercise the generated channel classes against a
live harness service.

---

## Developing

```bash
# Install all workspace deps and link packages
npm install

# Build both packages (emits ./packages/*/dist)
npm run build

# Run tests across the workspace (vitest)
npm test

# Only one package
npm test --workspace @archastro/sdk-generator
npm test --workspace @archastro/channel-harness
```

### Releasing

Each package is published independently under the `@archastro` npm scope.

```bash
# From the package root:
cd packages/sdk-generator
npm version patch            # or minor / major
npm publish --access public
```

The `prepare` script runs `tsc` automatically on `npm install`, so `dist/`
is always up to date for both direct installs and `npm pack`.

### Node version

Both packages declare `"engines": { "node": ">=20" }` — ESM-only, no
CommonJS shim.
