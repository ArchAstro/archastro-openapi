defmodule ArchAstro.OperationalTransform.Actor do
  @moduledoc """
  One editing client as a process: a `gen_statem` wired to an
  `ArchAstro.OperationalTransform.Document.Server`.

  Why `gen_statem` here when the document server is a `GenServer`? Because a
  client's synchronization protocol genuinely *is* a finite state machine —
  `:synchronized` / `:awaiting_confirm` / `:awaiting_with_buffer` — and
  behaviour differs per state (a local edit is sent immediately in
  `:synchronized` but buffered otherwise). The states are mirrored from the
  pure `ArchAstro.OperationalTransform.Client`, which holds all the actual OT
  logic; this process adds the replica, the transport (server messages) and a
  place for cursor state.

  The actor keeps a full local replica of the document (`content/1`), applies
  local edits optimistically, submits them asynchronously
  (`Document.Server.submit_async/5`) and reconciles acks and remote
  operations exactly like a browser client would — which is what makes it
  useful for simulating fleets of concurrent editors in tests.

  Local edits can be expressed as position-based intents:

      Actor.edit(actor, {:insert, 0, "# Title\\n"})
      Actor.edit(actor, {:delete, 3, 5})
      Actor.edit(actor, [{:delete, 0, 1}, {:insert, 0, "H"}])  # applied in order
  """

  @behaviour :gen_statem

  alias ArchAstro.OperationalTransform.{Client, Document, TextOperation}

  defmodule Data do
    @moduledoc false
    @enforce_keys [:doc_id, :server, :actor_id]
    defstruct [:doc_id, :server, :actor_id, :client, content: "", meta: %{}]
  end

  ## API ######################################################################

  @doc """
  Starts an actor and joins it to a document server.

  Options: `:server` (pid or via tuple, required), `:doc_id` (required),
  `:actor_id` (required), `:meta` (presence metadata, default `%{}`).
  """
  def start_link(opts) do
    :gen_statem.start_link(__MODULE__, opts, [])
  end

  @doc """
  Applies an edit to the local replica and (eventually) syncs it. Accepts a
  `TextOperation`, a `{:insert, position, text}` / `{:delete, position, length}`
  intent, or a list of intents applied in order.
  """
  def edit(actor, edit), do: :gen_statem.call(actor, {:edit, edit})

  @doc "Current local replica content (may be ahead of the server)."
  def content(actor), do: :gen_statem.call(actor, :content)

  @doc "Current sync state name and confirmed server revision."
  def status(actor), do: :gen_statem.call(actor, :status)

  @doc "True when all local edits have been acknowledged by the server."
  def synchronized?(actor) do
    match?(%{state: :synchronized}, status(actor))
  end

  def stop(actor), do: :gen_statem.stop(actor)

  ## gen_statem callbacks #####################################################

  @impl true
  def callback_mode, do: :handle_event_function

  @impl true
  def init(opts) do
    server = Keyword.fetch!(opts, :server)
    doc_id = Keyword.fetch!(opts, :doc_id)
    actor_id = Keyword.fetch!(opts, :actor_id)
    meta = Keyword.get(opts, :meta, %{})

    {:ok, snapshot} = Document.Server.join(server, actor_id, meta)

    data = %Data{
      doc_id: doc_id,
      server: server,
      actor_id: actor_id,
      meta: meta,
      content: snapshot.content,
      client: Client.new(snapshot.revision)
    }

    {:ok, :synchronized, data}
  end

  @impl true
  def handle_event({:call, from}, {:edit, edit}, _state, data) do
    case build_operation(edit, data.content) do
      {:ok, op} ->
        content = TextOperation.apply!(op, data.content)
        {client, sends} = Client.apply_client(data.client, op)
        data = %{data | content: content, client: client}
        perform_sends(sends, data)
        {:next_state, Client.state_name(client), data, {:reply, from, :ok}}

      {:error, reason} ->
        {:keep_state_and_data, {:reply, from, {:error, reason}}}
    end
  end

  def handle_event({:call, from}, :content, _state, data) do
    {:keep_state_and_data, {:reply, from, data.content}}
  end

  def handle_event({:call, from}, :status, state, data) do
    {:keep_state_and_data,
     {:reply, from, %{state: state, revision: data.client.revision, actor_id: data.actor_id}}}
  end

  # Remote operation broadcast by the document server.
  def handle_event(
        :info,
        {:ot_doc, doc_id, {:operation, %{op: op}}},
        _state,
        %{doc_id: doc_id} = data
      ) do
    {client, op_for_replica} = Client.apply_server(data.client, op)
    content = TextOperation.apply!(op_for_replica, data.content)
    data = %{data | content: content, client: client}
    {:next_state, Client.state_name(client), data}
  end

  # Presence / cursor broadcasts — not tracked by the simulation actor.
  def handle_event(:info, {:ot_doc, doc_id, _event}, _state, %{doc_id: doc_id}) do
    :keep_state_and_data
  end

  # Acknowledgement of our outstanding operation.
  def handle_event(:info, {:ot_ack, doc_id, {:ok, _revision}}, _state, %{doc_id: doc_id} = data) do
    {client, sends} = Client.server_ack(data.client)
    data = %{data | client: client}
    perform_sends(sends, data)
    {:next_state, Client.state_name(client), data}
  end

  def handle_event(:info, {:ot_ack, doc_id, {:error, reason}}, state, %{doc_id: doc_id} = data) do
    {:stop, {:submit_rejected, reason, state, data.actor_id}}
  end

  ## Helpers ##################################################################

  defp perform_sends(sends, data) do
    Enum.each(sends, fn {:send, revision, op} ->
      :ok = Document.Server.submit_async(data.server, data.actor_id, revision, op)
    end)
  end

  defp build_operation(%TextOperation{} = op, _content), do: {:ok, op}

  defp build_operation(edits, content) when is_list(edits) do
    Enum.reduce_while(edits, {:ok, nil}, fn edit, {:ok, acc} ->
      base = if acc, do: TextOperation.apply!(acc, content), else: content

      case build_operation(edit, base) do
        {:ok, op} ->
          combined = if acc, do: TextOperation.compose!(acc, op), else: op
          {:cont, {:ok, combined}}

        {:error, _} = err ->
          {:halt, err}
      end
    end)
  end

  defp build_operation({:insert, position, text}, content) do
    len = TextOperation.cp_length(content)

    if position < 0 or position > len do
      {:error, {:position_out_of_range, position, len}}
    else
      {:ok,
       TextOperation.new()
       |> TextOperation.retain(position)
       |> TextOperation.insert(text)
       |> TextOperation.retain(len - position)}
    end
  end

  defp build_operation({:delete, position, count}, content) do
    len = TextOperation.cp_length(content)

    if position < 0 or count < 0 or position + count > len do
      {:error, {:span_out_of_range, position, count, len}}
    else
      {:ok,
       TextOperation.new()
       |> TextOperation.retain(position)
       |> TextOperation.delete(count)
       |> TextOperation.retain(len - position - count)}
    end
  end
end
