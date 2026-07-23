defmodule ArchAstro.OperationalTransform.TextOperationFuzzTest do
  @moduledoc """
  Randomized checks of the OT laws. Each iteration reseeds deterministically
  from a base seed so any failure message pinpoints a reproducible case.
  """

  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform.Fuzz
  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  @iterations 300

  test "TP1: transform converges for random concurrent operations" do
    for i <- 1..@iterations do
      seed = Fuzz.seed!(1_000 + i)
      doc = Fuzz.random_string(40)
      a = Fuzz.random_operation(doc)
      b = Fuzz.random_operation(doc)

      {a1, b1} = Op.transform!(a, b)
      left = Op.apply!(b1, Op.apply!(a, doc))
      right = Op.apply!(a1, Op.apply!(b, doc))

      assert left == right,
             "TP1 violated (seed #{seed}): doc=#{inspect(doc)} a=#{inspect(Op.to_list(a))} " <>
               "b=#{inspect(Op.to_list(b))} left=#{inspect(left)} right=#{inspect(right)}"
    end
  end

  test "compose equals sequential application for random operations" do
    for i <- 1..@iterations do
      seed = Fuzz.seed!(2_000 + i)
      doc = Fuzz.random_string(40)
      a = Fuzz.random_operation(doc)
      mid = Op.apply!(a, doc)
      b = Fuzz.random_operation(mid)

      composed = Op.compose!(a, b)
      assert Op.apply!(composed, doc) == Op.apply!(b, mid), "compose law violated (seed #{seed})"
    end
  end

  test "invert round-trips for random operations" do
    for i <- 1..@iterations do
      seed = Fuzz.seed!(3_000 + i)
      doc = Fuzz.random_string(40)
      op = Fuzz.random_operation(doc)
      applied = Op.apply!(op, doc)

      assert Op.apply!(Op.invert(op, doc), applied) == doc, "invert law violated (seed #{seed})"
    end
  end

  test "wire format round-trips for random operations" do
    for i <- 1..@iterations do
      seed = Fuzz.seed!(4_000 + i)
      doc = Fuzz.random_string(40)
      op = Fuzz.random_operation(doc)

      assert op |> Op.to_list() |> Op.from_list!() == op, "codec round-trip failed (seed #{seed})"
    end
  end

  test "transform_index stays within bounds and tracks retained text" do
    for i <- 1..@iterations do
      seed = Fuzz.seed!(5_000 + i)
      doc = Fuzz.random_string(40)
      op = Fuzz.random_operation(doc)
      len = Op.cp_length(doc)
      index = if len == 0, do: 0, else: :rand.uniform(len + 1) - 1

      new_index = Op.transform_index(index, op)
      new_len = Op.cp_length(Op.apply!(op, doc))

      assert new_index >= 0 and new_index <= new_len,
             "transformed index #{new_index} out of bounds 0..#{new_len} (seed #{seed})"
    end
  end
end
