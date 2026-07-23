defmodule ArchAstro.OtExampleWeb.DocSocket do
  use Phoenix.Socket

  channel "doc:*", ArchAstro.OtExampleWeb.DocChannel

  @impl true
  def connect(params, socket, _connect_info) do
    actor_id =
      case params["actor_id"] do
        id when is_binary(id) and byte_size(id) in 1..64 -> id
        _ -> "actor-" <> Base.url_encode64(:crypto.strong_rand_bytes(9))
      end

    {:ok, assign(socket, :actor_id, actor_id)}
  end

  @impl true
  def id(_socket), do: nil
end
