defmodule SymphonyElixir.Runner.CodingTools.ShellExecutorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.Runner.CodingTools.ShellExecutor

  setup do
    workspace = Path.join(System.tmp_dir!(), "symphony-shell-executor-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(workspace)
    {:ok, canonical_workspace} = PathSafety.canonicalize(workspace)

    on_exit(fn ->
      File.rm_rf(workspace)
    end)

    {:ok, workspace: workspace, canonical_workspace: canonical_workspace}
  end

  test "runs argv commands in the workspace and streams stdout/stderr", %{canonical_workspace: workspace} do
    parent = self()

    assert {:ok, result} =
             ShellExecutor.run(
               %{
                 "argv" => ["sh", "-c", "pwd; echo err >&2"],
                 "cwd" => "."
               },
               %{
                 workspace_root: workspace,
                 command_id: "streams",
                 on_event: fn event -> send(parent, {:event, event}) end
               }
             )

    assert result["success"] == true
    assert String.trim(result["stdout"]) == workspace
    assert String.trim(result["stderr"]) == "err"

    assert_receive {:event, %{event: :command_started, payload: %{"command_id" => "streams"}}}
    assert_receive {:event, %{event: :command_output_delta, payload: %{"stream" => "stdout"}}}
    assert_receive {:event, %{event: :command_output_delta, payload: %{"stream" => "stderr", "text" => "err\n"}}}
    assert_receive {:event, %{event: :command_completed, payload: %{"success" => true, "command_id" => "streams"}}}
  end

  test "allows relative cwd under the workspace", %{workspace: raw_workspace, canonical_workspace: workspace} do
    File.mkdir_p!(Path.join(raw_workspace, "nested"))

    assert {:ok, result} =
             ShellExecutor.run(
               %{"argv" => ["pwd"], "cwd" => "nested"},
               %{workspace_root: workspace, command_id: "relative-cwd"}
             )

    assert result["success"] == true
    assert String.trim(result["stdout"]) == Path.join(workspace, "nested")
  end

  test "resolves relative executable paths from the requested cwd", %{workspace: raw_workspace, canonical_workspace: workspace} do
    bin_dir = Path.join(raw_workspace, "bin")
    File.mkdir_p!(bin_dir)
    script = Path.join(bin_dir, "print-cwd")
    File.write!(script, "#!/bin/sh\npwd\n")
    File.chmod!(script, 0o755)

    assert {:ok, result} =
             ShellExecutor.run(
               %{"argv" => ["./print-cwd"], "cwd" => "bin"},
               %{workspace_root: raw_workspace, command_id: "relative-executable"}
             )

    assert result["success"] == true
    assert String.trim(result["stdout"]) == Path.join(workspace, "bin")
  end

  test "rejects executable paths outside the workspace", %{workspace: workspace} do
    outside = Path.join(System.tmp_dir!(), "symphony-shell-executor-outside-bin-#{System.unique_integer([:positive])}")
    File.mkdir_p!(outside)
    executable = Path.join(outside, "tool")
    File.write!(executable, "#!/bin/sh\nprintf escaped\n")
    File.chmod!(executable, 0o755)
    {:ok, canonical_executable} = PathSafety.canonicalize(executable)

    on_exit(fn -> File.rm_rf(outside) end)

    assert {:error, {:executable_outside_workspace, ^canonical_executable, _root}} =
             ShellExecutor.run(
               %{"argv" => [executable]},
               %{workspace_root: workspace, command_id: "absolute-executable"}
             )
  end

  test "rejects relative executable symlink escapes", %{workspace: raw_workspace, canonical_workspace: workspace} do
    outside = Path.join(System.tmp_dir!(), "symphony-shell-executor-linked-bin-#{System.unique_integer([:positive])}")
    File.mkdir_p!(outside)
    executable = Path.join(outside, "tool")
    File.write!(executable, "#!/bin/sh\nprintf escaped\n")
    File.chmod!(executable, 0o755)

    File.mkdir_p!(Path.join(raw_workspace, "bin"))
    File.ln_s!(executable, Path.join([raw_workspace, "bin", "tool"]))

    on_exit(fn -> File.rm_rf(outside) end)

    assert {:error, {:executable_symlink_escape, _path, ^workspace}} =
             ShellExecutor.run(
               %{"argv" => ["./tool"], "cwd" => "bin"},
               %{workspace_root: workspace, command_id: "linked-executable"}
             )
  end

  test "rejects cwd traversal outside the workspace", %{workspace: workspace} do
    assert {:error, {:cwd_outside_workspace, _cwd, _root}} =
             ShellExecutor.run(
               %{"argv" => ["pwd"], "cwd" => ".."},
               %{workspace_root: workspace, command_id: "escape"}
             )
  end

  test "rejects symlink cwd escapes", %{workspace: raw_workspace, canonical_workspace: workspace} do
    outside = Path.join(System.tmp_dir!(), "symphony-shell-executor-outside-#{System.unique_integer([:positive])}")
    File.mkdir_p!(outside)
    File.ln_s!(outside, Path.join(raw_workspace, "linked"))

    on_exit(fn -> File.rm_rf(outside) end)

    assert {:error, {:cwd_symlink_escape, _cwd, ^workspace}} =
             ShellExecutor.run(
               %{"argv" => ["pwd"], "cwd" => "linked"},
               %{workspace_root: workspace, command_id: "symlink-escape"}
             )
  end

  test "filters inherited and requested environment variables through the allowlist", %{workspace: workspace} do
    previous_secret = System.get_env("SHELL_EXEC_SECRET")
    previous_visible = System.get_env("VISIBLE")

    System.put_env("SHELL_EXEC_SECRET", "inherited-secret")
    System.put_env("VISIBLE", "inherited-visible")

    on_exit(fn ->
      restore_env("SHELL_EXEC_SECRET", previous_secret)
      restore_env("VISIBLE", previous_visible)
    end)

    assert {:ok, result} =
             ShellExecutor.run(
               %{
                 "argv" => ["env"],
                 "env" => %{"VISIBLE" => "requested-visible", "SECRET" => "requested-secret"}
               },
               %{
                 workspace_root: workspace,
                 command_id: "env",
                 env_allowlist: ["VISIBLE"]
               }
             )

    assert result["stdout"] =~ "VISIBLE=requested-visible"
    refute result["stdout"] =~ "SHELL_EXEC_SECRET=inherited-secret"
    refute result["stdout"] =~ "SECRET=requested-secret"
  end

  test "caps captured output while preserving command status", %{workspace: workspace} do
    assert {:ok, result} =
             ShellExecutor.run(
               %{"argv" => ["printf", "abcdef"]},
               %{workspace_root: workspace, command_id: "cap", output_limit_bytes: 3}
             )

    assert result["success"] == true
    assert result["stdout"] == "abc"
    assert result["output_truncated"] == true
  end

  test "times out long-running commands", %{workspace: workspace} do
    assert {:ok, result} =
             ShellExecutor.run(
               %{"argv" => ["sh", "-c", "sleep 5"]},
               %{workspace_root: workspace, command_id: "timeout", timeout_ms: 50}
             )

    assert result["success"] == false
    assert result["timed_out"] == true
  end

  test "cancels long-running commands by command id", %{workspace: workspace} do
    parent = self()
    command_id = "cancel-#{System.unique_integer([:positive])}"
    pidfile = Path.join([System.tmp_dir!(), "symphony-shell-exec-pids", command_id <> ".pid"])
    cancel_marker = Path.join([System.tmp_dir!(), "symphony-shell-exec-pids", command_id <> ".cancel"])
    File.rm(pidfile)
    File.rm(cancel_marker)

    runner =
      spawn_link(fn ->
        result =
          ShellExecutor.run(
            %{"argv" => ["sleep", "5"]},
            %{workspace_root: workspace, command_id: command_id, timeout_ms: 5_000}
          )

        send(parent, {:result, result})
      end)

    assert eventually(fn -> child_pid_ready?(pidfile) end)
    assert :ok = ShellExecutor.cancel(command_id)
    assert_receive {:result, {:ok, %{"success" => false, "cancelled" => true}}}, 3_000
    refute Process.alive?(runner)
  end

  test "approval callback can stop execution", %{workspace: workspace} do
    parent = self()

    assert {:error, {:approval_required, :manual_review}} =
             ShellExecutor.run(
               %{"argv" => ["pwd"]},
               %{
                 workspace_root: workspace,
                 command_id: "approval",
                 approval_callback: fn request ->
                   send(parent, {:approval_request, request})
                   {:error, :manual_review}
                 end,
                 on_event: fn event -> send(parent, {:event, event}) end
               }
             )

    assert_receive {:approval_request, %{"tool_name" => "shell.exec", "command_id" => "approval"}}
    assert_receive {:event, %{event: :approval_requested, payload: %{"reason" => ":manual_review"}}}
  end

  defp eventually(fun) do
    Enum.reduce_while(1..20, false, fn _attempt, _acc ->
      if fun.() do
        {:halt, true}
      else
        Process.sleep(25)
        {:cont, false}
      end
    end)
  end

  defp child_pid_ready?(pidfile) do
    with {:ok, contents} <- File.read(pidfile),
         {_pid, ""} <- Integer.parse(String.trim(contents)) do
      true
    else
      _ -> false
    end
  end
end
