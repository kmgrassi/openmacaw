defmodule SymphonyElixir.LocalModelSmokeTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalModelSmoke

  setup do
    %{req_options: [plug: {Req.Test, __MODULE__}]}
  end

  test "calls an OpenAI-compatible endpoint and asserts normalized event completion", %{req_options: req_options} do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/v1/chat/completions"
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer ollama"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      send(test_pid, {:request, request})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "chatcmpl-local-smoke",
          "model" => "qwen2.5-coder:latest",
          "choices" => [
            %{
              "finish_reason" => "stop",
              "message" => %{
                "role" => "assistant",
                "content" => "Local Qwen smoke completed."
              }
            }
          ],
          "usage" => %{"prompt_tokens" => 7, "completion_tokens" => 5, "total_tokens" => 12}
        })
      )
    end)

    assert {:ok, summary} =
             LocalModelSmoke.run(
               config: %{
                 base_url: "http://ollama.test/v1",
                 model: "qwen2.5-coder:latest",
                 api_key: "ollama",
                 prompt: "Confirm the local model smoke test."
               },
               req_options: req_options
             )

    assert_received {:request, request}
    assert request["model"] == "qwen2.5-coder:latest"
    assert request["temperature"] == 0
    assert [%{"role" => "system"}, %{"role" => "user", "content" => "Confirm the local model smoke test."}] = request["messages"]

    assert summary.provider == "openai_compatible"
    assert summary.model == "qwen2.5-coder:latest"
    assert summary.output_text == "Local Qwen smoke completed."
    assert summary.normalized_events == ["message.delta", "usage.updated", "run.completed"]
    assert summary.usage["total_tokens"] == 12
  end

  test "fails when the completion does not produce normalized message deltas", %{req_options: req_options} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "model" => "qwen2.5-coder:latest",
          "choices" => [%{"finish_reason" => "stop", "message" => %{"content" => ""}}],
          "usage" => %{}
        })
      )
    end)

    assert {:error, {:local_model_smoke_failed, :empty_output}} =
             LocalModelSmoke.run(
               config: %{
                 base_url: "http://ollama.test/v1",
                 model: "qwen2.5-coder:latest",
                 api_key: "ollama",
                 prompt: "Confirm the local model smoke test."
               },
               req_options: req_options
             )
  end

  test "maps provider events to PR8 normalized event names" do
    assert LocalModelSmoke.normalized_event_names([
             %{event: :notification, payload: %{"method" => "provider/message.delta"}},
             %{event: :turn_completed},
             %{"type" => "usage.updated"}
           ]) == ["message.delta", "run.completed", "usage.updated"]
  end

  test "normalizes OLLAMA_BASE_URL roots to the OpenAI-compatible v1 base" do
    delete_system_envs(["SYMPHONY_LOCAL_MODEL_BASE_URL", "OLLAMA_OPENAI_BASE_URL"])
    put_system_env("OLLAMA_BASE_URL", "http://127.0.0.1:11434")

    assert LocalModelSmoke.default_config_from_env().base_url == "http://127.0.0.1:11434/v1"

    put_system_env("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1/")

    assert LocalModelSmoke.default_config_from_env().base_url == "http://127.0.0.1:11434/v1"
  end
end
