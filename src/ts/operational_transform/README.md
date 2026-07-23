# @archastro/operational-transform

TypeScript client library for collaborative markdown editing over
operational transformation, paired with the Elixir library in
[`src/elixir/operational_transform`](../../elixir/operational_transform).
Includes a Google-Docs-like demo editor and a browser-level concurrency test.

## Library (`src/`)

* `TextOperation` — retain/insert/delete algebra with `apply`, `invert`,
  `compose`, `TextOperation.transform` (TP1) and
  `TextOperation.transformIndex` for cursors. Wire format and semantics are
  identical to the Elixir `TextOperation` (ot.js style: `[6, "world", -5]`).
  All positions are **Unicode code points**; helpers `utf16OffsetToCp` /
  `cpToUtf16Offset` convert at UTF-16 API boundaries (DOM, CodeMirror).
* `Client` — the sync state machine (`synchronized` → `awaitingConfirm` →
  `awaitingWithBuffer`), one operation in flight at a time.
* `DocSession` — Phoenix-channel transport: joins `doc:<id>`, owns the
  `Client` and a shadow replica, emits `ready` / `operation` / `cursor` /
  `actorJoined` / `actorLeft` / `statusChange` events.

```ts
import { DocSession, TextOperation } from "@archastro/operational-transform";

const session = new DocSession({ url: "ws://localhost:4000/socket", docId: "readme" });
session.on("ready", ({ content }) => editor.load(content));
session.on("operation", ({ op }) => editor.applyRemote(op));
editor.onChange((op) => session.applyLocal(op));
session.connect();
```

## Demo (`demo/`)

A collaborative markdown editor styled after Google Docs: CodeMirror 6 with
rich inline markdown rendering (headings large, `**bold**` bold, syntax
markers faded), live rendered preview pane, shared remote cursors/selections
with name flags, presence avatars, sync-status pill and formatting toolbar.

```sh
npm install
npm run build:demo     # bundles into the Phoenix example's priv/static
# then run the example server (see the Elixir README) and open localhost:4000
npm run watch:demo     # rebuild on change
```

## Tests

```sh
npm test               # vitest: unit fixtures + fuzz convergence harness
npm run test:browser   # end-to-end via agent-browser (below)
```

* `test/text-operation.test.ts`, `test/client.test.ts` — unit suites whose
  fixtures use the same literals as the Elixir tests, pinning cross-language
  behaviour (including the insert tie-break).
* `test/convergence.fuzz.test.ts` — a simulated authoritative server plus
  2–8 clients exchanging randomly interleaved edits/acks/broadcasts (seeded
  PRNG, 170 scenarios); every replica must converge.

### Browser end-to-end (`browser-test/`)

`npm run test:browser` needs [`agent-browser`](https://github.com/vercel-labs/agent-browser)
on `PATH` plus Elixir. It builds the demo, boots the example Phoenix server,
opens the same document in **two isolated real browsers**, then fires
colliding edits from both in parallel (same-position inserts, real keyboard
typing, an insert inside a concurrently deleted range), waits for both
clients to report `synchronized`, and asserts

```
editor A content == editor B content == server content (via /api/docs/:id)
```

plus survival of every marker. Screenshots land in a temp dir printed at the
end.
