defmodule ArchAstro.OperationalTransform.TextOperation do
  @moduledoc """
  A text operation: an ordered list of `retain`, `insert` and `delete`
  components that, applied front-to-back, rewrites one document string into
  another.

  The representation (and the wire format produced by `to_list/1`) is
  compatible with ot.js:

    * a positive integer `n` retains (skips over) `n` characters,
    * a string inserts that string at the current position,
    * a negative integer `-n` deletes `n` characters at the current position.

  All lengths and positions are measured in **Unicode code points**, never in
  bytes or UTF-16 units. The companion TypeScript library uses the same unit,
  which is what makes cross-language convergence possible for non-BMP
  characters (emoji etc.).

  `base_length` is the code-point length of a document the operation can be
  applied to; `target_length` is the length of the result.

  ## Examples

      iex> alias ArchAstro.OperationalTransform.TextOperation
      iex> op = TextOperation.new() |> TextOperation.retain(6) |> TextOperation.insert("world") |> TextOperation.delete(5)
      iex> TextOperation.apply!(op, "hello there")
      "hello world"
      iex> TextOperation.to_list(op)
      [6, "world", -5]
  """

  defstruct ops: [], base_length: 0, target_length: 0

  @type component :: {:retain, pos_integer()} | {:insert, String.t()} | {:delete, pos_integer()}
  @type t :: %__MODULE__{
          ops: [component()],
          base_length: non_neg_integer(),
          target_length: non_neg_integer()
        }

  @doc "Returns an empty operation."
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "The operation's components in application order."
  @spec ops(t()) :: [component()]
  def ops(%__MODULE__{ops: rev_ops}), do: Enum.reverse(rev_ops)

  @doc "Code-point length of a string (the unit all operations are measured in)."
  @spec cp_length(String.t()) :: non_neg_integer()
  def cp_length(s) when is_binary(s), do: length(String.to_charlist(s))

  @doc "Skip over `n` characters."
  @spec retain(t(), non_neg_integer()) :: t()
  def retain(op, 0), do: op

  def retain(%__MODULE__{} = op, n) when is_integer(n) and n > 0 do
    ops =
      case op.ops do
        [{:retain, m} | rest] -> [{:retain, m + n} | rest]
        rest -> [{:retain, n} | rest]
      end

    %{op | ops: ops, base_length: op.base_length + n, target_length: op.target_length + n}
  end

  @doc "Insert `text` at the current position."
  @spec insert(t(), String.t()) :: t()
  def insert(op, ""), do: op

  def insert(%__MODULE__{} = op, text) when is_binary(text) do
    # Enforce the canonical form used by ot.js: when an insert and a delete are
    # adjacent, the insert always comes first (the effect is identical).
    ops =
      case op.ops do
        [{:insert, s} | rest] ->
          [{:insert, s <> text} | rest]

        [{:delete, d}, {:insert, s} | rest] ->
          [{:delete, d}, {:insert, s <> text} | rest]

        [{:delete, d} | rest] ->
          [{:delete, d}, {:insert, text} | rest]

        rest ->
          [{:insert, text} | rest]
      end

    %{op | ops: ops, target_length: op.target_length + cp_length(text)}
  end

  @doc "Delete `n` characters at the current position."
  @spec delete(t(), non_neg_integer() | String.t()) :: t()
  def delete(op, 0), do: op
  def delete(op, s) when is_binary(s), do: delete(op, cp_length(s))

  def delete(%__MODULE__{} = op, n) when is_integer(n) and n > 0 do
    ops =
      case op.ops do
        [{:delete, m} | rest] -> [{:delete, m + n} | rest]
        rest -> [{:delete, n} | rest]
      end

    %{op | ops: ops, base_length: op.base_length + n}
  end

  @doc "True if the operation changes nothing (only retains)."
  @spec noop?(t()) :: boolean()
  def noop?(%__MODULE__{ops: []}), do: true
  def noop?(%__MODULE__{ops: [{:retain, _}]}), do: true
  def noop?(%__MODULE__{}), do: false

  ## Wire format ##############################################################

  @doc """
  Converts to the ot.js-compatible wire format.

      iex> alias ArchAstro.OperationalTransform.TextOperation
      iex> TextOperation.new() |> TextOperation.retain(2) |> TextOperation.delete(1) |> TextOperation.to_list()
      [2, -1]
  """
  @spec to_list(t()) :: [integer() | String.t()]
  def to_list(%__MODULE__{} = op) do
    Enum.map(ops(op), fn
      {:retain, n} -> n
      {:insert, s} -> s
      {:delete, n} -> -n
    end)
  end

  @doc "Parses the wire format produced by `to_list/1` (and by the JS library)."
  @spec from_list([integer() | String.t()]) :: {:ok, t()} | {:error, term()}
  def from_list(list) when is_list(list) do
    op =
      Enum.reduce_while(list, new(), fn
        n, acc when is_integer(n) and n > 0 -> {:cont, retain(acc, n)}
        n, acc when is_integer(n) and n < 0 -> {:cont, delete(acc, -n)}
        s, acc when is_binary(s) and s != "" -> {:cont, insert(acc, s)}
        other, _acc -> {:halt, {:error, {:invalid_component, other}}}
      end)

    case op do
      {:error, _} = err -> err
      %__MODULE__{} = op -> {:ok, op}
    end
  end

  def from_list(other), do: {:error, {:invalid_operation, other}}

  @doc "Same as `from_list/1` but raises on invalid input."
  @spec from_list!([integer() | String.t()]) :: t()
  def from_list!(list) do
    case from_list(list) do
      {:ok, op} -> op
      {:error, reason} -> raise ArgumentError, "invalid operation: #{inspect(reason)}"
    end
  end

  ## Apply ####################################################################

  @doc """
  Applies the operation to `text`, returning `{:ok, result}` or an error if
  the operation's `base_length` doesn't match the text.
  """
  @spec apply(t(), String.t()) :: {:ok, String.t()} | {:error, term()}
  def apply(%__MODULE__{} = op, text) when is_binary(text) do
    chars = String.to_charlist(text)

    if length(chars) != op.base_length do
      {:error, {:length_mismatch, expected: op.base_length, got: length(chars)}}
    else
      {:ok, do_apply(ops(op), chars, [])}
    end
  end

  @doc "Same as `apply/2` but raises on mismatch."
  @spec apply!(t(), String.t()) :: String.t()
  def apply!(op, text) do
    case __MODULE__.apply(op, text) do
      {:ok, result} -> result
      {:error, reason} -> raise ArgumentError, "cannot apply operation: #{inspect(reason)}"
    end
  end

  defp do_apply([], [], acc), do: acc |> Enum.reverse() |> List.to_string()

  defp do_apply([{:retain, n} | rest], chars, acc) do
    {taken, chars} = Enum.split(chars, n)
    do_apply(rest, chars, Enum.reverse(taken, acc))
  end

  defp do_apply([{:insert, s} | rest], chars, acc) do
    do_apply(rest, chars, Enum.reverse(String.to_charlist(s), acc))
  end

  defp do_apply([{:delete, n} | rest], chars, acc) do
    do_apply(rest, Enum.drop(chars, n), acc)
  end

  ## Invert ###################################################################

  @doc """
  Computes the inverse operation relative to the document the operation was
  applied to. `apply!(invert(op, doc), apply!(op, doc)) == doc`.
  """
  @spec invert(t(), String.t()) :: t()
  def invert(%__MODULE__{} = op, text) when is_binary(text) do
    do_invert(ops(op), String.to_charlist(text), new())
  end

  defp do_invert([], [], inverse), do: inverse

  defp do_invert([{:retain, n} | rest], chars, inverse) do
    do_invert(rest, Enum.drop(chars, n), retain(inverse, n))
  end

  defp do_invert([{:insert, s} | rest], chars, inverse) do
    do_invert(rest, chars, delete(inverse, cp_length(s)))
  end

  defp do_invert([{:delete, n} | rest], chars, inverse) do
    {deleted, chars} = Enum.split(chars, n)
    do_invert(rest, chars, insert(inverse, List.to_string(deleted)))
  end

  ## Compose ##################################################################

  @doc """
  Composes two consecutive operations into one with the same effect:
  `apply!(compose!(a, b), doc) == apply!(b, apply!(a, doc))`.

  Requires `a.target_length == b.base_length`.
  """
  @spec compose(t(), t()) :: {:ok, t()} | {:error, term()}
  def compose(%__MODULE__{} = a, %__MODULE__{} = b) do
    if a.target_length != b.base_length do
      {:error,
       {:compose_length_mismatch, target_of_first: a.target_length, base_of_second: b.base_length}}
    else
      {:ok, do_compose(ops(a), ops(b), new())}
    end
  end

  @doc "Same as `compose/2` but raises on mismatch."
  @spec compose!(t(), t()) :: t()
  def compose!(a, b) do
    case compose(a, b) do
      {:ok, op} -> op
      {:error, reason} -> raise ArgumentError, "cannot compose: #{inspect(reason)}"
    end
  end

  defp do_compose([], [], acc), do: acc

  # Deletes in `a` happen regardless of what `b` does afterwards.
  defp do_compose([{:delete, n} | as], bs, acc), do: do_compose(as, bs, delete(acc, n))

  # Inserts in `b` happen regardless of what `a` did before.
  defp do_compose(as, [{:insert, s} | bs], acc), do: do_compose(as, bs, insert(acc, s))

  defp do_compose([{:retain, n} | as], [{:retain, m} | bs], acc) do
    cond do
      n > m -> do_compose([{:retain, n - m} | as], bs, retain(acc, m))
      n == m -> do_compose(as, bs, retain(acc, n))
      true -> do_compose(as, [{:retain, m - n} | bs], retain(acc, n))
    end
  end

  defp do_compose([{:retain, n} | as], [{:delete, m} | bs], acc) do
    cond do
      n > m -> do_compose([{:retain, n - m} | as], bs, delete(acc, m))
      n == m -> do_compose(as, bs, delete(acc, n))
      true -> do_compose(as, [{:delete, m - n} | bs], delete(acc, n))
    end
  end

  defp do_compose([{:insert, s} | as], [{:retain, m} | bs], acc) do
    slen = cp_length(s)

    cond do
      slen > m ->
        {head, tail} = cp_split(s, m)
        do_compose([{:insert, tail} | as], bs, insert(acc, head))

      slen == m ->
        do_compose(as, bs, insert(acc, s))

      true ->
        do_compose(as, [{:retain, m - slen} | bs], insert(acc, s))
    end
  end

  defp do_compose([{:insert, s} | as], [{:delete, m} | bs], acc) do
    slen = cp_length(s)

    cond do
      slen > m ->
        {_deleted, tail} = cp_split(s, m)
        do_compose([{:insert, tail} | as], bs, acc)

      slen == m ->
        do_compose(as, bs, acc)

      true ->
        do_compose(as, [{:delete, m - slen} | bs], acc)
    end
  end

  defp do_compose(as, bs, _acc) do
    raise ArgumentError,
          "compose: operations do not fit together (remaining: #{inspect(as)} / #{inspect(bs)})"
  end

  ## Transform ################################################################

  @doc """
  The heart of OT. Given two operations `a` and `b` that were produced
  concurrently against the same document, computes `{a', b'}` such that

      apply!(b', apply!(a, doc)) == apply!(a', apply!(b, doc))

  (the TP1 convergence property). When both sides insert at the same
  position, `a`'s insert is ordered first — the server uses the incoming
  operation as `a` and its concurrent history as `b`, and the client mirrors
  that choice, so both sides break the tie identically.
  """
  @spec transform(t(), t()) :: {:ok, {t(), t()}} | {:error, term()}
  def transform(%__MODULE__{} = a, %__MODULE__{} = b) do
    if a.base_length != b.base_length do
      {:error, {:transform_length_mismatch, a: a.base_length, b: b.base_length}}
    else
      {:ok, do_transform(ops(a), ops(b), new(), new())}
    end
  end

  @doc "Same as `transform/2` but raises on mismatch."
  @spec transform!(t(), t()) :: {t(), t()}
  def transform!(a, b) do
    case transform(a, b) do
      {:ok, pair} -> pair
      {:error, reason} -> raise ArgumentError, "cannot transform: #{inspect(reason)}"
    end
  end

  defp do_transform([], [], a1, b1), do: {a1, b1}

  # a inserts: goes into a' as insert, b' must retain over it. Tie-break: a first.
  defp do_transform([{:insert, s} | as], bs, a1, b1) do
    do_transform(as, bs, insert(a1, s), retain(b1, cp_length(s)))
  end

  defp do_transform(as, [{:insert, s} | bs], a1, b1) do
    do_transform(as, bs, retain(a1, cp_length(s)), insert(b1, s))
  end

  defp do_transform([{:retain, n} | as], [{:retain, m} | bs], a1, b1) do
    cond do
      n > m -> do_transform([{:retain, n - m} | as], bs, retain(a1, m), retain(b1, m))
      n == m -> do_transform(as, bs, retain(a1, n), retain(b1, n))
      true -> do_transform(as, [{:retain, m - n} | bs], retain(a1, n), retain(b1, n))
    end
  end

  # Both delete the same region: nothing to do for the overlap.
  defp do_transform([{:delete, n} | as], [{:delete, m} | bs], a1, b1) do
    cond do
      n > m -> do_transform([{:delete, n - m} | as], bs, a1, b1)
      n == m -> do_transform(as, bs, a1, b1)
      true -> do_transform(as, [{:delete, m - n} | bs], a1, b1)
    end
  end

  defp do_transform([{:delete, n} | as], [{:retain, m} | bs], a1, b1) do
    cond do
      n > m -> do_transform([{:delete, n - m} | as], bs, delete(a1, m), b1)
      n == m -> do_transform(as, bs, delete(a1, n), b1)
      true -> do_transform(as, [{:retain, m - n} | bs], delete(a1, n), b1)
    end
  end

  defp do_transform([{:retain, n} | as], [{:delete, m} | bs], a1, b1) do
    cond do
      n > m -> do_transform([{:retain, n - m} | as], bs, a1, delete(b1, m))
      n == m -> do_transform(as, bs, a1, delete(b1, n))
      true -> do_transform(as, [{:delete, m - n} | bs], a1, delete(b1, n))
    end
  end

  defp do_transform(as, bs, _a1, _b1) do
    raise ArgumentError,
          "transform: operations do not fit together (remaining: #{inspect(as)} / #{inspect(bs)})"
  end

  ## Cursor transformation ####################################################

  @doc """
  Transforms a cursor position (code-point index) against an operation, so a
  remote actor's cursor stays attached to the text around it. Mirrors ot.js's
  `Cursor.transform`: inserts at or before the cursor push it right, deletes
  spanning it clamp it to the deletion point.
  """
  @spec transform_index(non_neg_integer(), t()) :: non_neg_integer()
  def transform_index(index, %__MODULE__{} = op) do
    do_transform_index(ops(op), index, index)
  end

  # `countdown` is the distance from the current scan position to the original
  # cursor; `result` is the transformed index accumulated so far.
  defp do_transform_index([], _countdown, result), do: max(result, 0)

  defp do_transform_index([{:retain, n} | rest], countdown, result) do
    if countdown - n < 0,
      do: max(result, 0),
      else: do_transform_index(rest, countdown - n, result)
  end

  defp do_transform_index([{:insert, s} | rest], countdown, result) do
    do_transform_index(rest, countdown, result + cp_length(s))
  end

  defp do_transform_index([{:delete, n} | rest], countdown, result) do
    result = result - min(countdown, n)

    if countdown - n < 0,
      do: max(result, 0),
      else: do_transform_index(rest, countdown - n, result)
  end

  ## Helpers ##################################################################

  defp cp_split(s, n) do
    {head, tail} = s |> String.to_charlist() |> Enum.split(n)
    {List.to_string(head), List.to_string(tail)}
  end
end
