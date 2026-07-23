defmodule ArchAstro.OperationalTransform.ActorConvergenceTest do
  @moduledoc """
  Simulates fleets of concurrent editors (each an
  `ArchAstro.OperationalTransform.Actor` gen_statem) hammering one document
  server with interleaved edits, then asserts every replica converges to the
  server's content. This is the OTP-level counterpart of the browser test in
  `src/ts/operational_transform`.
  """

  use ExUnit.Case, async: true

  alias ArchAstro.OperationalTransform, as: OT
  alias ArchAstro.OperationalTransform.{Actor, Fuzz}
  alias ArchAstro.OperationalTransform.Document.Server
  alias ArchAstro.OperationalTransform.TextOperation, as: Op

  @quiescence_timeout_ms 10_000

  defp unique_id(tag), do: "#{tag}-#{System.unique_integer([:positive])}"

  defp start_actor!(server, doc_id, actor_id) do
    {:ok, pid} =
      Actor.start_link(server: server, doc_id: doc_id, actor_id: actor_id, meta: %{})

    pid
  end

  # Everyone is quiescent when every actor is :synchronized at the server's
  # revision (which stops moving once all submissions have been processed).
  defp await_convergence(server, actors) do
    deadline = System.monotonic_time(:millisecond) + @quiescence_timeout_ms
    do_await(server, actors, deadline)
  end

  defp do_await(server, actors, deadline) do
    %{revision: server_rev} = Server.snapshot(server)

    done? =
      Enum.all?(actors, fn actor ->
        status = Actor.status(actor)
        status.state == :synchronized and status.revision == server_rev
      end)

    cond do
      done? ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        statuses = Enum.map(actors, &Actor.status/1)
        flunk("actors did not converge: server_rev=#{server_rev} #{inspect(statuses)}")

      true ->
        Process.sleep(20)
        do_await(server, actors, deadline)
    end
  end

  test "two actors editing the same position concurrently converge" do
    doc_id = unique_id("duel")
    {:ok, server} = OT.ensure_document(doc_id, content: "")

    a = start_actor!(server, doc_id, "alice")
    b = start_actor!(server, doc_id, "bob")

    :ok = Actor.edit(a, {:insert, 0, "A"})
    :ok = Actor.edit(b, {:insert, 0, "B"})

    await_convergence(server, [a, b])

    %{content: content} = Server.snapshot(server)
    assert content in ["AB", "BA"]
    assert Actor.content(a) == content
    assert Actor.content(b) == content
  end

  test "an actor buffers rapid edits while awaiting acks and still converges" do
    doc_id = unique_id("buffer")
    {:ok, server} = OT.ensure_document(doc_id, content: "")

    a = start_actor!(server, doc_id, "alice")

    # Fire many edits back-to-back: after the first, the actor is
    # :awaiting_confirm and everything else must go through the buffer.
    for ch <- ~w(a b c d e f g h) do
      :ok = Actor.edit(a, {:insert, Op.cp_length(Actor.content(a)), ch})
    end

    await_convergence(server, [a])
    assert Actor.content(a) == "abcdefgh"
    assert %{content: "abcdefgh"} = Server.snapshot(server)
  end

  test "five actors making random interleaved edits all converge" do
    doc_id = unique_id("fleet")
    initial = "# Shared document\n\nHello collaborative world.\n"
    {:ok, server} = OT.ensure_document(doc_id, content: initial)

    actor_ids = for n <- 1..5, do: "actor-#{n}"
    actors = for id <- actor_ids, do: start_actor!(server, doc_id, id)

    # Each actor runs in its own task, performing 30 random edits with tiny
    # jittered pauses so submissions genuinely interleave.
    tasks =
      actors
      |> Enum.with_index()
      |> Enum.map(fn {actor, idx} ->
        Task.async(fn ->
          Fuzz.seed!(9_000 + idx)

          for _ <- 1..30 do
            random_edit(actor)
            Process.sleep(:rand.uniform(5))
          end
        end)
      end)

    Enum.each(tasks, &Task.await(&1, 30_000))
    await_convergence(server, actors)

    %{content: server_content, revision: revision} = Server.snapshot(server)

    for actor <- actors do
      assert Actor.content(actor) == server_content
    end

    assert revision > 0
  end

  # A random insert or delete against the actor's current replica. The replica
  # can shift between reading it and editing (a remote op may land in
  # between), so out-of-range intents are simply retried — the same rebasing
  # any real editor UI performs.
  defp random_edit(actor, attempts \\ 5)
  defp random_edit(_actor, 0), do: :ok

  defp random_edit(actor, attempts) do
    content = Actor.content(actor)
    len = Op.cp_length(content)

    intent =
      case {:rand.uniform(3), len} do
        {_, 0} ->
          {:insert, 0, Fuzz.random_string(6) <> "i"}

        {1, _} ->
          pos = :rand.uniform(len + 1) - 1
          count = min(:rand.uniform(4), len - pos)
          if count > 0, do: {:delete, pos, count}, else: {:insert, pos, "x"}

        {_, _} ->
          {:insert, :rand.uniform(len + 1) - 1, Fuzz.random_string(6) <> "i"}
      end

    case Actor.edit(actor, intent) do
      :ok -> :ok
      {:error, _} -> random_edit(actor, attempts - 1)
    end
  end
end
