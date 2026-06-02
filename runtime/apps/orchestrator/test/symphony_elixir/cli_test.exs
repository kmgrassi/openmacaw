defmodule SymphonyElixir.CLITest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.CLI

  @ack_flag "--i-understand-that-this-will-be-running-without-the-usual-guardrails"

  test "returns the guardrails acknowledgement banner when the flag is missing" do
    parent = self()

    deps = %{
      file_regular?: fn _path ->
        send(parent, :file_checked)
        true
      end,
      set_workflow_file_path: fn _path ->
        send(parent, :workflow_set)
        :ok
      end,
      set_logs_root: fn _path ->
        send(parent, :logs_root_set)
        :ok
      end,
      set_server_port_override: fn _port ->
        send(parent, :port_set)
        :ok
      end,
      ensure_all_started: fn ->
        send(parent, :started)
        {:ok, [:symphony_elixir]}
      end
    }

    assert {:error, banner} = CLI.evaluate(["WORKFLOW.md"], deps)
    assert banner =~ "This Symphony implementation is a low key engineering preview."
    assert banner =~ "Codex will run without any guardrails."
    assert banner =~ "SymphonyElixir is not a supported product and is presented as-is."
    assert banner =~ @ack_flag
    refute_received :file_checked
    refute_received :workflow_set
    refute_received :logs_root_set
    refute_received :port_set
    refute_received :started
  end

  test "defaults to WORKFLOW.md when workflow path is missing" do
    deps = %{
      file_regular?: fn path -> Path.basename(path) == "WORKFLOW.md" end,
      set_workflow_file_path: fn _path -> :ok end,
      set_logs_root: fn _path -> :ok end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:ok, [:symphony_elixir]} end
    }

    assert :ok = CLI.evaluate([@ack_flag], deps)
  end

  test "uses an explicit workflow path override when provided" do
    parent = self()
    workflow_path = "tmp/custom/WORKFLOW.md"
    expanded_path = Path.expand(workflow_path)

    deps = %{
      file_regular?: fn path ->
        send(parent, {:workflow_checked, path})
        path == expanded_path
      end,
      set_workflow_file_path: fn path ->
        send(parent, {:workflow_set, path})
        :ok
      end,
      set_logs_root: fn _path -> :ok end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:ok, [:symphony_elixir]} end
    }

    assert :ok = CLI.evaluate([@ack_flag, workflow_path], deps)
    assert_received {:workflow_checked, ^expanded_path}
    assert_received {:workflow_set, ^expanded_path}
  end

  test "accepts --logs-root and passes an expanded root to runtime deps" do
    parent = self()

    deps = %{
      file_regular?: fn _path -> true end,
      set_workflow_file_path: fn _path -> :ok end,
      set_logs_root: fn path ->
        send(parent, {:logs_root, path})
        :ok
      end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:ok, [:symphony_elixir]} end
    }

    assert :ok = CLI.evaluate([@ack_flag, "--logs-root", "tmp/custom-logs", "WORKFLOW.md"], deps)
    assert_received {:logs_root, expanded_path}
    assert expanded_path == Path.expand("tmp/custom-logs")
  end

  test "returns not found when workflow file does not exist" do
    deps = %{
      file_regular?: fn _path -> false end,
      set_workflow_file_path: fn _path -> :ok end,
      set_logs_root: fn _path -> :ok end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:ok, [:symphony_elixir]} end
    }

    assert {:error, message} = CLI.evaluate([@ack_flag, "WORKFLOW.md"], deps)
    assert message =~ "Workflow file not found:"
  end

  test "returns startup error when app cannot start" do
    deps = %{
      file_regular?: fn _path -> true end,
      set_workflow_file_path: fn _path -> :ok end,
      set_logs_root: fn _path -> :ok end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:error, :boom} end
    }

    assert {:error, message} = CLI.evaluate([@ack_flag, "WORKFLOW.md"], deps)
    assert message =~ "Failed to start Symphony with workflow"
    assert message =~ ":boom"
  end

  test "returns ok when workflow exists and app starts" do
    deps = %{
      file_regular?: fn _path -> true end,
      set_workflow_file_path: fn _path -> :ok end,
      set_logs_root: fn _path -> :ok end,
      set_server_port_override: fn _port -> :ok end,
      ensure_all_started: fn -> {:ok, [:symphony_elixir]} end
    }

    assert :ok = CLI.evaluate([@ack_flag, "WORKFLOW.md"], deps)
  end

  test "launcher mode starts launcher supervisor with explicit options" do
    parent = self()
    workflow_path = "tmp/launcher/WORKFLOW.md"
    expanded_workflow_path = Path.expand(workflow_path)
    state_dir = "tmp/launcher-state"
    expanded_state_dir = Path.expand(state_dir)

    deps = %{
      file_regular?: fn path ->
        send(parent, {:workflow_checked, path})
        path == expanded_workflow_path
      end,
      set_workflow_file_path: fn path ->
        send(parent, {:workflow_set, path})
        :ok
      end,
      ensure_launcher_dependencies: fn ->
        send(parent, :launcher_deps_started)
        :ok
      end,
      ensure_tracker_api_started: fn ->
        send(parent, :tracker_api_started)
        :ok
      end,
      start_launcher: fn opts ->
        send(parent, {:launcher_started, opts})
        {:ok, self()}
      end
    }

    assert :ok =
             CLI.evaluate_launcher(
               ["--port", "4100", "--state-dir", state_dir, "--workflow", workflow_path],
               deps
             )

    assert_received {:workflow_checked, ^expanded_workflow_path}
    assert_received {:workflow_set, ^expanded_workflow_path}
    assert_received :launcher_deps_started
    assert_received :tracker_api_started
    assert_received {:launcher_started, [state_dir: ^expanded_state_dir, port: 4100]}
  end

  test "launcher mode reports missing workflow before starting dependencies" do
    parent = self()

    deps = %{
      file_regular?: fn _path -> false end,
      set_workflow_file_path: fn _path ->
        send(parent, :workflow_set)
        :ok
      end,
      ensure_launcher_dependencies: fn ->
        send(parent, :launcher_deps_started)
        :ok
      end,
      ensure_tracker_api_started: fn ->
        send(parent, :tracker_api_started)
        :ok
      end,
      start_launcher: fn _opts ->
        send(parent, :launcher_started)
        {:ok, self()}
      end
    }

    assert {:error, message} = CLI.evaluate_launcher(["--workflow", "missing.md"], deps)
    assert message =~ "Workflow file not found:"
    refute_received :workflow_set
    refute_received :launcher_deps_started
    refute_received :tracker_api_started
    refute_received :launcher_started
  end

  describe "launcher_required_apps/0" do
    # Regression: in production the launcher runs as an escript with
    # `app: nil`, so only the apps listed by `ensure_launcher_dependencies`
    # are started. `Mix test` auto-starts every dep transitively, which
    # masked a missing `:phoenix_pubsub` entry here once. The bug surfaced
    # in production as a `Phoenix.PubSub.Supervisor` shutdown crash because
    # the registered `Phoenix.PubSub` process did not exist.
    #
    # These tests pin down the contract:
    #   1. The list contains every app any `Launcher.Supervisor` child
    #      requires to be _started_ (not just compiled).
    #   2. `ensure_launcher_dependencies/0` actually starts them all.

    test "lists every app required by Launcher.Supervisor children" do
      required = CLI.launcher_required_apps()

      assert :phoenix_pubsub in required,
             "Phoenix.PubSub child requires the :phoenix_pubsub application"

      assert :bandit in required, "Bandit child requires the :bandit application"

      # `:jason` and `:req` are used by Launcher.Server / WorkerBridge / Router.
      # They were already in the list before the regression but encode
      # the same contract.
      assert :jason in required
      assert :req in required
    end

    test "ensure_launcher_dependencies starts every required app" do
      assert :ok = CLI.ensure_launcher_dependencies()

      started =
        Application.started_applications()
        |> Enum.map(&elem(&1, 0))
        |> MapSet.new()

      for app <- CLI.launcher_required_apps() do
        assert app in started,
               "expected #{inspect(app)} to be running after ensure_launcher_dependencies/0"
      end
    end

    # Boot guard: a stale entry in launcher_required_apps/0 (e.g. an app whose
    # dependency was removed from mix.exs) makes `ensure_all_started/1` return
    # `{:error, {app, {~c"no such file or directory", ~c"<app>.app"}}}`, which
    # crashes launcher boot. Under random test ordering that surfaced as a
    # 300+ test cascade rather than one obvious failure. This asserts every
    # required app resolves to a loadable .app, deterministically and in
    # isolation — so a future dep removal that misses this list fails here.
    test "every required app resolves to a loadable .app (no dangling app refs)" do
      for app <- CLI.launcher_required_apps() do
        assert Application.load(app) in [:ok, {:error, {:already_loaded, app}}],
               "#{inspect(app)} is listed in launcher_required_apps/0 but its .app " <>
                 "cannot be loaded — was a dependency removed without updating the list?"
      end
    end
  end
end
