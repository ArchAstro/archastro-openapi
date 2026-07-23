defmodule ArchAstro.OtExampleWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :ot_example

  socket "/socket", ArchAstro.OtExampleWeb.DocSocket,
    websocket: true,
    longpoll: false

  plug Plug.Static, at: "/", from: {:ot_example, "priv/static"}, gzip: false
  plug ArchAstro.OtExampleWeb.Router
end
