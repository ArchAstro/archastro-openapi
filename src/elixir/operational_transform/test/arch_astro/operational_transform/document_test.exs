defmodule ArchAstro.OperationalTransform.DocumentTest do
  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform.Document
  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  test "applies an up-to-date operation" do
    doc = Document.new("d", "hello")
    op = Op.new() |> Op.retain(5) |> Op.insert(" world")

    assert {:ok, transformed, doc} = Document.receive_operation(doc, 0, op)
    assert transformed == op
    assert doc.content == "hello world"
    assert doc.revision == 1
  end

  test "transforms an operation submitted against a stale revision" do
    doc = Document.new("d", "ab")

    # Rev 0 -> 1: insert "X" at 0.
    op1 = Op.new() |> Op.insert("X") |> Op.retain(2)
    {:ok, _, doc} = Document.receive_operation(doc, 0, op1)
    assert doc.content == "Xab"

    # Concurrent op also based on rev 0: insert "Y" between a and b.
    op2 = Op.new() |> Op.retain(1) |> Op.insert("Y") |> Op.retain(1)
    {:ok, transformed, doc} = Document.receive_operation(doc, 0, op2)

    assert doc.content == "XaYb"
    assert doc.revision == 2
    # The broadcastable transformed op fits the head content pre-application.
    assert Op.apply!(transformed, "Xab") == "XaYb"
  end

  test "transforms across several missed revisions" do
    doc = Document.new("d", "")

    {:ok, _, doc} =
      Document.receive_operation(doc, 0, Op.new() |> Op.insert("aaa"))

    {:ok, _, doc} =
      Document.receive_operation(doc, 1, Op.new() |> Op.retain(3) |> Op.insert("bbb"))

    # Based on empty rev-0 document.
    late = Op.new() |> Op.insert("zzz")
    {:ok, _, doc} = Document.receive_operation(doc, 0, late)

    assert doc.revision == 3
    assert doc.content == "zzzaaabbb"
  end

  test "rejects unknown revisions" do
    doc = Document.new("d", "x")
    op = Op.new() |> Op.retain(1)

    assert {:error, {:unknown_revision, 5, _}} = Document.receive_operation(doc, 5, op)
    assert {:error, {:unknown_revision, -1, _}} = Document.receive_operation(doc, -1, op)
  end

  test "rejects operations that do not fit the document" do
    doc = Document.new("d", "abc")
    op = Op.new() |> Op.retain(2)

    assert {:error, {:length_mismatch, _}} = Document.receive_operation(doc, 0, op)
  end
end
