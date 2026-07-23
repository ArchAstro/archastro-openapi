defmodule ArchAstro.OtExampleWeb.Router do
  @moduledoc """
  Serves the single-page demo. `Plug.Static` (in the endpoint) handles real
  assets; anything else falls through to `index.html` so `/d/:doc_id` deep
  links work.
  """

  use Plug.Router

  alias ArchAstro.OperationalTransform.Document.Server

  plug :match
  plug :dispatch

  get "/" do
    send_index(conn)
  end

  # Read-only snapshot, used by tests to assert the authoritative content.
  get "/api/docs/:doc_id" do
    case Server.whereis(doc_id) do
      nil ->
        send_json(conn, 404, %{error: "not_found"})

      pid ->
        snap = Server.snapshot(pid)
        send_json(conn, 200, %{content: snap.content, revision: snap.revision})
    end
  end

  get "/d/:_doc_id" do
    send_index(conn)
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end

  defp send_index(conn) do
    index = Path.join(Application.app_dir(:ot_example, "priv/static"), "index.html")

    if File.exists?(index) do
      conn
      |> put_resp_content_type("text/html")
      |> send_file(200, index)
    else
      send_resp(
        conn,
        503,
        "Demo assets not built yet. Run `npm run build:demo` in src/ts/operational_transform."
      )
    end
  end
end
