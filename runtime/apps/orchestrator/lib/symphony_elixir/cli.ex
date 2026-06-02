defmodule SymphonyElixir.CLI do
  @moduledoc """
  Escript entrypoint for running Symphony with an explicit WORKFLOW.md path.
  """

  alias SymphonyElixir.LogFile

  @acknowledgement_switch :i_understand_that_this_will_be_running_without_the_usual_guardrails
  @switches [
    {@acknowledgement_switch, :boolean},
    logs_root: :string,
    port: :integer,
    dashboard: :boolean,
    repo: :string
  ]
  @launcher_switches [
    port: :integer,
    state_dir: :string,
    workflow: :string
  ]

  @type ensure_started_result :: {:ok, [atom()]} | {:error, term()}
  @type deps :: %{
          file_regular?: (String.t() -> boolean()),
          set_workflow_file_path: (String.t() -> :ok | {:error, term()}),
          set_logs_root: (String.t() -> :ok | {:error, term()}),
          set_server_port_override: (non_neg_integer() | nil -> :ok | {:error, term()}),
          ensure_all_started: (-> ensure_started_result())
        }
  @type launcher_deps :: %{
          file_regular?: (String.t() -> boolean()),
          set_workflow_file_path: (String.t() -> :ok | {:error, term()}),
          ensure_launcher_dependencies: (-> :ok | {:error, term()}),
          ensure_tracker_api_started: (-> :ok | {:error, term()}),
          start_launcher: (keyword() -> {:ok, pid()} | {:error, term()})
        }

  @spec main([String.t()]) :: no_return()
  def main(["cloud-executor" | args]) do
    case SymphonyElixir.CloudExecutor.CLI.evaluate(args) do
      :ok ->
        System.halt(0)

      {:error, message} ->
        IO.puts(:stderr, message)
        System.halt(1)
    end
  end

  def main(["launcher" | args]) do
    case evaluate_launcher(args) do
      :ok ->
        # The escript's `app: nil` config means Logger and other apps are
        # NOT auto-started. `evaluate_launcher/2` calls
        # `ensure_launcher_dependencies/0` which transitively starts
        # Logger (via bandit/phoenix_pubsub/ecto_sql). Emit the inventory
        # AFTER that, so RuntimeLog.log/3 actually reaches the configured
        # backend instead of being silently dropped pre-Logger-startup.
        :ok = SymphonyElixir.Diagnostic.ContainerInventory.emit_startup_log()
        wait_for_shutdown(SymphonyElixir.Launcher.Supervisor)

      {:error, message} ->
        IO.puts(:stderr, message)
        System.halt(1)
    end
  end

  def main(args) do
    case evaluate(args) do
      :ok ->
        # Same ordering rationale as the launcher branch — emit only
        # after `evaluate/2` has called `ensure_all_started/0` so Logger
        # is up. Idempotent via :persistent_term, so the duplicate call
        # from `SymphonyElixir.Application.start/2` (when running as a
        # proper OTP app in dev/test) is a safe no-op.
        :ok = SymphonyElixir.Diagnostic.ContainerInventory.emit_startup_log()
        wait_for_shutdown(SymphonyElixir.Supervisor)

      {:error, message} ->
        IO.puts(:stderr, message)
        System.halt(1)
    end
  end

  @spec evaluate_launcher([String.t()], launcher_deps()) :: :ok | {:error, String.t()}
  def evaluate_launcher(args, deps \\ launcher_runtime_deps()) do
    case OptionParser.parse(args, strict: @launcher_switches) do
      {opts, [], []} ->
        start_launcher(opts, deps)

      _ ->
        {:error, launcher_usage_message()}
    end
  end

  @spec evaluate([String.t()], deps()) :: :ok | {:error, String.t()}
  def evaluate(args, deps \\ runtime_deps()) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        with :ok <- require_guardrails_acknowledgement(opts),
             :ok <- maybe_set_logs_root(opts, deps),
             :ok <- maybe_set_server_port(opts, deps),
             :ok <- maybe_set_dashboard_enabled(opts),
             :ok <- maybe_set_repo(opts) do
          run(Path.expand("WORKFLOW.md"), deps)
        end

      {opts, [workflow_path], []} ->
        with :ok <- require_guardrails_acknowledgement(opts),
             :ok <- maybe_set_logs_root(opts, deps),
             :ok <- maybe_set_server_port(opts, deps),
             :ok <- maybe_set_dashboard_enabled(opts),
             :ok <- maybe_set_repo(opts) do
          run(workflow_path, deps)
        end

      _ ->
        {:error, usage_message()}
    end
  end

  @spec run(String.t(), deps()) :: :ok | {:error, String.t()}
  def run(workflow_path, deps) do
    expanded_path = Path.expand(workflow_path)

    if deps.file_regular?.(expanded_path) do
      :ok = deps.set_workflow_file_path.(expanded_path)

      case deps.ensure_all_started.() do
        {:ok, _started_apps} ->
          :ok

        {:error, reason} ->
          {:error, "Failed to start Symphony with workflow #{expanded_path}: #{inspect(reason)}"}
      end
    else
      {:error, "Workflow file not found: #{expanded_path}"}
    end
  end

  @spec usage_message() :: String.t()
  defp usage_message do
    "Usage: symphony [--logs-root <path>] [--port <port>] [--no-dashboard] [--repo <url-or-path>] [path-to-WORKFLOW.md]"
  end

  @spec launcher_usage_message() :: String.t()
  defp launcher_usage_message do
    "Usage: symphony launcher [--port <port>] [--state-dir <path>] [--workflow <path-to-WORKFLOW.md>]"
  end

  @spec runtime_deps() :: deps()
  defp runtime_deps do
    %{
      file_regular?: &File.regular?/1,
      set_workflow_file_path: &SymphonyElixir.Workflow.set_workflow_file_path/1,
      set_logs_root: &set_logs_root/1,
      set_server_port_override: &set_server_port_override/1,
      ensure_all_started: fn -> Application.ensure_all_started(:symphony_elixir) end
    }
  end

  @spec launcher_runtime_deps() :: launcher_deps()
  defp launcher_runtime_deps do
    %{
      file_regular?: &File.regular?/1,
      set_workflow_file_path: &SymphonyElixir.Workflow.set_workflow_file_path/1,
      ensure_launcher_dependencies: &ensure_launcher_dependencies/0,
      ensure_tracker_api_started: &ensure_tracker_api_started/0,
      start_launcher: &SymphonyElixir.Launcher.Supervisor.start_link/1
    }
  end

  defp start_launcher(opts, deps) do
    workflow_path = Keyword.get(opts, :workflow, System.get_env("WORKFLOW_PATH") || "WORKFLOW.md")
    expanded_workflow_path = Path.expand(workflow_path)

    with :ok <- ensure_workflow_exists(expanded_workflow_path, deps),
         :ok <- deps.set_workflow_file_path.(expanded_workflow_path),
         :ok <- deps.ensure_launcher_dependencies.(),
         :ok <- deps.ensure_tracker_api_started.(),
         {:ok, _pid} <- deps.start_launcher.(launcher_options(opts)) do
      :ok
    else
      {:error, message} when is_binary(message) ->
        {:error, message}

      {:error, reason} ->
        {:error, "Failed to start Symphony launcher: #{inspect(reason)}"}
    end
  end

  defp ensure_workflow_exists(path, deps) do
    if deps.file_regular?.(path) do
      :ok
    else
      {:error, "Workflow file not found: #{path}"}
    end
  end

  defp launcher_options(opts) do
    []
    |> maybe_put(:port, Keyword.get(opts, :port) || parse_env_int("LAUNCHER_PORT"))
    |> maybe_put(:state_dir, launcher_state_dir(opts))
  end

  defp launcher_state_dir(opts) do
    case Keyword.get(opts, :state_dir) || System.get_env("LAUNCHER_STATE_DIR") do
      value when is_binary(value) and value != "" -> Path.expand(value)
      _ -> nil
    end
  end

  @doc """
  Apps the launcher escript must explicitly start before
  `SymphonyElixir.Launcher.Supervisor.start_link/1` can succeed.

  Mix `run` / `test` modes auto-start every dep transitively, so missing
  entries here only surface in the production escript binary — which is
  why this list lives next to a regression test rather than being kept
  in someone's head.

  Adding a new child to `Launcher.Supervisor` that requires its OTP
  application to be running? Add it to this list.
  """
  @spec launcher_required_apps() :: [atom()]
  def launcher_required_apps, do: [:bandit, :jason, :req, :phoenix_pubsub, :phoenix]

  @doc false
  @spec ensure_launcher_dependencies() :: :ok | {:error, term()}
  def ensure_launcher_dependencies do
    Enum.reduce_while(launcher_required_apps(), :ok, fn app, _acc ->
      case Application.ensure_all_started(app) do
        {:ok, _} -> {:cont, :ok}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp ensure_tracker_api_started do
    case Process.whereis(SymphonyElixir.Tracker.API) do
      pid when is_pid(pid) ->
        :ok

      nil ->
        case SymphonyElixir.Tracker.API.start_link() do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          {:error, _reason} = error -> error
        end
    end
  end

  defp maybe_set_logs_root(opts, deps) do
    case Keyword.get_values(opts, :logs_root) do
      [] ->
        :ok

      values ->
        logs_root = values |> List.last() |> String.trim()

        if logs_root == "" do
          {:error, usage_message()}
        else
          :ok = deps.set_logs_root.(Path.expand(logs_root))
        end
    end
  end

  defp require_guardrails_acknowledgement(opts) do
    if Keyword.get(opts, @acknowledgement_switch, false) do
      :ok
    else
      {:error, acknowledgement_banner()}
    end
  end

  @spec acknowledgement_banner() :: String.t()
  defp acknowledgement_banner do
    lines = [
      "This Symphony implementation is a low key engineering preview.",
      "Codex will run without any guardrails.",
      "SymphonyElixir is not a supported product and is presented as-is.",
      "To proceed, start with `--i-understand-that-this-will-be-running-without-the-usual-guardrails` CLI argument"
    ]

    width = Enum.max(Enum.map(lines, &String.length/1))
    border = String.duplicate("─", width + 2)
    top = "╭" <> border <> "╮"
    bottom = "╰" <> border <> "╯"
    spacer = "│ " <> String.duplicate(" ", width) <> " │"

    content =
      [
        top,
        spacer
        | Enum.map(lines, fn line ->
            "│ " <> String.pad_trailing(line, width) <> " │"
          end)
      ] ++ [spacer, bottom]

    [
      IO.ANSI.red(),
      IO.ANSI.bright(),
      Enum.join(content, "\n"),
      IO.ANSI.reset()
    ]
    |> IO.iodata_to_binary()
  end

  defp set_logs_root(logs_root) do
    Application.put_env(:symphony_elixir, :log_file, LogFile.default_log_file(logs_root))
    :ok
  end

  defp maybe_set_server_port(opts, deps) do
    case Keyword.get_values(opts, :port) do
      [] ->
        :ok

      values ->
        port = List.last(values)

        if is_integer(port) and port >= 0 do
          :ok = deps.set_server_port_override.(port)
        else
          {:error, usage_message()}
        end
    end
  end

  defp set_server_port_override(port) when is_integer(port) and port >= 0 do
    Application.put_env(:symphony_elixir, :server_port_override, port)
    :ok
  end

  defp maybe_set_dashboard_enabled(opts) do
    case Keyword.get(opts, :dashboard, true) do
      true -> :ok
      false -> :ok = set_dashboard_enabled(false)
      _ -> :ok
    end
  end

  defp set_dashboard_enabled(enabled) when is_boolean(enabled) do
    Application.put_env(:symphony_elixir, :dashboard_enabled_override, enabled)
    :ok
  end

  defp maybe_set_repo(opts) do
    case Keyword.get(opts, :repo) do
      nil ->
        :ok

      repo when is_binary(repo) ->
        repo = String.trim(repo)

        if repo == "" do
          {:error, usage_message()}
        else
          Application.put_env(:symphony_elixir, :repo_override, repo)
          :ok
        end
    end
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, val), do: Keyword.put(opts, key, val)

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

  @spec wait_for_shutdown(module()) :: no_return()
  defp wait_for_shutdown(supervisor) do
    case Process.whereis(supervisor) do
      nil ->
        IO.puts(:stderr, "#{inspect(supervisor)} is not running")
        System.halt(1)

      pid ->
        ref = Process.monitor(pid)

        receive do
          {:DOWN, ^ref, :process, ^pid, reason} ->
            case reason do
              :normal -> System.halt(0)
              _ -> System.halt(1)
            end
        end
    end
  end
end
