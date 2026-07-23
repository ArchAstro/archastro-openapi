import Config

if port = System.get_env("PORT") do
  config :ot_example, ArchAstro.OtExampleWeb.Endpoint, http: [port: String.to_integer(port)]
end

if System.get_env("SERVER") in ~w(1 true) do
  config :ot_example, ArchAstro.OtExampleWeb.Endpoint, server: true
end
