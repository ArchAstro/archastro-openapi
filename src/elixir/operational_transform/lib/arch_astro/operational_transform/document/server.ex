defmodule ArchAstro.OperationalTransform.Document.Server do
  @moduledoc """
  The authoritative process for one document — a `GenServer`, because the job
  is plain serialized state mutation: every client operation must be applied
  in a single total order, and the process mailbox provides exactly that.
  (The *client* protocol, by contrast, is a real state machine — see
  `ArchAstro.OperationalTransform.Actor`, a `gen_statem`.)

  Responsibilities:

    * hold the `ArchAstro.OperationalTransform.Document`,
    * transform + apply operations submitted against stale revisions,
    * track connected actors (id, metadata, cursor) and monitor their
      processes,
    * broadcast applied operations / cursor moves / presence changes to every
      subscribed process as messages shaped
      `{:ot_doc, doc_id, event}` where `event` is one of

          {:operation, %{actor_id: id, revision: rev, op: TextOperation.t()}}
          {:cursor, %{actor_id: id, cursor: cursor | nil}}
          {:actor_joined, %{actor_id: id, meta: map}}
          {:actor_left, %{actor_id: id}}

  Cursors are maps like `%{position: 3, selection_end: 7}` (code points) and
  are transformed against every applied operation so they stay attached to
  the text.
  """

  use GenServer

  alias ArchAstro.OperationalTransform.{Document, TextOperation}

  @type cursor :: %{position: non_neg_integer(), selection_end: non_neg_integer()} | nil

  ## Client API ###############################################################

  def start_link(opts) do
    id = Keyword.fetch!(opts, :id)
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, via(id)))
  end

  @doc "Registry-based name for a document server."
  def via(id), do: {:via, Registry, {ArchAstro.OperationalTransform.Registry, {:document, id}}}

  @doc "Pid of the server for `id`, if one is running."
  def whereis(id) do
    case Registry.lookup(ArchAstro.OperationalTransform.Registry, {:document, id}) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  @doc """
  Joins the document as `actor_id`. The calling process (or `opts[:subscriber]`)
  is monitored and will receive all subsequent `{:ot_doc, id, event}` messages.

  Returns a snapshot: `%{content:, revision:, actors: %{actor_id => %{meta:, cursor:}}}`.
  """
  def join(server, actor_id, meta \\ %{}, opts \\ []) do
    GenServer.call(server, {:join, actor_id, meta, Keyword.get(opts, :subscriber, self())})
  end

  @doc "Leaves explicitly (also happens automatically if the subscriber dies)."
  def leave(server, actor_id) do
    GenServer.call(server, {:leave, actor_id})
  end

  @doc """
  Submits `op` (a `TextOperation` or wire list) produced against `revision`.
  Returns `{:ok, new_revision}`; the transformed operation is broadcast to all
  other subscribers. The submitting actor gets no echo — the `{:ok, rev}`
  reply *is* its acknowledgement.
  """
  def submit(server, actor_id, revision, op, cursor \\ nil) do
    with {:ok, op} <- normalize_op(op) do
      GenServer.call(server, {:submit, actor_id, revision, op, cursor})
    end
  end

  @doc """
  Like `submit/5` but fire-and-forget: the acknowledgement is delivered
  asynchronously to the actor's subscriber process as
  `{:ot_ack, doc_id, {:ok, revision} | {:error, reason}}`. This models a real
  network round trip — broadcasts for other actors' operations can arrive
  before the ack, which is exactly the situation the client state machine's
  `awaiting_with_buffer` state exists for.
  """
  def submit_async(server, actor_id, revision, op, cursor \\ nil) do
    with {:ok, op} <- normalize_op(op) do
      GenServer.cast(server, {:submit_async, actor_id, revision, op, cursor})
    end
  end

  @doc "Publishes a cursor/selection update for `actor_id`."
  def update_cursor(server, actor_id, cursor) do
    GenServer.cast(server, {:cursor, actor_id, cursor})
  end

  @doc "Current `%{content:, revision:, actors:}` snapshot."
  def snapshot(server), do: GenServer.call(server, :snapshot)

  defp normalize_op(%TextOperation{} = op), do: {:ok, op}
  defp normalize_op(list) when is_list(list), do: TextOperation.from_list(list)

  ## Server ###################################################################

  defmodule State do
    @moduledoc false
    defstruct doc: nil,
              # actor_id => %{pid:, ref:, meta:, cursor:}
              actors: %{}
  end

  @impl true
  def init(opts) do
    doc = Document.new(Keyword.fetch!(opts, :id), Keyword.get(opts, :content, ""))
    {:ok, %State{doc: doc}}
  end

  @impl true
  def handle_call({:join, actor_id, meta, subscriber}, _from, state) do
    state = drop_actor(state, actor_id, notify: false)
    ref = Process.monitor(subscriber)
    entry = %{pid: subscriber, ref: ref, meta: meta, cursor: nil}

    broadcast(state, {:actor_joined, %{actor_id: actor_id, meta: meta}})
    # Snapshot before adding the joiner: `actors` lists everyone *else*.
    snapshot = snapshot_map(state)
    state = put_in(state.actors[actor_id], entry)

    {:reply, {:ok, snapshot}, state}
  end

  def handle_call({:leave, actor_id}, _from, state) do
    {:reply, :ok, drop_actor(state, actor_id)}
  end

  def handle_call({:submit, actor_id, revision, op, cursor}, _from, state) do
    {result, state} = do_submit(state, actor_id, revision, op, cursor)
    {:reply, result, state}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, snapshot_map(state), state}
  end

  @impl true
  def handle_cast({:submit_async, actor_id, revision, op, cursor}, state) do
    {result, state} = do_submit(state, actor_id, revision, op, cursor)

    case state.actors do
      %{^actor_id => %{pid: pid}} -> send(pid, {:ot_ack, state.doc.id, result})
      _ -> :ok
    end

    {:noreply, state}
  end

  def handle_cast({:cursor, actor_id, cursor}, state) do
    state = put_cursor(state, actor_id, cursor)
    broadcast(state, {:cursor, %{actor_id: actor_id, cursor: cursor}}, except: actor_id)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Enum.find(state.actors, fn {_id, %{ref: r}} -> r == ref end) do
      {actor_id, _} -> {:noreply, drop_actor(state, actor_id)}
      nil -> {:noreply, state}
    end
  end

  ## Helpers ##################################################################

  defp do_submit(state, actor_id, revision, op, cursor) do
    case Document.receive_operation(state.doc, revision, op) do
      {:ok, transformed, doc} ->
        state = %{state | doc: doc}
        state = transform_cursors(state, transformed)
        state = put_cursor(state, actor_id, cursor)

        broadcast(
          state,
          {:operation,
           %{actor_id: actor_id, revision: doc.revision, op: transformed, cursor: cursor}},
          except: actor_id
        )

        {{:ok, doc.revision}, state}

      {:error, reason} ->
        {{:error, reason}, state}
    end
  end

  defp snapshot_map(state) do
    %{
      content: state.doc.content,
      revision: state.doc.revision,
      actors:
        Map.new(state.actors, fn {id, %{meta: meta, cursor: cursor}} ->
          {id, %{meta: meta, cursor: cursor}}
        end)
    }
  end

  defp drop_actor(state, actor_id, opts \\ []) do
    case Map.pop(state.actors, actor_id) do
      {nil, _} ->
        state

      {%{ref: ref}, actors} ->
        Process.demonitor(ref, [:flush])
        state = %{state | actors: actors}

        if Keyword.get(opts, :notify, true) do
          broadcast(state, {:actor_left, %{actor_id: actor_id}})
        end

        state
    end
  end

  defp put_cursor(state, actor_id, cursor) do
    case state.actors do
      %{^actor_id => entry} -> put_in(state.actors[actor_id], %{entry | cursor: cursor})
      _ -> state
    end
  end

  # Keep every stored cursor attached to its text as operations land.
  defp transform_cursors(state, op) do
    actors =
      Map.new(state.actors, fn
        {id, %{cursor: nil} = entry} ->
          {id, entry}

        {id, %{cursor: cursor} = entry} ->
          {id, %{entry | cursor: transform_cursor(cursor, op)}}
      end)

    %{state | actors: actors}
  end

  defp transform_cursor(%{position: pos} = cursor, op) do
    sel_end = Map.get(cursor, :selection_end, pos)

    %{
      position: TextOperation.transform_index(pos, op),
      selection_end: TextOperation.transform_index(sel_end, op)
    }
  end

  defp broadcast(state, event, opts \\ []) do
    except = Keyword.get(opts, :except)
    doc_id = state.doc.id

    for {actor_id, %{pid: pid}} <- state.actors, actor_id != except do
      send(pid, {:ot_doc, doc_id, event})
    end

    :ok
  end
end
