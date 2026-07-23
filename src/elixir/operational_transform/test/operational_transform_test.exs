defmodule ArchAstro.OperationalTransformTest do
  use ExUnit.Case, async: true

  test "ensure_document starts a supervised, registry-addressed server" do
    id = "top-level-#{System.unique_integer([:positive])}"
    {:ok, pid} = ArchAstro.OperationalTransform.ensure_document(id, content: "hi")
    assert ArchAstro.OperationalTransform.Document.Server.whereis(id) == pid
    assert %{content: "hi"} = ArchAstro.OperationalTransform.Document.Server.snapshot(pid)
    :ok = ArchAstro.OperationalTransform.stop_document(id)
  end
end
