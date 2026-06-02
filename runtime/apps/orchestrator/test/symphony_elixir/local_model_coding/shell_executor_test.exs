defmodule SymphonyElixir.LocalModelCoding.ShellExecutorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalModelCoding.ShellExecutor

  test "runs argv commands inside the workspace and streams output events" do
    workspace = tmp_workspace!()
    parent = self()

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["sh", "-c", "printf hello"],
               workspace: workspace,
               approval_policy: "never",
               on_event: fn event -> send(parent, {:event, event}) end
             })

    assert result.exit_code == 0
    assert result.stdout == "hello"
    assert result.stderr == ""
    assert result.cwd == workspace
    refute result.timed_out?
    refute result.cancelled?
    refute result.truncated?

    assert_receive {:event, %{event: :command_started, payload: %{tool: "shell.exec", argv: ["sh", "-c", "printf hello"]}}}
    assert_receive {:event, %{event: :command_output_delta, payload: %{"stream" => "stdout", "text" => "hello"}}}
    assert_receive {:event, %{event: :command_completed, payload: %{exit_code: 0, stdout_bytes: 5}}}
  end

  test "enforces cwd inside workspace and rejects symlink escapes" do
    workspace = tmp_workspace!()
    outside = tmp_workspace!()
    File.mkdir_p!(Path.join(workspace, "safe"))
    File.ln_s!(outside, Path.join(workspace, "escape"))

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["pwd"],
               workspace: workspace,
               cwd: "safe",
               approval_policy: "never"
             })

    assert result.cwd == Path.join(workspace, "safe")

    assert {:error, {:invalid_shell_exec_cwd, :outside_workspace}} =
             ShellExecutor.exec(%{
               argv: ["pwd"],
               workspace: workspace,
               cwd: "escape",
               approval_policy: "never"
             })

    assert {:error, {:invalid_shell_exec_cwd, :outside_workspace}} =
             ShellExecutor.exec(%{
               argv: ["pwd"],
               workspace: workspace,
               cwd: "../#{Path.basename(outside)}",
               approval_policy: "never"
             })
  end

  test "passes only allowlisted environment values" do
    workspace = tmp_workspace!()
    original_secret = System.get_env("SECRET")
    System.put_env("SECRET", "parent-secret")

    on_exit(fn -> restore_env("SECRET", original_secret) end)

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["sh", "-c", "printf '%s:%s' \"$ALLOWED\" \"$SECRET\""],
               workspace: workspace,
               env: %{"ALLOWED" => "yes", "SECRET" => "no"},
               allowed_env: ["ALLOWED"],
               approval_policy: "never"
             })

    assert result.stdout == "yes:"
  end

  test "requires approval unless policy is never and supports approval callbacks" do
    workspace = tmp_workspace!()
    parent = self()

    assert {:error, {:approval_required, %{tool: "shell.exec", command: "pwd"}}} =
             ShellExecutor.exec(%{argv: ["pwd"], workspace: workspace})

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["pwd"],
               workspace: workspace,
               approval_callback: fn request ->
                 send(parent, {:approval_request, request})
                 :approved
               end
             })

    assert result.exit_code == 0
    assert_receive {:approval_request, %{tool: "shell.exec", command: "pwd", cwd: ^workspace}}
  end

  test "caps output and marks the command truncated" do
    workspace = tmp_workspace!()

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["sh", "-c", "printf abcdef"],
               workspace: workspace,
               approval_policy: "never",
               output_limit_bytes: 3
             })

    assert result.stdout == "abc"
    assert result.exit_code == nil
    assert result.truncated?
  end

  test "times out long-running commands" do
    workspace = tmp_workspace!()

    assert {:ok, result} =
             ShellExecutor.exec(%{
               argv: ["sh", "-c", "sleep 1"],
               workspace: workspace,
               approval_policy: "never",
               timeout_ms: 10
             })

    assert result.exit_code == nil
    assert result.timed_out?
  end

  test "can cancel an async command" do
    workspace = tmp_workspace!()

    assert {:ok, %{pid: pid, ref: ref} = handle} =
             ShellExecutor.start(%{
               argv: ["sh", "-c", "sleep 1"],
               workspace: workspace,
               approval_policy: "never",
               timeout_ms: 5_000
             })

    assert Process.alive?(pid)
    assert :ok = ShellExecutor.cancel(handle)
    assert_receive {:shell_exec_result, ^ref, {:ok, result}}, 1_000
    assert result.cancelled?
  end

  defp tmp_workspace! do
    path =
      Path.join(
        System.tmp_dir!(),
        "symphony-shell-executor-#{System.unique_integer([:positive, :monotonic])}"
      )

    File.rm_rf!(path)
    File.mkdir_p!(path)
    {:ok, realpath} = SymphonyElixir.PathSafety.canonicalize(path)
    realpath
  end
end
