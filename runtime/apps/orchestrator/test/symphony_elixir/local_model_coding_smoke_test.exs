defmodule SymphonyElixir.LocalModelCodingSmokeTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalModelCodingSmoke

  setup do
    workspace = Path.join(System.tmp_dir!(), "local-model-coding-smoke-test-#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(workspace) end)

    %{req_options: [plug: {Req.Test, __MODULE__}], workspace: workspace}
  end

  test "loops through shell read, apply_patch, shell verify, and final local model response", %{req_options: req_options, workspace: workspace} do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      send(test_pid, {:request, request})

      response =
        case length(request["messages"]) do
          2 -> tool_call_response("call-read-fixture", "shell.exec", %{"argv" => ["cat", "message.txt"]})
          4 -> tool_call_response("call-apply-patch", "apply_patch", %{"patch" => smoke_patch()})
          6 -> tool_call_response("call-verify-edit", "shell.exec", %{"argv" => ["./test.sh"]})
          8 -> final_response()
        end

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(response))
    end)

    assert {:ok, summary} =
             LocalModelCodingSmoke.run(
               config: %{
                 base_url: "http://ollama.test/v1",
                 model: "qwen2.5-coder:latest",
                 api_key: "ollama",
                 workspace: workspace
               },
               req_options: req_options
             )

    assert File.read!(Path.join(workspace, "message.txt")) == "after\n"
    {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)

    assert summary.provider == "openai_compatible"
    assert summary.model == "qwen2.5-coder:latest"
    assert summary.workspace == canonical_workspace
    assert summary.output_text == "Local model coding smoke passed."
    assert summary.tool_calls == ["shell.exec", "apply_patch", "shell.exec"]
    assert "provider_dispatch_started" in summary.events
    assert "provider_dispatch_completed" in summary.events
    assert "command_output_delta" in summary.events
    assert "patch_apply_end" in summary.events
    assert "command_completed" in summary.events
    assert "final_response" in summary.events

    assert_received {:request, first_request}
    assert_received {:request, second_request}
    assert_received {:request, third_request}
    assert_received {:request, fourth_request}

    assert [%{"function" => %{"name" => "apply_patch"}}, %{"function" => %{"name" => "shell.exec"}}] =
             Enum.map(first_request["tools"], & &1)

    assert get_in(first_request, ["tools", Access.at(1), "function", "parameters", "required"]) == ["argv"]
    assert Enum.at(second_request["messages"], 3)["role"] == "tool"
    assert Enum.at(third_request["messages"], 5)["role"] == "tool"
    assert Enum.at(fourth_request["messages"], 7)["role"] == "tool"
  end

  test "rejects patch paths outside the disposable workspace", %{req_options: req_options, workspace: workspace} do
    Req.Test.stub(__MODULE__, fn conn ->
      response =
        tool_call_response("call-apply-patch", "apply_patch", %{"patch" => "diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-before\n+after\n"})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(response))
    end)

    assert {:error, {:local_model_coding_smoke_failed, {:execution_policy, {:apply_patch_failed, {:unsafe_patch_path, "../escape.txt"}}}}} =
             LocalModelCodingSmoke.run(
               config: %{
                 base_url: "http://ollama.test/v1",
                 model: "qwen2.5-coder:latest",
                 api_key: "ollama",
                 workspace: workspace
               },
               req_options: req_options
             )
  end

  test "returns a typed smoke error when shell executable lookup fails", %{req_options: req_options, workspace: workspace} do
    Req.Test.stub(__MODULE__, fn conn ->
      response = tool_call_response("call-shell-exec", "shell.exec", %{"argv" => ["missing-local-model-smoke-executable"]})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(response))
    end)

    assert {:error, {:local_model_coding_smoke_failed, {:execution_policy, {:shell_exec_failed, {:system_cmd_error, :enoent}}}}} =
             LocalModelCodingSmoke.run(
               config: %{
                 base_url: "http://ollama.test/v1",
                 model: "qwen2.5-coder:latest",
                 api_key: "ollama",
                 workspace: workspace
               },
               req_options: req_options
             )
  end

  test "normalizes OLLAMA_BASE_URL roots to the OpenAI-compatible v1 base" do
    previous_values =
      Map.new(~w(SYMPHONY_LOCAL_MODEL_BASE_URL OLLAMA_OPENAI_BASE_URL OLLAMA_BASE_URL), fn key ->
        {key, System.get_env(key)}
      end)

    try do
      System.delete_env("SYMPHONY_LOCAL_MODEL_BASE_URL")
      System.delete_env("OLLAMA_OPENAI_BASE_URL")
      System.put_env("OLLAMA_BASE_URL", "http://127.0.0.1:11434")

      assert LocalModelCodingSmoke.default_config_from_env().base_url == "http://127.0.0.1:11434/v1"

      System.put_env("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1/")

      assert LocalModelCodingSmoke.default_config_from_env().base_url == "http://127.0.0.1:11434/v1"
    after
      Enum.each(previous_values, fn {key, value} -> restore_env(key, value) end)
    end
  end

  defp tool_call_response(id, name, arguments) do
    %{
      "id" => "chatcmpl-local-coding-smoke",
      "model" => "qwen2.5-coder:latest",
      "choices" => [
        %{
          "finish_reason" => "tool_calls",
          "message" => %{
            "role" => "assistant",
            "content" => nil,
            "tool_calls" => [
              %{
                "id" => id,
                "type" => "function",
                "function" => %{
                  "name" => name,
                  "arguments" => Jason.encode!(arguments)
                }
              }
            ]
          }
        }
      ],
      "usage" => %{}
    }
  end

  defp final_response do
    %{
      "id" => "chatcmpl-local-coding-smoke",
      "model" => "qwen2.5-coder:latest",
      "choices" => [
        %{
          "finish_reason" => "stop",
          "message" => %{
            "role" => "assistant",
            "content" => "Local model coding smoke passed."
          }
        }
      ],
      "usage" => %{"total_tokens" => 30}
    }
  end

  defp smoke_patch do
    """
    diff --git a/message.txt b/message.txt
    --- a/message.txt
    +++ b/message.txt
    @@ -1 +1 @@
    -before
    +after
    """
  end
end
