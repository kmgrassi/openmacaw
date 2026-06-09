defmodule SymphonyElixir.Runner.Codex do
  @moduledoc """
  Runner adapter for OpenAI Codex app-server.

  Executes work items by spawning a Codex subprocess in a workspace directory
  and communicating via JSON-RPC over stdin/stdout.

  Delegates to `SymphonyElixir.Codex.AppServer` for the actual protocol handling.

  ## Configuration

      runner:
        type: codex
        command: "codex --config ... app-server"
        approval_policy: never
        thread_sandbox: workspace-write

  ## Workspace requirement

  Codex requires a workspace directory with the repository cloned into it.
  `requires_workspace?/0` returns `true`.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.Runner.WorkerBridgeRouting

  @impl true
  def start_session(config, workspace) do
    cond do
      probe_only?(config) ->
        with :ok <- ping(config) do
          {:ok, %{probe_only: true, runner: "codex"}}
        end

      WorkerBridgeRouting.container_target?(config) ->
        WorkerBridgeRouting.start_session("codex", config, workspace)

      true ->
        opts = session_opts(config)
        AppServer.start_session(workspace, opts)
    end
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    if Map.get(session, :worker_bridge) do
      WorkerBridgeRouting.run_turn(session, "codex")
    else
      opts = turn_opts(session)
      AppServer.run_turn(session, prompt, work_item, opts)
    end
  end

  @impl true
  def stop_session(%{probe_only: true}), do: :ok
  def stop_session(%{worker_bridge: true} = session), do: WorkerBridgeRouting.stop_session(session)

  def stop_session(session) do
    AppServer.stop_session(session)
  end

  @impl true
  def ping(_config) do
    case System.find_executable("codex") do
      nil -> {:error, :codex_not_found}
      _path -> :ok
    end
  end

  @impl true
  def requires_workspace?, do: true

  defp session_opts(config) do
    opts = []
    opts = if config[:worker_host], do: Keyword.put(opts, :worker_host, config[:worker_host]), else: opts
    opts = if config[:trace_id], do: Keyword.put(opts, :trace_id, config[:trace_id]), else: opts
    Keyword.put(opts, :runner_config, config)
  end

  defp turn_opts(session) do
    opts = []
    opts = if session[:on_message], do: Keyword.put(opts, :on_message, session[:on_message]), else: opts
    opts = if session[:trace_id], do: Keyword.put(opts, :trace_id, session[:trace_id]), else: opts
    opts
  end

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
