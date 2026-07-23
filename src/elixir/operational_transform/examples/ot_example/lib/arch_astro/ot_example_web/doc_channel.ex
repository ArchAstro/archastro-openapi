defmodule ArchAstro.OtExampleWeb.DocChannel do
  @moduledoc """
  Phoenix channel bridging browser clients to an
  `ArchAstro.OperationalTransform.Document.Server`.

  Topic: `doc:<doc_id>`. Wire protocol (shared with the TypeScript library in
  `src/ts/operational_transform`):

  Join reply:

      %{actor_id, content, revision,
        actors: [%{actor_id, meta, cursor}]}

  Client -> server events:

    * `"operation"` `%{"revision" => r, "op" => wire_op, "cursor" => c}` —
      replies `{:ok, %{revision: r'}}` (the acknowledgement the client state
      machine waits for) or `{:error, %{reason: ...}}`.
    * `"cursor"` `%{"cursor" => c}` — fire-and-forget selection update.

  Server -> client events: `"operation"`, `"cursor"`, `"actor_joined"`,
  `"actor_left"` — mirroring the document server's broadcasts. Operations are
  in ot.js wire format (`[retain, "insert", -delete]`), cursors are
  `%{position, selection_end}` in Unicode code points.
  """

  use Phoenix.Channel

  alias ArchAstro.OperationalTransform, as: OT
  alias ArchAstro.OperationalTransform.Document.Server
  alias ArchAstro.OperationalTransform.TextOperation

  @initial_content """
  # Welcome to the ArchAstro collaborative editor

  This document is being edited through **operational transformation**:
  an Elixir `GenServer` holds the authoritative markdown, and every client
  runs the same transform algebra in TypeScript. Try opening this page in a
  second window — edits merge in real time, *even when they collide*.

  ![How edits flow](/assets/collab-flow.svg)

  ## What the editor understands

  | Feature   | In the editor            | In the preview   |
  | --------- | ------------------------ | ---------------- |
  | Headings  | styled inline            | rendered         |
  | Code      | highlighted blocks       | formatted        |
  | Tables    | monospace alignment      | real `<table>`   |
  | Images    | rendered inline          | rendered         |

  ```javascript
  // Every keystroke becomes an operation like [12, "hi", -3]
  const [a1, b1] = TextOperation.transform(a, b);
  ```
  """

  @impl true
  def join("doc:" <> doc_id, params, socket) do
    if valid_doc_id?(doc_id) do
      actor_id = socket.assigns.actor_id
      {:ok, _pid} = OT.ensure_document(doc_id, content: @initial_content)
      server = Server.via(doc_id)

      meta = %{
        "name" => sanitize_name(params["name"]),
        "color" => sanitize_color(params["color"])
      }

      {:ok, snapshot} = Server.join(server, actor_id, meta)
      socket = assign(socket, pending_acks: :queue.new())

      reply = %{
        actor_id: actor_id,
        content: snapshot.content,
        revision: snapshot.revision,
        actors:
          Enum.map(snapshot.actors, fn {id, %{meta: meta, cursor: cursor}} ->
            %{actor_id: id, meta: meta, cursor: encode_cursor(cursor)}
          end)
      }

      {:ok, reply, assign(socket, doc_id: doc_id, server: server)}
    else
      {:error, %{reason: "invalid document id"}}
    end
  end

  # Submission is asynchronous on purpose: the acknowledgement is routed
  # through the document server (`submit_async` -> `{:ot_ack, ...}`), which
  # also emits all operation broadcasts. Because both come from that single
  # process, they reach this channel — and therefore the websocket — in log
  # order. Replying synchronously here would let the ack overtake a
  # concurrent operation already queued in this channel's mailbox, and the
  # client would apply that operation against the wrong base revision.
  @impl true
  def handle_in("operation", %{"revision" => revision, "op" => op} = params, socket)
      when is_integer(revision) and is_list(op) do
    %{server: server, actor_id: actor_id} = socket.assigns
    cursor = decode_cursor(params["cursor"])

    case Server.submit_async(server, actor_id, revision, op, cursor) do
      :ok ->
        pending = :queue.in(socket_ref(socket), socket.assigns.pending_acks)
        {:noreply, assign(socket, :pending_acks, pending)}

      {:error, reason} ->
        {:reply, {:error, %{reason: format_error(reason)}}, socket}
    end
  end

  def handle_in("operation", _params, socket) do
    {:reply, {:error, %{reason: "malformed operation payload"}}, socket}
  end

  def handle_in("cursor", params, socket) do
    %{server: server, actor_id: actor_id} = socket.assigns
    Server.update_cursor(server, actor_id, decode_cursor(params["cursor"]))
    {:noreply, socket}
  end

  @impl true
  def handle_info({:ot_doc, doc_id, event}, %{assigns: %{doc_id: doc_id}} = socket) do
    case event do
      {:operation, %{actor_id: actor_id, revision: revision, op: op, cursor: cursor}} ->
        push(socket, "operation", %{
          actor_id: actor_id,
          revision: revision,
          op: TextOperation.to_list(op),
          cursor: encode_cursor(cursor)
        })

      {:cursor, %{actor_id: actor_id, cursor: cursor}} ->
        push(socket, "cursor", %{actor_id: actor_id, cursor: encode_cursor(cursor)})

      {:actor_joined, %{actor_id: actor_id, meta: meta}} ->
        push(socket, "actor_joined", %{actor_id: actor_id, meta: meta})

      {:actor_left, %{actor_id: actor_id}} ->
        push(socket, "actor_left", %{actor_id: actor_id})
    end

    {:noreply, socket}
  end

  def handle_info({:ot_ack, doc_id, result}, %{assigns: %{doc_id: doc_id}} = socket) do
    {{:value, ref}, pending} = :queue.out(socket.assigns.pending_acks)

    case result do
      {:ok, revision} -> reply(ref, {:ok, %{revision: revision}})
      {:error, reason} -> reply(ref, {:error, %{reason: format_error(reason)}})
    end

    {:noreply, assign(socket, :pending_acks, pending)}
  end

  ## Helpers ##################################################################

  defp valid_doc_id?(id), do: id =~ ~r/^[\w-]{1,64}$/u

  defp sanitize_name(name) when is_binary(name) and byte_size(name) in 1..40, do: name
  defp sanitize_name(_), do: "Anonymous"

  defp sanitize_color(color) do
    if is_binary(color) and color =~ ~r/^#[0-9a-fA-F]{6}$/, do: color, else: "#4f6df5"
  end

  defp decode_cursor(%{"position" => pos} = cursor)
       when is_integer(pos) and pos >= 0 do
    sel_end =
      case cursor["selection_end"] do
        e when is_integer(e) and e >= 0 -> e
        _ -> pos
      end

    %{position: pos, selection_end: sel_end}
  end

  defp decode_cursor(_), do: nil

  defp encode_cursor(nil), do: nil

  defp encode_cursor(%{position: pos, selection_end: sel_end}) do
    %{position: pos, selection_end: sel_end}
  end

  defp format_error(reason), do: inspect(reason)
end
