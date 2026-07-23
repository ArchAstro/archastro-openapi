defmodule ArchAstro.OtExample.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: ArchAstro.OtExample.PubSub},
      ArchAstro.OtExampleWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: ArchAstro.OtExample.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
