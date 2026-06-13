defmodule SymphonyElixir.Launcher.RuntimeProxy do
  @moduledoc """
  Launcher-owned front door for agent-scoped runtime APIs.

  This keeps the platform on a stable launcher URL while the orchestrator
  process remains an in-VM worker identified by `agent_id`.
  """

  alias Plug.Conn
  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Gateway.{SessionStore, SharedSessionKey}
  alias SymphonyElixir.Launcher.{ConfigRegistry, Server}
  alias SymphonyElixir.LocalRuntime.Diagnostics, as: LocalRuntimeDiagnostics
  alias SymphonyElixir.MessageLog
  alias SymphonyElixir.Time
  alias SymphonyElixirWeb.Presenter

  @snapshot_timeout_ms 15_000

  @type runtime_context :: %{
          agent: map(),
          orchestrator: map(),
          workflow_path: String.t()
        }

  @spec health_payload(String.t()) :: {:ok, map()} | {:error, :not_found | :runtime_unavailable}
  def health_payload(agent_id) when is_binary(agent_id) do
    with {:ok, context} <- runtime_context(agent_id) do
      {:ok, Presenter.health_payload(context.orchestrator.pid, @snapshot_timeout_ms)}
    end
  end

  @spec diagnostic_payload(String.t()) :: {:ok, map()} | {:error, :not_found | term()}
  def diagnostic_payload(agent_id) when is_binary(agent_id) do
    with {:ok, %Agent{} = agent} <- AgentInventory.get_agent(agent_id) do
      runtime = runtime_diagnostic(agent)
      local_runtime = local_runtime_diagnostic(agent, runtime)
      blockers = diagnostic_blockers(agent, runtime, local_runtime)

      {:ok,
       %{
         generated_at: Time.now_iso8601(truncate: :second),
         ok: blockers == [],
         status: if(blockers == [], do: "healthy", else: "degraded"),
         agent: agent_diagnostic(agent),
         launcher: launcher_diagnostic(),
         runtime: runtime,
         local_runtime: local_runtime,
         blockers: blockers
       }}
    end
  end

  @spec state_payload(String.t()) :: {:ok, map()} | {:error, :not_found | :runtime_unavailable}
  def state_payload(agent_id) when is_binary(agent_id) do
    with {:ok, context} <- runtime_context(agent_id) do
      {:ok,
       with_runtime_workflow(context.workflow_path, fn ->
         Presenter.state_payload(context.orchestrator.pid, @snapshot_timeout_ms)
       end)}
    end
  end

  @spec refresh_payload(String.t()) :: {:ok, map()} | {:error, :not_found | :runtime_unavailable}
  def refresh_payload(agent_id) when is_binary(agent_id) do
    with {:ok, context} <- runtime_context(agent_id) do
      case Presenter.refresh_payload(context.orchestrator.pid) do
        {:error, :unavailable} -> {:error, :runtime_unavailable}
        result -> result
      end
    end
  end

  @spec messages_payload(String.t(), keyword() | String.t() | nil) ::
          {:ok, map()} | {:error, :not_found | :runtime_unavailable}
  def messages_payload(agent_id, opts \\ [])

  def messages_payload(agent_id, session_key)
      when is_binary(session_key) or is_nil(session_key) do
    messages_payload(agent_id, session_key: session_key)
  end

  def messages_payload(agent_id, opts) when is_binary(agent_id) and is_list(opts) do
    with {:ok, context} <- runtime_context(agent_id) do
      session_key = Keyword.get(opts, :session_key)

      case message_log().list_agent_messages(context.agent.id,
             workspace_id: agent_field(context.agent, :workspace_id),
             limit: Keyword.get(opts, :limit),
             before: Keyword.get(opts, :before),
             before_id: Keyword.get(opts, :before_id)
           ) do
        {:ok, messages, pagination} ->
          {:ok, %{messages: messages, pagination: pagination}}

        :disabled ->
          {:ok, fallback_messages_payload(context.agent, session_key)}

        {:error, _reason} ->
          {:ok, fallback_messages_payload(context.agent, session_key)}
      end
    end
  end

  @spec websocket_state(String.t(), Conn.t()) ::
          {:ok, map()} | {:error, :not_found | :runtime_unavailable}
  def websocket_state(agent_id, %Conn{} = conn) when is_binary(agent_id) do
    with {:ok, context} <- runtime_context(agent_id) do
      query_params =
        conn.query_params
        |> Map.put("agent_id", agent_id)
        |> Map.put("workspace_id", context.agent.workspace_id)

      {:ok,
       %{
         query_params: query_params,
         request_headers: Map.new(conn.req_headers),
         peer_data: conn.remote_ip,
         workflow_path: context.workflow_path
       }}
    end
  end

  @spec runtime_context(String.t()) ::
          {:ok, runtime_context()} | {:error, :not_found | :runtime_unavailable}
  def runtime_context(agent_id) when is_binary(agent_id) do
    with {:ok, agent} <- AgentInventory.get_agent(agent_id),
         {:ok, orchestrator} <- Server.get_agent_runtime(agent_id),
         true <- is_pid(orchestrator.pid) and Process.alive?(orchestrator.pid),
         {:ok, workflow_path} <- ConfigRegistry.get(orchestrator.pid) do
      {:ok, %{agent: agent, orchestrator: orchestrator, workflow_path: workflow_path}}
    else
      {:error, :not_found} ->
        {:error, :not_found}

      false ->
        {:error, :runtime_unavailable}

      :error ->
        {:error, :runtime_unavailable}

      {:error, _reason} ->
        {:error, :runtime_unavailable}
    end
  end

  defp resolve_session_key(agent, _session_key) do
    SharedSessionKey.for_agent(agent_field(agent, :workspace_id), agent.id)
  end

  defp fallback_messages_payload(agent, session_key) do
    resolved_session_key = resolve_session_key(agent, session_key)
    %{messages: SessionStore.get_messages(resolved_session_key)}
  end

  defp with_runtime_workflow(workflow_path, fun)
       when is_binary(workflow_path) and is_function(fun, 0) do
    caller = self()
    previous = ConfigRegistry.get(caller)

    ConfigRegistry.put(caller, workflow_path)

    try do
      fun.()
    after
      restore_workflow(caller, previous)
    end
  end

  defp restore_workflow(caller, {:ok, previous_path}),
    do: ConfigRegistry.put(caller, previous_path)

  defp restore_workflow(caller, :error), do: ConfigRegistry.delete(caller)

  defp message_log do
    Application.get_env(:symphony_elixir, :message_log_adapter, MessageLog)
  end

  defp agent_field(agent, field) when is_map(agent) do
    Map.get(agent, field) || Map.get(agent, Atom.to_string(field))
  end

  defp runtime_diagnostic(%Agent{} = agent) do
    case Server.get_agent_runtime(agent.id) do
      {:ok, orchestrator} ->
        profile = execution_profile(orchestrator)
        health = Presenter.health_payload(orchestrator.pid, @snapshot_timeout_ms)

        %{
          status: "running",
          ok: Process.alive?(orchestrator.pid) and Map.get(health, :ok) == true,
          orchestrator_id: Map.get(orchestrator, :id),
          port: Map.get(orchestrator, :port),
          started_at: format_datetime(Map.get(orchestrator, :started_at)),
          restart_count: Map.get(orchestrator, :restart_count),
          execution_profile: profile,
          health: health
        }

      {:error, :not_found} ->
        %{
          status: "not_running",
          ok: false,
          reason: "runtime_unavailable"
        }
    end
  end

  defp local_runtime_diagnostic(%Agent{} = agent, %{execution_profile: profile})
       when is_map(profile) do
    runner_kind = Map.get(profile, "runner_kind")

    if local_runtime_profile?(profile) do
      params =
        %{
          "workspace_id" => agent.workspace_id,
          "target_runner_kind" => local_runtime_target_runner_kind(profile),
          "model" => Map.get(profile, "model")
        }
        |> Enum.reject(fn {_key, value} -> value in [nil, ""] end)
        |> Map.new()

      LocalRuntimeDiagnostics.health_payload(params)
    else
      %{
        ok: true,
        status: "skipped",
        reason: "runner_kind_not_local",
        runner_kind: runner_kind
      }
    end
  end

  defp local_runtime_diagnostic(_agent, _runtime) do
    %{
      ok: true,
      status: "skipped",
      reason: "runtime_not_running"
    }
  end

  defp agent_diagnostic(%Agent{} = agent) do
    %{
      id: agent.id,
      workspace_id: agent.workspace_id,
      project_id: agent.project_id,
      type: Agent.kind(agent),
      status: agent.status,
      is_active: agent.is_active,
      has_credentials: agent.has_credentials
    }
  end

  defp launcher_diagnostic do
    %{
      ok: true,
      status: "reachable",
      lifecycle: Server.health_summary()
    }
  end

  defp diagnostic_blockers(agent, runtime, local_runtime) do
    []
    |> maybe_add_blocker(inactive_agent?(agent), %{
      code: "agent_inactive",
      layer: "agent_config",
      message: "Agent is inactive"
    })
    |> maybe_add_blocker(runtime.ok != true, %{
      code: Map.get(runtime, :reason, "runtime_unhealthy"),
      layer: "runtime",
      message: "Runtime is not healthy"
    })
    |> maybe_add_blocker(local_runtime.ok != true, %{
      code: Map.get(local_runtime, :reason, "local_runtime_unhealthy"),
      layer: "local_runtime",
      message: "Local runtime is not ready for this agent"
    })
    |> Enum.reverse()
  end

  defp maybe_add_blocker(blockers, true, blocker), do: [blocker | blockers]
  defp maybe_add_blocker(blockers, _condition, _blocker), do: blockers

  defp inactive_agent?(%Agent{is_active: false}), do: true
  defp inactive_agent?(_agent), do: false

  defp execution_profile(orchestrator) do
    config = Map.get(orchestrator, :config, %{})

    case ExecutionProfile.normalize_from_config(config) do
      {:ok, profile} -> ExecutionProfile.sanitize(profile)
      {:error, reason} -> %{"error" => inspect(reason)}
    end
  end

  defp local_runtime_profile?(%{"runner_kind" => runner_kind}) do
    runner_kind in ["local_relay", "local_model_coding"]
  end

  defp local_runtime_profile?(_profile), do: false

  defp local_runtime_target_runner_kind(%{"runner_kind" => "local_model_coding"}),
    do: "local_model_coding"

  defp local_runtime_target_runner_kind(%{"runner_kind" => "local_relay"} = profile) do
    Map.get(profile, "target_runner_kind") ||
      case Map.get(profile, "provider") do
        provider when provider in ~w(openai_compatible openclaw codex computer_use) -> provider
        _ -> "openai_compatible"
      end
  end

  defp local_runtime_target_runner_kind(profile) do
    Map.get(profile, "target_runner_kind") || Map.get(profile, "provider") ||
      Map.get(profile, "runner_kind")
  end

  defp format_datetime(value), do: Time.to_iso8601(value) || value
end
