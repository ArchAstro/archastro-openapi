defmodule ArchAstro.OperationalTransform.TextOperationTest do
  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  doctest ArchAstro.OperationalTransform.TextOperation

  describe "building and lengths" do
    test "tracks base and target lengths" do
      op = Op.new() |> Op.retain(3) |> Op.insert("abc") |> Op.delete(2)
      assert op.base_length == 5
      assert op.target_length == 6
    end

    test "merges consecutive components of the same kind" do
      op = Op.new() |> Op.retain(2) |> Op.retain(3) |> Op.insert("a") |> Op.insert("b")
      assert Op.to_list(op) == [5, "ab"]
    end

    test "normalizes adjacent insert/delete to insert-first" do
      a = Op.new() |> Op.retain(1) |> Op.delete(2) |> Op.insert("xy")
      b = Op.new() |> Op.retain(1) |> Op.insert("xy") |> Op.delete(2)
      assert Op.to_list(a) == [1, "xy", -2]
      assert Op.to_list(a) == Op.to_list(b)
      assert Op.apply!(a, "abc") == "axy"
    end

    test "ignores empty components" do
      op = Op.new() |> Op.retain(0) |> Op.insert("") |> Op.delete(0)
      assert Op.to_list(op) == []
      assert Op.noop?(op)
    end

    test "measures in code points, not bytes or graphemes" do
      # "👍" is 1 code point (4 bytes); "é" is 2 code points (1 grapheme).
      op = Op.new() |> Op.retain(1) |> Op.delete(2)
      assert Op.apply!(op, "👍é") == "👍"
    end
  end

  describe "wire format" do
    test "round-trips" do
      op = Op.new() |> Op.retain(2) |> Op.insert("hi 🚀") |> Op.delete(3) |> Op.retain(1)
      assert op |> Op.to_list() |> Op.from_list!() == op
    end

    test "rejects garbage" do
      assert {:error, _} = Op.from_list([1, :nope])
      assert {:error, _} = Op.from_list([0])
      assert {:error, _} = Op.from_list(%{})
    end
  end

  describe "apply" do
    test "applies a mixed operation" do
      op = Op.new() |> Op.retain(6) |> Op.insert("world") |> Op.delete(5)
      assert Op.apply!(op, "hello there") == "hello world"
    end

    test "errors on length mismatch" do
      op = Op.new() |> Op.retain(3)
      assert {:error, {:length_mismatch, _}} = Op.apply(op, "ab")
    end
  end

  describe "invert" do
    test "undoes the operation" do
      doc = "hello *world*"
      op = Op.new() |> Op.retain(6) |> Op.delete(7) |> Op.insert("there")
      applied = Op.apply!(op, doc)
      assert Op.apply!(Op.invert(op, doc), applied) == doc
    end
  end

  describe "compose" do
    test "composition equals sequential application" do
      doc = "abcdef"
      a = Op.new() |> Op.retain(3) |> Op.insert("X") |> Op.retain(3)
      b = Op.new() |> Op.delete(2) |> Op.retain(5)
      composed = Op.compose!(a, b)
      assert Op.apply!(composed, doc) == Op.apply!(b, Op.apply!(a, doc))
    end

    test "rejects incompatible lengths" do
      a = Op.new() |> Op.retain(3)
      b = Op.new() |> Op.retain(4)
      assert {:error, {:compose_length_mismatch, _}} = Op.compose(a, b)
    end
  end

  describe "transform" do
    test "TP1: both orders converge" do
      doc = "she is a girl"
      a = Op.new() |> Op.retain(9) |> Op.insert("good ") |> Op.retain(4)
      b = Op.new() |> Op.delete(3) |> Op.insert("he") |> Op.retain(10)

      {a1, b1} = Op.transform!(a, b)

      assert Op.apply!(b1, Op.apply!(a, doc)) == Op.apply!(a1, Op.apply!(b, doc))
      assert Op.apply!(b1, Op.apply!(a, doc)) == "he is a good girl"
    end

    test "insert tie-break: left operand's insert comes first" do
      doc = "ab"
      a = Op.new() |> Op.retain(1) |> Op.insert("X") |> Op.retain(1)
      b = Op.new() |> Op.retain(1) |> Op.insert("Y") |> Op.retain(1)

      {a1, b1} = Op.transform!(a, b)
      assert Op.apply!(b1, Op.apply!(a, doc)) == "aXYb"
      assert Op.apply!(a1, Op.apply!(b, doc)) == "aXYb"
    end

    test "overlapping deletes converge" do
      doc = "abcdef"
      a = Op.new() |> Op.retain(1) |> Op.delete(3) |> Op.retain(2)
      b = Op.new() |> Op.retain(2) |> Op.delete(3) |> Op.retain(1)

      {a1, b1} = Op.transform!(a, b)
      assert Op.apply!(b1, Op.apply!(a, doc)) == Op.apply!(a1, Op.apply!(b, doc))
      assert Op.apply!(b1, Op.apply!(a, doc)) == "af"
    end

    test "rejects different base lengths" do
      a = Op.new() |> Op.retain(3)
      b = Op.new() |> Op.retain(4)
      assert {:error, {:transform_length_mismatch, _}} = Op.transform(a, b)
    end
  end

  describe "transform_index" do
    test "inserts before the index shift it right" do
      op = Op.new() |> Op.insert("ab") |> Op.retain(5)
      assert Op.transform_index(3, op) == 5
    end

    test "inserts after the index leave it alone" do
      op = Op.new() |> Op.retain(4) |> Op.insert("ab") |> Op.retain(1)
      assert Op.transform_index(3, op) == 3
    end

    test "deletes spanning the index clamp it" do
      op = Op.new() |> Op.retain(1) |> Op.delete(4)
      assert Op.transform_index(3, op) == 1
    end

    test "deletes before the index shift it left" do
      op = Op.new() |> Op.delete(2) |> Op.retain(3)
      assert Op.transform_index(4, op) == 2
    end
  end
end
