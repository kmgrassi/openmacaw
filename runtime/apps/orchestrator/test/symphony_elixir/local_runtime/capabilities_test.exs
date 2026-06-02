defmodule SymphonyElixir.LocalRuntime.CapabilitiesTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRuntime.Capabilities

  test "normalizes runner model capability payloads and redacts sensitive metadata" do
    observed_at = ~U[2026-04-26 12:00:00Z]

    frame = %{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "metadata" => %{
        "endpoint" => "http://user:pass@127.0.0.1:11434/v1?api_key=secret&model=qwen",
        "api_key" => "secret",
        "authorization_header" => "Bearer secret"
      },
      "runners" => [
        %{
          "runner_kind" => "openai_compatible",
          "provider" => "ollama",
          "capabilities" => %{"streaming" => true, "json_mode" => "true"},
          "models" => [
            %{
              "model" => "qwen2.5-coder:latest",
              "capabilities" => %{
                "tool_calls" => false,
                "structured_output" => "best_effort",
                "context_window" => "32768"
              }
            }
          ]
        }
      ]
    }

    assert {:ok, [entry]} = Capabilities.normalize_frame(frame, observed_at: observed_at)

    assert entry["workspace_id"] == "workspace-1"
    assert entry["machine_id"] == "machine-1"
    assert entry["runner_kind"] == "openai_compatible"
    assert entry["provider"] == "ollama"
    assert entry["model"] == "qwen2.5-coder:latest"

    assert entry["capabilities"] == %{
             "streaming" => true,
             "tool_calls" => false,
             "structured_output" => "best_effort",
             "json_mode" => true,
             "context_window" => 32768,
             "runtime_managed_tools" => false
           }

    assert entry["metadata"]["endpoint"] == "http://127.0.0.1:11434/v1?api_key=%5BREDACTED%5D&model=qwen"
    assert entry["metadata"]["api_key"] == "[REDACTED]"
    assert entry["metadata"]["authorization_header"] == "[REDACTED]"
    assert entry["observed_at"] == "2026-04-26T12:00:00Z"
    assert entry["snapshot_id"] =~ "lrcap_"
  end

  test "preserves runtime_managed_tools when helper advertises it" do
    frame = %{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "runners" => [
        %{
          "runner_kind" => "openai_compatible",
          "provider" => "ollama",
          "capabilities" => %{"runtime_managed_tools" => true},
          "models" => [%{"model" => "qwen2.5-coder:latest"}]
        }
      ]
    }

    assert {:ok, [entry]} = Capabilities.normalize_frame(frame)
    assert entry["capabilities"]["runtime_managed_tools"] == true
  end

  test "rejects frames without model capabilities" do
    assert {:error, :no_capabilities} =
             Capabilities.normalize_frame(%{
               "workspace_id" => "workspace-1",
               "machine_id" => "machine-1",
               "runners" => [%{"runner_kind" => "openai_compatible"}]
             })
  end

  test "requires workspace and machine identity" do
    assert {:error, {:missing_required_field, "workspace_id"}} =
             Capabilities.normalize_frame(%{"machine_id" => "machine-1", "model" => "qwen"})

    assert {:error, {:missing_required_field, "machine_id"}} =
             Capabilities.normalize_frame(%{"workspace_id" => "workspace-1", "model" => "qwen"})
  end
end
