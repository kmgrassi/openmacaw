defmodule Mix.Tasks.Launcher.Start do
  @moduledoc """
  Starts the Symphony Launcher service.

  The Launcher manages multiple orchestrator instances, each on its own port.
  Orchestrators are created and destroyed via the Launcher's HTTP API.

  ## Usage

      mix launcher.start [--port PORT] [--state-dir DIR] [--start-port PORT] [--workflow PATH]

  ## Options

  - `--port` — Port for the Launcher HTTP API (default: 4100, env: LAUNCHER_PORT)
  - `--state-dir` — Directory for persisting orchestrator state
    (default: ~/.symphony/launcher, env: LAUNCHER_STATE_DIR)
  - `--start-port` — First port for launched agent orchestrators
    (default: 4000, env: LAUNCHER_START_PORT)
  - `--workflow` — Workflow file used by launcher-owned services
    (default: WORKFLOW.md, env: WORKFLOW_PATH)

  ## Environment variables

  - `LAUNCHER_PORT` — Same as `--port`
  - `LAUNCHER_STATE_DIR` — Same as `--state-dir`
  - `LAUNCHER_START_PORT` — Same as `--start-port`
  - `WORKFLOW_PATH` — Same as `--workflow`
  - `LAUNCHER_BIND_HOST` — Bind host for the Launcher HTTP API
    (default: 127.0.0.1; set to 0.0.0.0 only behind a private listener)
  """

  use Mix.Task

  @switches [port: :integer, state_dir: :string, start_port: :integer, workflow: :string]

  @impl true
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)

    # Apply env vars (CLI flags take precedence)
    state_dir =
      Keyword.get(opts, :state_dir) ||
        System.get_env("LAUNCHER_STATE_DIR")

    port =
      Keyword.get(opts, :port) ||
        parse_env_int("LAUNCHER_PORT")

    start_port =
      Keyword.get(opts, :start_port) ||
        parse_env_int("LAUNCHER_START_PORT")

    workflow_path =
      Keyword.get(opts, :workflow) ||
        System.get_env("WORKFLOW_PATH") ||
        "WORKFLOW.md"

    expanded_workflow_path = Path.expand(workflow_path)

    unless File.regular?(expanded_workflow_path) do
      Mix.raise("Workflow file not found: #{expanded_workflow_path}")
    end

    sup_opts =
      []
      |> maybe_put(:port, port)
      |> maybe_put(:state_dir, state_dir && Path.expand(state_dir))
      |> maybe_put(:start_port, start_port)

    # Start dependencies. Use the single source of truth in
    # `SymphonyElixir.CLI.launcher_required_apps/0` rather than a parallel
    # hardcoded list here, so the two can't drift (a stale entry pointing at
    # a removed dependency would crash boot).
    Mix.Task.run("app.config")
    :ok = SymphonyElixir.Workflow.set_workflow_file_path(expanded_workflow_path)
    :ok = SymphonyElixir.CLI.ensure_launcher_dependencies()
    ensure_tracker_api_started()

    # Start the Launcher supervision tree
    {:ok, _pid} = SymphonyElixir.Launcher.Supervisor.start_link(sup_opts)

    effective_port = Keyword.get(sup_opts, :port, 4100)
    Mix.shell().info("Launcher started on port #{effective_port}")
    Mix.shell().info("API: http://localhost:#{effective_port}/health")

    # Block until interrupted
    Process.sleep(:infinity)
  end

  defp parse_env_int(var) do
    case System.get_env(var) do
      nil ->
        nil

      val ->
        case Integer.parse(val) do
          {n, ""} -> n
          _ -> nil
        end
    end
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, val), do: Keyword.put(opts, key, val)

  defp ensure_tracker_api_started do
    case Process.whereis(SymphonyElixir.Tracker.API) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        SymphonyElixir.Tracker.API.start_link()
    end
  end
end
