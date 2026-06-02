defmodule SymphonyElixir.Runner.AgentConfigTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.Runner.AgentConfig
  alias SymphonyElixir.Runner.LocalModelCoding
  alias SymphonyElixir.Runner.Planner

  defmodule TestGatewayConfig do
    @behaviour SymphonyElixir.Launcher.GatewayConfig

    def fetch("workspace", workspace_id) do
      case Application.get_env(:symphony_elixir, :runner_agent_config_test_config) do
        nil ->
          {:error, :not_found}

        config_json ->
          {:ok,
           %Resolved{
             scope_type: "workspace",
             scope_id: workspace_id,
             config_json: config_json,
             config_hash: "hash",
             version: 1
           }}
      end
    end

    def fetch(_scope_type, _scope_id), do: {:error, :not_found}
    def record_apply_state(_scope_type, _scope_id, _status, _opts), do: :ok
  end

  setup do
    Application.put_env(:symphony_elixir, :launcher_gateway_config_adapter, TestGatewayConfig)
    Application.delete_env(:symphony_elixir, :runner_agent_config_test_config)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_adapter)
      Application.delete_env(:symphony_elixir, :runner_agent_config_test_config)
    end)

    :ok
  end

  describe "AgentConfig.lookup/5" do
    test "per-agent value wins over workspace value" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{
          "planner" => %{
            "min_cadence_ms" => 60_000,
            "agent-1" => %{"min_cadence_ms" => 5_000}
          }
        }
      })

      assert AgentConfig.lookup("planner", "workspace-1", "agent-1", "min_cadence_ms") == 5_000
    end

    test "falls back to workspace value when no per-agent override" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"min_cadence_ms" => 30_000}}
      })

      assert AgentConfig.lookup("planner", "workspace-1", "agent-without-override", "min_cadence_ms") ==
               30_000
    end

    test "falls back to workspace value when agent_id is nil" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"min_cadence_ms" => 30_000}}
      })

      assert AgentConfig.lookup("planner", "workspace-1", nil, "min_cadence_ms") == 30_000
    end

    test "falls back to workspace value when agent_id is empty string" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"min_cadence_ms" => 30_000}}
      })

      assert AgentConfig.lookup("planner", "workspace-1", "", "min_cadence_ms") == 30_000
    end

    test "returns default when no override is configured" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{}}
      })

      assert AgentConfig.lookup("planner", "workspace-1", "agent-1", "missing_key", :fallback) ==
               :fallback
    end

    test "returns default when gateway config fetch fails" do
      assert AgentConfig.lookup("planner", "workspace-missing", "agent-1", "key", :fallback) ==
               :fallback
    end

    test "returns nil when no default is provided and no value is set" do
      assert AgentConfig.lookup("planner", "workspace-missing", "agent-1", "key") == nil
    end

    test "scopes by runner kind so planner and coding configs do not collide" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{
          "planner" => %{"min_cadence_ms" => 1_111},
          "local_model_coding" => %{"min_cadence_ms" => 2_222}
        }
      })

      assert AgentConfig.lookup("planner", "workspace-1", "agent-1", "min_cadence_ms") == 1_111

      assert AgentConfig.lookup("local_model_coding", "workspace-1", "agent-1", "min_cadence_ms") ==
               2_222
    end

    test "ignores per-agent override for a different agent_id" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{
          "planner" => %{
            "min_cadence_ms" => 60_000,
            "agent-1" => %{"min_cadence_ms" => 5_000}
          }
        }
      })

      assert AgentConfig.lookup("planner", "workspace-1", "agent-2", "min_cadence_ms") == 60_000
    end

    test "accepts atom keys and stringifies them for lookup" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"min_cadence_ms" => 12_345}}
      })

      assert AgentConfig.lookup("planner", "workspace-1", nil, :min_cadence_ms) == 12_345
    end
  end

  describe "Planner.agent_config/4" do
    test "reads runners.planner.<agent_id>.<key> first" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{
          "planner" => %{
            "timeout_ms" => 60_000,
            "agent-1" => %{"timeout_ms" => 9_000}
          }
        }
      })

      assert Planner.agent_config("workspace-1", "agent-1", "timeout_ms") == 9_000
    end

    test "falls back to runners.planner.<key>" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"timeout_ms" => 60_000}}
      })

      assert Planner.agent_config("workspace-1", "agent-1", "timeout_ms") == 60_000
    end

    test "falls back to default when neither is set" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{}}
      })

      assert Planner.agent_config("workspace-1", "agent-1", "timeout_ms", 7_500) == 7_500
    end

    test "does not read coding-runner config" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"local_model_coding" => %{"timeout_ms" => 99_999}}
      })

      assert Planner.agent_config("workspace-1", "agent-1", "timeout_ms", :default) == :default
    end
  end

  describe "LocalModelCoding.agent_config/4" do
    test "reads runners.local_model_coding.<agent_id>.<key> first" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{
          "local_model_coding" => %{
            "max_iterations" => 10,
            "agent-1" => %{"max_iterations" => 25}
          }
        }
      })

      assert LocalModelCoding.agent_config("workspace-1", "agent-1", "max_iterations") == 25
    end

    test "falls back to runners.local_model_coding.<key>" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"local_model_coding" => %{"max_iterations" => 10}}
      })

      assert LocalModelCoding.agent_config("workspace-1", "agent-without-override", "max_iterations") ==
               10
    end

    test "falls back to default when neither is set" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"local_model_coding" => %{}}
      })

      assert LocalModelCoding.agent_config("workspace-1", "agent-1", "max_iterations", 8) == 8
    end

    test "does not read planner-runner config" do
      Application.put_env(:symphony_elixir, :runner_agent_config_test_config, %{
        "runners" => %{"planner" => %{"max_iterations" => 99}}
      })

      assert LocalModelCoding.agent_config("workspace-1", "agent-1", "max_iterations", :default) ==
               :default
    end
  end
end
