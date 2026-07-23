defmodule ArchAstro.OperationalTransform do
  @moduledoc """
  Operational transformation for collaborative (markdown) text editing.

  The pieces:

    * `ArchAstro.OperationalTransform.TextOperation` — the pure OT algebra:
      retain/insert/delete operations with `apply`, `invert`, `compose` and
      `transform`, plus the ot.js-compatible wire format shared with the
      TypeScript library (`src/ts/operational_transform`).
    * `ArchAstro.OperationalTransform.Document` — pure in-memory document:
      content, revision, history, and the server-side transform pipeline.
    * `ArchAstro.OperationalTransform.Document.Server` — a `GenServer` that
      owns one document, serializes concurrent submissions and broadcasts
      applied operations, cursors and presence to subscribers.
    * `ArchAstro.OperationalTransform.Client` — the pure client-side
      synchronization state machine (synchronized / awaiting_confirm /
      awaiting_with_buffer).
    * `ArchAstro.OperationalTransform.Actor` — a `gen_statem` modelling one
      editing client wired to a document server; used to simulate concurrent
      editors in tests and as a reference for transport integrations.

  Documents are supervised under a `DynamicSupervisor` and addressed by id
  through a `Registry`:

      {:ok, _pid} = ArchAstro.OperationalTransform.ensure_document("readme", content: "# Hi")
      {:ok, snap} = ArchAstro.OperationalTransform.Document.Server.join(
        ArchAstro.OperationalTransform.Document.Server.via("readme"), "actor-1")
  """

  alias ArchAstro.OperationalTransform.Document

  @doc """
  Starts (or returns the already-running) document server for `id`.

  Options: `:content` — initial markdown content for a fresh document.
  """
  @spec ensure_document(String.t(), keyword()) :: {:ok, pid()} | {:error, term()}
  def ensure_document(id, opts \\ []) when is_binary(id) do
    spec = {Document.Server, Keyword.put(opts, :id, id)}

    case DynamicSupervisor.start_child(ArchAstro.OperationalTransform.DocumentSupervisor, spec) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, _} = err -> err
    end
  end

  @doc "Stops the document server for `id`, if running."
  @spec stop_document(String.t()) :: :ok
  def stop_document(id) when is_binary(id) do
    case Document.Server.whereis(id) do
      nil ->
        :ok

      pid ->
        DynamicSupervisor.terminate_child(ArchAstro.OperationalTransform.DocumentSupervisor, pid)
        :ok
    end
  end
end
