defmodule ArchAstro.OperationalTransform.MixProject do
  use Mix.Project

  def project do
    [
      app: :operational_transform,
      version: "0.1.0",
      elixir: "~> 1.18",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      description: "Operational transformation for collaborative markdown editing",
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {ArchAstro.OperationalTransform.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    []
  end
end
