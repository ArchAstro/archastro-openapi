import Config

config :ot_example, ArchAstro.OtExampleWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  pubsub_server: ArchAstro.OtExample.PubSub,
  # Dev/demo-only key; never reuse for anything real.
  secret_key_base: "ot-example-dev-secret-key-base-0123456789abcdefghijklmnopqrstuv",
  http: [ip: {127, 0, 0, 1}, port: 4000]

config :logger, level: :info

config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"
