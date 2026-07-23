defmodule ArchAstro.OperationalTransform.Fuzz do
  @moduledoc """
  Deterministic (seeded) generators for randomized OT-law tests.

  Uses `:rand` with an explicit seed per test run so failures are
  reproducible: every fuzz test prints its seed on failure.
  """

  alias ArchAstro.OperationalTransform.TextOperation

  # Includes multi-byte and astral characters on purpose: the whole point of
  # measuring operations in code points is that these must round-trip.
  @alphabet String.to_charlist("abcdefghij ABC\nöß💡🚀é#*_`")

  def seed!(seed \\ nil) do
    seed = seed || :erlang.unique_integer([:positive])
    :rand.seed(:exsss, {seed, seed + 1, seed + 2})
    seed
  end

  def random_string(max_len \\ 12) do
    len = :rand.uniform(max_len + 1) - 1
    for _ <- 1..len//1, into: "", do: <<Enum.random(@alphabet)::utf8>>
  end

  @doc "A random valid operation against `doc`."
  def random_operation(doc) do
    remaining = TextOperation.cp_length(doc)
    build(TextOperation.new(), remaining)
  end

  defp build(op, 0) do
    # Maybe tack an insert on the end.
    if :rand.uniform(3) == 1, do: TextOperation.insert(op, random_string()), else: op
  end

  defp build(op, remaining) do
    chunk = :rand.uniform(remaining)

    case :rand.uniform(3) do
      1 -> build(TextOperation.retain(op, chunk), remaining - chunk)
      2 -> build(TextOperation.delete(op, chunk), remaining - chunk)
      3 -> build(TextOperation.insert(op, random_string()), remaining)
    end
  end
end
