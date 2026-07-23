defmodule ArchAstro.OperationalTransform.Document do
  @moduledoc """
  Pure in-memory representation of a collaboratively edited document.

  The content is a markdown string. `revision` counts applied operations;
  `history` keeps every applied operation so late (concurrent) client
  operations can be transformed against everything they haven't seen.

  `receive_operation/3` is the whole server-side OT algorithm: take an
  operation a client produced against revision `r`, transform it over the
  operations applied since `r`, apply it, and hand back the transformed
  operation for broadcasting.
  """

  alias ArchAstro.OperationalTransform.TextOperation

  @enforce_keys [:id]
  defstruct id: nil, content: "", revision: 0, history: []

  @type t :: %__MODULE__{
          id: String.t(),
          content: String.t(),
          revision: non_neg_integer(),
          # Most recent first; op at index 0 took the doc to `revision`.
          history: [TextOperation.t()]
        }

  @spec new(String.t(), String.t()) :: t()
  def new(id, content \\ "") when is_binary(id) and is_binary(content) do
    %__MODULE__{id: id, content: content}
  end

  @doc """
  Ingests `op`, which was produced against revision `base_revision`.

  Returns `{:ok, transformed_op, doc}` where `transformed_op` is what must be
  broadcast to all other clients (it applies cleanly to the pre-call head
  content), or `{:error, reason}` if the revision is unknown or the operation
  doesn't fit the document.
  """
  @spec receive_operation(t(), non_neg_integer(), TextOperation.t()) ::
          {:ok, TextOperation.t(), t()} | {:error, term()}
  def receive_operation(%__MODULE__{} = doc, base_revision, %TextOperation{} = op)
      when is_integer(base_revision) do
    cond do
      base_revision < 0 or base_revision > doc.revision ->
        {:error, {:unknown_revision, base_revision, current: doc.revision}}

      true ->
        # Operations the client hadn't seen, oldest first.
        concurrent = concurrent_since(doc, base_revision)

        with {:ok, transformed} <- transform_through(op, concurrent),
             {:ok, content} <- TextOperation.apply(transformed, doc.content) do
          doc = %{
            doc
            | content: content,
              revision: doc.revision + 1,
              history: [transformed | doc.history]
          }

          {:ok, transformed, doc}
        end
    end
  end

  @doc "Operations applied after `revision`, oldest first."
  @spec concurrent_since(t(), non_neg_integer()) :: [TextOperation.t()]
  def concurrent_since(%__MODULE__{} = doc, revision) do
    doc.history
    |> Enum.take(doc.revision - revision)
    |> Enum.reverse()
  end

  defp transform_through(op, concurrent) do
    Enum.reduce_while(concurrent, {:ok, op}, fn applied, {:ok, acc} ->
      case TextOperation.transform(acc, applied) do
        {:ok, {acc_prime, _applied_prime}} -> {:cont, {:ok, acc_prime}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end
end
