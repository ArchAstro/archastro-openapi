# OtExample — collaborative editing demo server

Minimal Phoenix app wiring `ArchAstro.OperationalTransform` to browsers:

* `ArchAstro.OtExampleWeb.DocSocket` — websocket at `/socket`; assigns a
  stable `actor_id` per connection.
* `ArchAstro.OtExampleWeb.DocChannel` — topic `doc:<id>`; join replies with
  the document snapshot, `"operation"` pushes are submitted to the document
  server **asynchronously** so acks can never overtake concurrent operation
  broadcasts (see the module doc — this ordering matters for OT correctness),
  `"cursor"` pushes fan out selections.
* `ArchAstro.OtExampleWeb.Router` — serves the built demo UI from
  `priv/static` (build it with `npm run build:demo` in
  `src/ts/operational_transform`) and a read-only JSON snapshot at
  `GET /api/docs/:id` for tests.

## Run

```sh
mix deps.get
mix run --no-halt      # http://localhost:4000, PORT=… to override
```

## Test

```sh
mix test               # includes two editors converging over the real channel protocol
```
