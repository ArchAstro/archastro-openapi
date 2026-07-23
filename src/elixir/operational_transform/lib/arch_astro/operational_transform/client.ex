defmodule ArchAstro.OperationalTransform.Client do
  @moduledoc """
  The pure client-side synchronization state machine (the classic ot.js
  design, and the exact mirror of `Client` in the TypeScript library).

  A client is always in one of three states:

    * `:synchronized` — everything the user typed has been acknowledged.
    * `:awaiting_confirm` — one operation (`outstanding`) is in flight to the
      server, nothing else is pending.
    * `:awaiting_with_buffer` — one operation is in flight *and* further
      local edits have accumulated in `buffer` (composed into a single
      operation). The buffer is sent as soon as the outstanding operation is
      acknowledged.

  Only one operation is ever in flight, which is what keeps server-side
  transformation simple. The three entry points are:

    * `apply_client/2` — the local user edited the document,
    * `apply_server/2` — a (already transformed) remote operation arrived,
    * `server_ack/1` — the server acknowledged our outstanding operation.

  Each returns the new client plus what to do: operations to send to the
  server, and/or the operation to apply to the local document replica.

  This module is pure so it can be embedded anywhere (a `gen_statem` — see
  `ArchAstro.OperationalTransform.Actor` —, a Phoenix channel, a LiveView, a
  test). All transforms call `TextOperation.transform(own, server_op)` with
  the client's own operation on the *left*, matching the server which puts
  the incoming client operation on the left when transforming against
  history — both sides therefore break insert-position ties identically.
  """

  alias ArchAstro.OperationalTransform.TextOperation

  defstruct revision: 0, state: :synchronized

  @type sync_state ::
          :synchronized
          | {:awaiting_confirm, TextOperation.t()}
          | {:awaiting_with_buffer, TextOperation.t(), TextOperation.t()}

  @type t :: %__MODULE__{revision: non_neg_integer(), state: sync_state()}

  @typedoc "Instruction to send `op` (based on `revision`) to the server."
  @type send_instruction :: {:send, non_neg_integer(), TextOperation.t()}

  @doc "A new client synchronized at `revision`."
  @spec new(non_neg_integer()) :: t()
  def new(revision \\ 0), do: %__MODULE__{revision: revision}

  @doc "The current state name (useful for instrumentation and `gen_statem` mirrors)."
  @spec state_name(t()) :: :synchronized | :awaiting_confirm | :awaiting_with_buffer
  def state_name(%__MODULE__{state: :synchronized}), do: :synchronized
  def state_name(%__MODULE__{state: {:awaiting_confirm, _}}), do: :awaiting_confirm
  def state_name(%__MODULE__{state: {:awaiting_with_buffer, _, _}}), do: :awaiting_with_buffer

  @doc """
  The local user produced `op` (already applied to their replica).
  Returns `{client, send_instructions}`.
  """
  @spec apply_client(t(), TextOperation.t()) :: {t(), [send_instruction()]}
  def apply_client(%__MODULE__{state: :synchronized} = client, op) do
    {%{client | state: {:awaiting_confirm, op}}, [{:send, client.revision, op}]}
  end

  def apply_client(%__MODULE__{state: {:awaiting_confirm, outstanding}} = client, op) do
    {%{client | state: {:awaiting_with_buffer, outstanding, op}}, []}
  end

  def apply_client(%__MODULE__{state: {:awaiting_with_buffer, outstanding, buffer}} = client, op) do
    {%{client | state: {:awaiting_with_buffer, outstanding, TextOperation.compose!(buffer, op)}},
     []}
  end

  @doc """
  A remote operation arrived from the server (already transformed server-side
  so it applies to revision `client.revision`). Returns `{client, op_to_apply}`
  where `op_to_apply` fits the client's current local replica (i.e. it has
  been transformed over the outstanding/buffered local edits).
  """
  @spec apply_server(t(), TextOperation.t()) :: {t(), TextOperation.t()}
  def apply_server(%__MODULE__{state: :synchronized} = client, op) do
    {%{client | revision: client.revision + 1}, op}
  end

  def apply_server(%__MODULE__{state: {:awaiting_confirm, outstanding}} = client, op) do
    {outstanding, op} = TextOperation.transform!(outstanding, op)

    {%{client | revision: client.revision + 1, state: {:awaiting_confirm, outstanding}}, op}
  end

  def apply_server(%__MODULE__{state: {:awaiting_with_buffer, outstanding, buffer}} = client, op) do
    {outstanding, op} = TextOperation.transform!(outstanding, op)
    {buffer, op} = TextOperation.transform!(buffer, op)

    {%{
       client
       | revision: client.revision + 1,
         state: {:awaiting_with_buffer, outstanding, buffer}
     }, op}
  end

  @doc """
  The server acknowledged our outstanding operation.
  Returns `{client, send_instructions}` — non-empty when a buffer was waiting.
  """
  @spec server_ack(t()) :: {t(), [send_instruction()]} | {:error, :not_awaiting}
  def server_ack(%__MODULE__{state: :synchronized}), do: {:error, :not_awaiting}

  def server_ack(%__MODULE__{state: {:awaiting_confirm, _}} = client) do
    {%{client | revision: client.revision + 1, state: :synchronized}, []}
  end

  def server_ack(%__MODULE__{state: {:awaiting_with_buffer, _, buffer}} = client) do
    revision = client.revision + 1

    {%{client | revision: revision, state: {:awaiting_confirm, buffer}},
     [{:send, revision, buffer}]}
  end
end
