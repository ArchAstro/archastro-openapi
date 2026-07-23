defmodule ArchAstro.OperationalTransform.DocumentServerTest do
  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform, as: OT
  alias ArchAstro.OperationalTransform.Document.Server
  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  defp unique_id(tag), do: "#{tag}-#{System.unique_integer([:positive])}"

  defp spawn_subscriber do
    parent = self()

    spawn_link(fn ->
      receive_loop = fn loop ->
        receive do
          {:get, ref} ->
            send(parent, {ref, :ok})
            loop.(loop)

          msg ->
            send(parent, {:subscriber_got, msg})
            loop.(loop)
        end
      end

      receive_loop.(receive_loop)
    end)
  end

  test "join returns the current snapshot and lists other actors" do
    id = unique_id("join")
    {:ok, server} = OT.ensure_document(id, content: "# Doc")

    {:ok, snap} = Server.join(server, "alice", %{name: "Alice"})
    assert snap.content == "# Doc"
    assert snap.revision == 0
    assert snap.actors == %{}

    {:ok, snap2} = Server.join(server, "bob", %{name: "Bob"}, subscriber: spawn_subscriber())
    assert %{"alice" => %{meta: %{name: "Alice"}}} = snap2.actors

    assert_receive {:ot_doc, ^id, {:actor_joined, %{actor_id: "bob"}}}
  end

  test "submit applies, bumps revision and broadcasts to everyone else" do
    id = unique_id("submit")
    {:ok, server} = OT.ensure_document(id, content: "hello")
    {:ok, _} = Server.join(server, "alice")

    other = spawn_subscriber()
    {:ok, _} = Server.join(server, "bob", %{}, subscriber: other)

    op = Op.new() |> Op.retain(5) |> Op.insert(" world")
    assert {:ok, 1} = Server.submit(server, "alice", 0, op)

    # Bob's subscriber got the broadcast…
    assert_receive {:subscriber_got, {:ot_doc, ^id, {:operation, %{actor_id: "alice", op: ^op}}}}
    # …Alice (the submitter) did not.
    refute_receive {:ot_doc, ^id, {:operation, _}}, 50

    assert %{content: "hello world", revision: 1} = Server.snapshot(server)
  end

  test "concurrent submissions against the same revision are transformed" do
    id = unique_id("concurrent")
    {:ok, server} = OT.ensure_document(id, content: "ab")
    {:ok, _} = Server.join(server, "alice")
    {:ok, _} = Server.join(server, "bob", %{}, subscriber: spawn_subscriber())

    # Both ops are based on revision 0.
    a = Op.new() |> Op.insert("X") |> Op.retain(2)
    b = Op.new() |> Op.retain(2) |> Op.insert("Y")

    assert {:ok, 1} = Server.submit(server, "alice", 0, a)
    assert {:ok, 2} = Server.submit(server, "bob", 0, b)

    assert %{content: "XabY", revision: 2} = Server.snapshot(server)

    # Alice receives Bob's op already transformed to fit her replica ("Xab").
    assert_receive {:ot_doc, ^id, {:operation, %{actor_id: "bob", op: transformed}}}
    assert Op.apply!(transformed, "Xab") == "XabY"
  end

  test "accepts wire-format operations" do
    id = unique_id("wire")
    {:ok, server} = OT.ensure_document(id, content: "abc")
    {:ok, _} = Server.join(server, "alice")

    assert {:ok, 1} = Server.submit(server, "alice", 0, [1, "Z", -1, 1])
    assert %{content: "aZc"} = Server.snapshot(server)
  end

  test "rejects bad submissions without corrupting state" do
    id = unique_id("reject")
    {:ok, server} = OT.ensure_document(id, content: "abc")
    {:ok, _} = Server.join(server, "alice")

    assert {:error, {:unknown_revision, 9, _}} = Server.submit(server, "alice", 9, [3])
    assert {:error, {:length_mismatch, _}} = Server.submit(server, "alice", 0, [2])
    assert %{content: "abc", revision: 0} = Server.snapshot(server)
  end

  test "submit_async delivers the ack as a message" do
    id = unique_id("async")
    {:ok, server} = OT.ensure_document(id, content: "")
    {:ok, _} = Server.join(server, "alice")

    :ok = Server.submit_async(server, "alice", 0, ["hi"])
    assert_receive {:ot_ack, ^id, {:ok, 1}}
  end

  test "cursors are broadcast and transformed by later operations" do
    id = unique_id("cursor")
    {:ok, server} = OT.ensure_document(id, content: "abcdef")
    {:ok, _} = Server.join(server, "alice")
    {:ok, _} = Server.join(server, "bob", %{}, subscriber: spawn_subscriber())

    Server.update_cursor(server, "bob", %{position: 4, selection_end: 4})
    assert %{actors: %{"bob" => %{cursor: %{position: 4}}}} = Server.snapshot(server)

    # Alice inserts two chars at the start: Bob's stored cursor moves right.
    {:ok, _} = Server.submit(server, "alice", 0, ["XY", 6])
    assert %{actors: %{"bob" => %{cursor: %{position: 6}}}} = Server.snapshot(server)
  end

  test "a dead subscriber is removed and its departure broadcast" do
    id = unique_id("down")
    {:ok, server} = OT.ensure_document(id, content: "")
    {:ok, _} = Server.join(server, "alice")

    doomed = spawn(fn -> receive do: (:never -> :ok) end)
    {:ok, _} = Server.join(server, "bob", %{}, subscriber: doomed)
    assert %{actors: actors} = Server.snapshot(server)
    assert Map.has_key?(actors, "bob")

    Process.exit(doomed, :kill)
    assert_receive {:ot_doc, ^id, {:actor_left, %{actor_id: "bob"}}}
    assert %{actors: actors} = Server.snapshot(server)
    refute Map.has_key?(actors, "bob")
  end

  test "ensure_document is idempotent and stop_document stops" do
    id = unique_id("lifecycle")
    {:ok, pid} = OT.ensure_document(id)
    {:ok, ^pid} = OT.ensure_document(id)
    assert Server.whereis(id) == pid

    :ok = OT.stop_document(id)
    refute Process.alive?(pid)

    # Registry cleanup on process death is asynchronous.
    deadline = System.monotonic_time(:millisecond) + 1_000

    wait = fn wait ->
      cond do
        Server.whereis(id) == nil -> :ok
        System.monotonic_time(:millisecond) > deadline -> flunk("registry entry not cleaned up")
        true -> Process.sleep(10) && wait.(wait)
      end
    end

    wait.(wait)
  end
end
