# ArchAstro.OperationalTransform

Operational transformation (OT) for collaborative markdown editing, in
Elixir/OTP. Pairs with the TypeScript client library in
[`src/ts/operational_transform`](../../ts/operational_transform) — both sides
implement the same algebra, the same wire format, and the same
insert-tie-break rules, which is what makes cross-language convergence work.

## Architecture

| Module | Role |
| --- | --- |
| `ArchAstro.OperationalTransform.TextOperation` | The pure OT algebra: retain/insert/delete operations with `apply`, `invert`, `compose`, `transform` (TP1) and cursor transformation. ot.js-compatible wire format. |
| `ArchAstro.OperationalTransform.Document` | Pure in-memory document: markdown content, revision counter, operation history, and the server-side transform pipeline (`receive_operation/3`). |
| `ArchAstro.OperationalTransform.Document.Server` | **GenServer** owning one document: serializes concurrent submissions, transforms stale ones, broadcasts operations/cursors/presence to subscribers, monitors them. |
| `ArchAstro.OperationalTransform.Client` | Pure client-side sync state machine (`synchronized` / `awaiting_confirm` / `awaiting_with_buffer`), embeddable anywhere. |
| `ArchAstro.OperationalTransform.Actor` | **gen_statem** modelling one editing client wired to a document server — the process form of `Client`, used to simulate fleets of concurrent editors. |

Documents are supervised by a `DynamicSupervisor` and addressed via a
`Registry`:

```elixir
{:ok, _pid} = ArchAstro.OperationalTransform.ensure_document("readme", content: "# Hi")

alias ArchAstro.OperationalTransform.Document.Server
server = Server.via("readme")

{:ok, snapshot} = Server.join(server, "actor-1", %{name: "Ada"})
{:ok, revision} = Server.submit(server, "actor-1", snapshot.revision, [2, "!!", 2])
```

### GenServer or gen_statem?

Both, deliberately:

* The **document authority** is a `GenServer` — its job is serialized state
  mutation. Every submission must land in one total order and the process
  mailbox provides exactly that. There are no meaningful "modes".
* The **editing client** is a `gen_statem` (`Actor`) — the sync protocol
  genuinely is a three-state machine, and behaviour differs per state (a
  local edit is sent immediately when `:synchronized`, buffered otherwise).
  The transitions delegate to the pure `Client` so no OT logic is duplicated.

### Units and wire format

All positions/lengths are **Unicode code points** (not bytes, not UTF-16
units, not graphemes) in both languages. Operations serialize ot.js-style:

```
[6, "world", -5]   # retain 6, insert "world", delete 5
```

Cursors are `%{position: p, selection_end: e}` in code points.

### Ordering guarantee (important for transports)

A client's ack must arrive **after** the broadcasts of all operations that
precede its own in the log. `Document.Server.submit_async/5` provides this
structurally: acks and broadcasts are both emitted by the document server
process, so per-subscriber FIFO delivery preserves log order. Transports that
reply to a submission synchronously from their own process (e.g. a Phoenix
channel replying from `handle_in`) can reorder an ack ahead of a queued
broadcast — see the example app's `DocChannel` for the correct pattern.

## Example: Phoenix server + browser demo

[`examples/ot_example`](examples/ot_example) is a minimal Phoenix app exposing
the library over a channel (`doc:<id>` topic on `/socket`) and serving the
TypeScript demo UI.

```sh
# 1. build the demo assets
cd ../../ts/operational_transform && npm install && npm run build:demo

# 2. run the server
cd ../../elixir/operational_transform/examples/ot_example
mix deps.get
mix run --no-halt          # http://localhost:4000  (PORT=… to override)
```

Open `http://localhost:4000` in two windows and type in both.

## Tests

```sh
mix test
```

* `TextOperationTest` / `TextOperationFuzzTest` — unit fixtures plus 1,500
  seeded randomized checks of the OT laws (TP1 convergence, compose, invert,
  codec round-trip, cursor bounds).
* `DocumentTest` / `DocumentServerTest` — server-side transform pipeline,
  broadcasts, cursor transformation, presence, monitor cleanup.
* `ClientTest` — the pure state machine against simulated server flows.
* `ActorConvergenceTest` — fleets of `gen_statem` actors (up to 5 actors x 30
  random interleaved edits each) hammering one document server; asserts every
  replica converges to the server content.

The example app adds channel-level tests (concurrent editors over the real
wire protocol), and `src/ts/operational_transform` adds the browser-level
end-to-end test (two real browsers via agent-browser).
