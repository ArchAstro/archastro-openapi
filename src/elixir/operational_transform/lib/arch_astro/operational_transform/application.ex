defmodule ArchAstro.OperationalTransform.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Registry, keys: :unique, name: ArchAstro.OperationalTransform.Registry},
      {DynamicSupervisor,
       name: ArchAstro.OperationalTransform.DocumentSupervisor, strategy: :one_for_one}
    ]

    opts = [strategy: :one_for_one, name: ArchAstro.OperationalTransform.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
