defmodule ArchAstro.OtExampleWeb.ChannelCase do
  @moduledoc false

  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest

      @endpoint ArchAstro.OtExampleWeb.Endpoint
    end
  end
end
