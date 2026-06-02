defmodule SymphonyElixir.PlatformLearningClientTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.PlatformLearningClient

  setup do
    original_endpoint = System.get_env("PLATFORM_LEARNING_HANDLER_ENDPOINT")
    original_api_key = System.get_env("PLATFORM_LEARNING_HANDLER_API_KEY")

    Application.delete_env(:symphony_elixir, :platform_learning_handler)

    Application.put_env(:symphony_elixir, :platform_learning_req_options,
      plug: {Req.Test, __MODULE__}
    )

    System.delete_env("PLATFORM_LEARNING_HANDLER_ENDPOINT")
    System.delete_env("PLATFORM_LEARNING_HANDLER_API_KEY")

    on_exit(fn ->
      restore_env("PLATFORM_LEARNING_HANDLER_ENDPOINT", original_endpoint)
      restore_env("PLATFORM_LEARNING_HANDLER_API_KEY", original_api_key)
      Application.delete_env(:symphony_elixir, :platform_learning_handler)
      Application.delete_env(:symphony_elixir, :platform_learning_req_options)
    end)

    :ok
  end

  test "reads handler endpoint and api key from environment variables" do
    System.put_env("PLATFORM_LEARNING_HANDLER_ENDPOINT", "https://platform.example/")
    System.put_env("PLATFORM_LEARNING_HANDLER_API_KEY", "secret-key")

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.request_path == "/api/learning/jobs/learning_reflection"
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer secret-key"]

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(%{"accepted" => true}))
    end)

    assert {:ok, %{"accepted" => true}} =
             PlatformLearningClient.post_job("learning_reflection", %{})
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end
