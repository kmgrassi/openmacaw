defmodule SymphonyElixir.Diagnostic.AgentProbeTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.Diagnostic.AgentProbe

  defmodule ProfileResolver do
    def resolve(agent_id, workspace_id) do
      send(owner(), {:profile_resolve, agent_id, workspace_id})
      Application.fetch_env!(:symphony_elixir, :agent_probe_test_profile_response)
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :agent_probe_test_owner)
  end

  defmodule RunnerResolver do
    def runner_module(profile) do
      send(owner(), {:runner_resolve, profile})
      Application.fetch_env!(:symphony_elixir, :agent_probe_test_runner_response)
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :agent_probe_test_owner)
  end

  defmodule ProbeRunner do
    @behaviour SymphonyElixir.Runner

    def start_session(config, workspace) do
      send(owner(), {:start_session, config, workspace})

      Application.get_env(
        :symphony_elixir,
        :agent_probe_test_start_response,
        {:ok, %{session_id: "probe-session"}}
      )
    end

    def run_turn(_session, _prompt, _work_item) do
      send(owner(), :run_turn_called)
      {:error, :unexpected_run_turn}
    end

    def stop_session(session) do
      send(owner(), {:stop_session, session})
      Application.get_env(:symphony_elixir, :agent_probe_test_stop_response, :ok)
    end

    def ping(_config), do: :ok

    def requires_workspace?,
      do: Application.get_env(:symphony_elixir, :agent_probe_test_requires_workspace, false)

    defp owner, do: Application.fetch_env!(:symphony_elixir, :agent_probe_test_owner)
  end

  setup do
    put_app_env(:symphony_elixir, :agent_probe_test_owner, self())
    put_app_env(:symphony_elixir, :agent_probe_test_runner_response, {:ok, ProbeRunner})
    put_app_env(:symphony_elixir, :agent_probe_test_requires_workspace, false)

    :ok
  end

  test "returns ready after a probe-only start and cleanup without running a turn" do
    put_app_env(:symphony_elixir, :agent_probe_test_profile_response, {:ok, ready_profile()})

    assert AgentProbe.probe("workspace-1", "agent-1",
             profile_resolver: ProfileResolver,
             runner_resolver: RunnerResolver
           ) == {:ok, :ready}

    assert_received {:profile_resolve, "agent-1", "workspace-1"}
    assert_received {:runner_resolve, %{"runner_kind" => "local_model_coding"}}
    assert_received {:start_session, config, nil}
    assert config["probe_only"] == true
    assert config[:probe_only] == true
    assert config["api_key"] == "sk-test"
    assert_received {:stop_session, %{session_id: "probe-session"}}
    refute_received :run_turn_called
  end

  test "maps missing gateway config to gateway_config_missing" do
    put_app_env(:symphony_elixir, :agent_probe_test_profile_response, {:error, :not_found})

    assert {:error, :gateway_config_missing, details} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )

    assert details == %{agent_id: "agent-1", workspace_id: "workspace-1"}
  end

  test "maps resolver credential errors to credential_missing" do
    put_app_env(
      :symphony_elixir,
      :agent_probe_test_profile_response,
      {:error, :credential_missing}
    )

    assert {:error, :credential_missing, %{agent_id: "agent-1", workspace_id: "workspace-1"}} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )
  end

  test "maps unsupported runner resolution to execution_profile_unresolved" do
    put_app_env(
      :symphony_elixir,
      :agent_probe_test_profile_response,
      {:ok, ready_profile(%{runner_kind: "unknown"})}
    )

    put_app_env(
      :symphony_elixir,
      :agent_probe_test_runner_response,
      {:error, {:unsupported_runner_kind, "unknown"}}
    )

    assert {:error, :execution_profile_unresolved, details} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )

    assert details.reason == ~s({:unsupported_runner_kind, "unknown"})
    assert details.profile["runner_kind"] == "unknown"
    assert details.profile["api_key"] == "[REDACTED]"
  end

  test "returns credential_missing when a non-optional provider has no resolved secret" do
    put_app_env(
      :symphony_elixir,
      :agent_probe_test_profile_response,
      {:ok, Map.delete(ready_profile(), :api_key)}
    )

    assert {:error, :credential_missing, details} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )

    assert details.profile["provider"] == "openai"
  end

  test "attaches binary inventory to runner spawn failures" do
    put_app_env(
      :symphony_elixir,
      :agent_probe_test_profile_response,
      {:ok, ready_profile(%{runner_kind: "codex"})}
    )

    put_app_env(:symphony_elixir, :agent_probe_test_start_response, {:error, :codex_not_found})

    assert {:error, :runner_spawn_failed, details} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )

    assert details.binary == "codex"
    assert details.container_inventory |> Map.keys() |> Enum.sort() == ["bash", "codex"]
    assert details.reason == ":codex_not_found"
  end

  test "cleanup failures are returned as informational cleanup_failed" do
    put_app_env(:symphony_elixir, :agent_probe_test_profile_response, {:ok, ready_profile()})
    put_app_env(:symphony_elixir, :agent_probe_test_stop_response, {:error, :already_stopped})

    assert {:error, :cleanup_failed, %{reason: ":already_stopped"}} =
             AgentProbe.probe("workspace-1", "agent-1",
               profile_resolver: ProfileResolver,
               runner_resolver: RunnerResolver
             )
  end

  test "removes probe workspaces after a successful probe run" do
    root = Path.join(System.tmp_dir!(), "agent-probe-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    put_app_env(:symphony_elixir, :agent_probe_test_requires_workspace, true)
    put_app_env(:symphony_elixir, :agent_probe_test_profile_response, {:ok, ready_profile()})

    assert AgentProbe.probe("workspace-1", "agent-1",
             profile_resolver: ProfileResolver,
             runner_resolver: RunnerResolver,
             workspace_root: root
           ) == {:ok, :ready}

    assert File.ls!(root) == []
  end

  defp ready_profile(overrides \\ %{}) do
    Map.merge(
      %{
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        runner_kind: "local_model_coding",
        provider: "openai",
        model: "gpt-test",
        api_key: "sk-test",
        credential_id: "cred-1"
      },
      overrides
    )
  end
end
