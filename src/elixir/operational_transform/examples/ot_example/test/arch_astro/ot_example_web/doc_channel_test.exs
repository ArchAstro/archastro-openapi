defmodule ArchAstro.OtExampleWeb.DocChannelTest do
  use ArchAstro.OtExampleWeb.ChannelCase, async: true

  alias ArchAstro.OperationalTransform.Client
  alias ArchAstro.OperationalTransform.Document.Server
  alias ArchAstro.OperationalTransform.TextOperation, as: Op
  alias ArchAstro.OtExampleWeb.DocSocket

  defp join!(actor_id, doc_id, params \\ %{}) do
    {:ok, socket} = connect(DocSocket, %{"actor_id" => actor_id})
    {:ok, reply, socket} = subscribe_and_join(socket, "doc:" <> doc_id, params)
    {reply, socket}
  end

  defp unique_doc, do: "test-doc-#{System.unique_integer([:positive])}"

  defp insert_at(content, pos, text) do
    len = Op.cp_length(content)
    Op.new() |> Op.retain(pos) |> Op.insert(text) |> Op.retain(len - pos)
  end

  test "join returns the document snapshot, assigned actor id and peers" do
    doc = unique_doc()

    {reply, _socket} = join!("alice", doc, %{"name" => "Alice", "color" => "#ff0000"})
    assert %{actor_id: "alice", revision: 0, content: content, actors: []} = reply
    assert content =~ "# Welcome"

    {reply2, _socket2} = join!("bob", doc)

    assert [%{actor_id: "alice", meta: %{"name" => "Alice", "color" => "#ff0000"}}] =
             reply2.actors

    assert_push "actor_joined", %{actor_id: "bob", meta: %{"name" => "Anonymous"}}
  end

  test "operations are acked and broadcast (transformed) to other editors" do
    doc = unique_doc()
    {%{content: content}, alice} = join!("alice", doc)
    {_reply, _bob} = join!("bob", doc)

    op = content |> insert_at(0, "hi! ") |> Op.to_list()
    ref = push(alice, "operation", %{"revision" => 0, "op" => op})
    assert_reply ref, :ok, %{revision: 1}

    assert_push "operation", %{actor_id: "alice", revision: 1, op: ^op}
  end

  test "two editors submitting concurrently against the same revision converge" do
    doc = unique_doc()
    {%{content: content}, alice_socket} = join!("alice", doc)
    {_reply, bob_socket} = join!("bob", doc)

    # Both editors edit revision-0 content concurrently: Alice prepends a
    # heading; Bob appends a line. Each runs the pure client state machine —
    # exactly what the browser does.
    alice_op = insert_at(content, 0, "# Alice was here\n")
    bob_op = insert_at(content, Op.cp_length(content), "\nBob's footer\n")

    alice = %{client: Client.new(0), replica: Op.apply!(alice_op, content)}
    bob = %{client: Client.new(0), replica: Op.apply!(bob_op, content)}

    {alice_client, [{:send, 0, _}]} = Client.apply_client(alice.client, alice_op)
    {bob_client, [{:send, 0, _}]} = Client.apply_client(bob.client, bob_op)
    alice = %{alice | client: alice_client}
    bob = %{bob | client: bob_client}

    # Both push against revision 0 — whichever lands second gets transformed.
    ref_a = push(alice_socket, "operation", %{"revision" => 0, "op" => Op.to_list(alice_op)})
    ref_b = push(bob_socket, "operation", %{"revision" => 0, "op" => Op.to_list(bob_op)})

    assert_reply ref_a, :ok, %{revision: _}
    assert_reply ref_b, :ok, %{revision: _}

    # Each editor sees exactly one broadcast: the other's (transformed) op.
    # Both test-process mailboxes are shared here, so collect two pushes.
    assert_push "operation", %{actor_id: first_id, op: first_op}
    assert_push "operation", %{actor_id: second_id, op: second_op}
    pushes = %{first_id => first_op, second_id => second_op}
    assert Map.keys(pushes) |> Enum.sort() == ["alice", "bob"]

    # Alice applies Bob's transformed op through her state machine, and vice
    # versa. Ack order relative to the remote push differs between the two
    # editors, but the pure client absorbs both interleavings.
    apply_remote = fn %{client: client, replica: replica} = editor, wire_op ->
      {client, to_apply} = Client.apply_server(client, Op.from_list!(wire_op))
      %{editor | client: client, replica: Op.apply!(to_apply, replica)}
    end

    ack = fn %{client: client} = editor ->
      {client, []} = Client.server_ack(client)
      %{editor | client: client}
    end

    # The channel test shares one mailbox, so replay deterministically: the
    # server processed Alice first (her reply carried the lower revision) —
    # infer order from payloads instead of assuming.
    {alice, bob} =
      if Op.from_list!(pushes["alice"]).base_length == Op.cp_length(content) do
        # Alice's op applied first: Bob transformed.
        alice = alice |> ack.() |> apply_remote.(pushes["bob"])
        bob = bob |> apply_remote.(pushes["alice"]) |> ack.()
        {alice, bob}
      else
        alice = alice |> apply_remote.(pushes["bob"]) |> ack.()
        bob = bob |> ack.() |> apply_remote.(pushes["alice"])
        {alice, bob}
      end

    %{content: server_content, revision: 2} = Server.snapshot(Server.via(doc))
    assert alice.replica == server_content
    assert bob.replica == server_content
    assert server_content =~ "# Alice was here"
    assert server_content =~ "Bob's footer"
  end

  test "cursor updates are broadcast to peers" do
    doc = unique_doc()
    {_reply, alice} = join!("alice", doc)
    {_reply, _bob} = join!("bob", doc)

    push(alice, "cursor", %{"cursor" => %{"position" => 3, "selection_end" => 7}})
    assert_push "cursor", %{actor_id: "alice", cursor: %{position: 3, selection_end: 7}}
  end

  test "stale revisions still apply; malformed payloads are rejected" do
    doc = unique_doc()
    {%{content: content}, alice} = join!("alice", doc)

    op1 = content |> insert_at(0, "one ") |> Op.to_list()
    ref1 = push(alice, "operation", %{"revision" => 0, "op" => op1})
    assert_reply ref1, :ok, %{revision: 1}

    # Bad: op doesn't fit the document.
    ref2 = push(alice, "operation", %{"revision" => 1, "op" => [1]})
    assert_reply ref2, :error, %{reason: _}

    # Bad: missing fields.
    ref3 = push(alice, "operation", %{"op" => [1]})
    assert_reply ref3, :error, %{reason: "malformed operation payload"}

    # Bad: unknown future revision.
    ref4 = push(alice, "operation", %{"revision" => 99, "op" => op1})
    assert_reply ref4, :error, %{reason: _}
  end

  test "invalid document ids are rejected at join" do
    {:ok, socket} = connect(DocSocket, %{})

    assert {:error, %{reason: "invalid document id"}} =
             subscribe_and_join(socket, "doc:no/slashes allowed")
  end
end
