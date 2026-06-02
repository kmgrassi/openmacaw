defmodule SymphonyElixir.Orchestrator.StarterTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Orchestrator.Starter

  @moduletag :launcher

  describe "build_workflow_content/1" do
    test "generates valid YAML front matter with tracker config" do
      config = %{"tracker" => %{"kind" => "memory"}}
      content = Starter.build_workflow_content(config)

      assert content =~ "---"
      assert content =~ "tracker:"
      assert content =~ "kind: memory"
    end

    test "includes repository in workspace section" do
      config = %{
        "tracker" => %{"kind" => "database", "endpoint" => "http://localhost:3000"},
        "repository" => "https://github.com/org/repo"
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "workspace:"
      assert content =~ "repository: https://github.com/org/repo"
      assert content =~ "tracker:"
      assert content =~ "kind: database"
      assert content =~ "endpoint: http://localhost:3000"
    end

    test "includes agent config from top-level max_concurrent_agents" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "max_concurrent_agents" => 5
      }

      content = Starter.build_workflow_content(config)
      assert content =~ "agent:"
      assert content =~ "max_concurrent_agents: 5"
    end

    test "uses custom prompt when provided" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "prompt" => "Custom prompt for this orchestrator"
      }

      content = Starter.build_workflow_content(config)
      assert content =~ "Custom prompt for this orchestrator"
    end

    test "uses default prompt when none provided" do
      config = %{"tracker" => %{"kind" => "memory"}}
      content = Starter.build_workflow_content(config)

      assert content =~ "You are working on an issue"
      assert content =~ "{{ issue.identifier }}"
    end

    test "omits empty sections" do
      config = %{"tracker" => %{"kind" => "memory"}}
      content = Starter.build_workflow_content(config)

      # Should have tracker but not workspace or agent (no data for them)
      assert content =~ "tracker:"
      refute content =~ "workspace:"
      refute content =~ "agent:"
      refute content =~ "stored_agent:"
    end

    test "emits stored_agent section when Launcher injects agent identity" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "stored_agent" => %{
          "id" => "agent-1",
          "type" => "planning",
          "workspace_id" => "workspace-1",
          "name" => "Builder",
          "project_id" => nil,
          "tool_policy" => %{"planning" => %{"destination" => "database"}}
        }
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "stored_agent:"
      assert content =~ "id: agent-1"
      assert content =~ "type: planning"
      assert content =~ "workspace_id: workspace-1"
      assert content =~ "name: Builder"
      assert content =~ "type: planning"
      assert content =~ "tool_policy:"
      assert content =~ "destination: database"
      refute content =~ "project_id:"
    end

    test "ignores a nil server config instead of raising" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "server" => nil
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "tracker:"
      refute content =~ "server:"
    end

    test "derives codex command from stored agent model settings" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "stored_agent" => %{
          "id" => "agent-1",
          "workspace_id" => "workspace-1",
          "model_settings" => %{"primary" => "openai/gpt-5.2"}
        }
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "codex:"
      assert content =~ "command: codex --model gpt-5.2 app-server"
      assert content =~ "model: gpt-5.2"
      assert content =~ "model_provider: openai"
      refute content =~ "model_settings:"
    end

    test "prefers explicit codex command over derived model command" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "codex" => %{"command" => "codex --model custom-model app-server"},
        "runners" => [%{"kind" => "codex", "model" => "openai/gpt-5.2"}]
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "command: codex --model custom-model app-server"
      refute content =~ "command: codex --model gpt-5.2 app-server"
    end

    test "writes sanitized resolved execution profile metadata" do
      config = %{
        "tracker" => %{"kind" => "memory"},
        "execution_profile" => %{
          "runner_kind" => "codex",
          "provider" => "openai_codex",
          "model" => "gpt-5.2",
          "api_key" => "sk-test",
          "source_metadata" => %{"source" => "routing_rule"}
        }
      }

      content = Starter.build_workflow_content(config)

      assert content =~ "execution_profile:"
      assert content =~ "runner_kind: codex"
      assert content =~ "provider: openai_codex"
      assert content =~ "model: gpt-5.2"
      assert content =~ "api_key: [REDACTED]"
      refute content =~ "sk-test"
    end
  end

  describe "write_temp_workflow/2" do
    test "writes file to temp directory" do
      content = "---\ntracker:\n  kind: memory\n---\ntest prompt\n"
      path = Starter.write_temp_workflow("test_write_123", content)

      assert File.exists?(path)
      assert File.read!(path) == content
      assert path =~ "WORKFLOW_test_write_123.md"

      # Cleanup
      File.rm(path)
    end
  end
end
