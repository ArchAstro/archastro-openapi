defmodule ArchAstro.OperationalTransform.ClientTest do
  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform.Client
  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  defp insert_at(pos, text, len) do
    Op.new() |> Op.retain(pos) |> Op.insert(text) |> Op.retain(len - pos)
  end

  test "synchronized: local edit is sent immediately" do
    client = Client.new(3)
    op = insert_at(0, "x", 0)

    {client, sends} = Client.apply_client(client, op)
    assert sends == [{:send, 3, op}]
    assert Client.state_name(client) == :awaiting_confirm
  end

  test "awaiting_confirm: further edits buffer; ack flushes the buffer" do
    client = Client.new(0)

    {client, [_]} = Client.apply_client(client, insert_at(0, "a", 0))
    {client, []} = Client.apply_client(client, insert_at(1, "b", 1))
    {client, []} = Client.apply_client(client, insert_at(2, "c", 2))
    assert Client.state_name(client) == :awaiting_with_buffer

    # Ack for "a": buffer ("bc", composed) goes out based on revision 1.
    {client, sends} = Client.server_ack(client)
    assert [{:send, 1, buffer}] = sends
    assert Op.to_list(buffer) == [1, "bc"]
    assert Client.state_name(client) == :awaiting_confirm

    {client, []} = Client.server_ack(client)
    assert Client.state_name(client) == :synchronized
    assert client.revision == 2
  end

  test "server_ack in synchronized state is an error" do
    assert Client.server_ack(Client.new(0)) == {:error, :not_awaiting}
  end

  test "remote ops are transformed over outstanding and buffered edits" do
    # Local replica: "ab", server rev 0. User types "X" at 0 (sent) and "Y"
    # after it (buffered). Server broadcasts a remote insert "R" at end (rev0).
    client = Client.new(0)
    local = "ab"

    op_x = insert_at(0, "X", 2)
    local = Op.apply!(op_x, local)
    {client, [_]} = Client.apply_client(client, op_x)

    op_y = insert_at(1, "Y", 3)
    local = Op.apply!(op_y, local)
    {client, []} = Client.apply_client(client, op_y)
    assert local == "XYab"

    remote = Op.new() |> Op.retain(2) |> Op.insert("R")
    {client, to_apply} = Client.apply_server(client, remote)
    local = Op.apply!(to_apply, local)

    assert local == "XYabR"
    assert client.revision == 1

    # After both our ops are acked the server must agree. Simulate the server:
    # it applies remote first, then transforms ours against it.
    server = "abR"
    {x_prime, _} = Op.transform!(op_x, remote)
    server = Op.apply!(x_prime, server)
    {client, sends} = Client.server_ack(client)
    assert [{:send, 2, buffer}] = sends
    server = Op.apply!(buffer, server)
    {_client, []} = Client.server_ack(client)

    assert server == local
  end
end
