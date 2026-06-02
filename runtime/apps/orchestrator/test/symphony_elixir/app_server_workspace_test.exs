defmodule SymphonyElixir.AppServerWorkspaceTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.AppServerTestSupport

  test "app server rejects the workspace root and paths outside workspace root" do
    with_test_root("symphony-elixir-app-server-cwd-guard", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      outside_workspace = Path.join(test_root, "outside")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      issue =
        issue(
          "issue-workspace-guard",
          "MT-999",
          "Validate workspace guard",
          "Ensure app-server refuses invalid cwd targets"
        )

      assert {:error, {:invalid_workspace_cwd, :workspace_root, _path}} =
               AppServer.run(workspace_root, "guard", issue)

      assert {:error, {:invalid_workspace_cwd, :outside_workspace_root, _path, _root}} =
               AppServer.run(outside_workspace, "guard", issue)
    end)
  end

  test "app server rejects symlink escape cwd paths under the workspace root" do
    with_test_root("symphony-elixir-app-server-symlink-cwd-guard", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      outside_workspace = Path.join(test_root, "outside")
      symlink_workspace = Path.join(workspace_root, "MT-1000")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_workspace)
      File.ln_s!(outside_workspace, symlink_workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      issue =
        issue(
          "issue-workspace-symlink-guard",
          "MT-1000",
          "Validate symlink workspace guard",
          "Ensure app-server refuses symlink escape cwd targets"
        )

      assert {:error, {:invalid_workspace_cwd, :symlink_escape, ^symlink_workspace, _root}} =
               AppServer.run(symlink_workspace, "guard", issue)
    end)
  end

  test "app server passes explicit turn sandbox policies through unchanged" do
    with_test_root("symphony-elixir-app-server-supported-turn-policies", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-1001")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-supported-turn-policies.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-supported-turn-policies.trace}"
      count=0

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1001"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-1001"}}}'
            ;;
          4)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      issue =
        issue(
          "issue-supported-turn-policies",
          "MT-1001",
          "Validate explicit turn sandbox policy passthrough",
          "Ensure runtime startup forwards configured turn sandbox policies unchanged"
        )

      policy_cases = [
        %{"type" => "dangerFullAccess"},
        %{"type" => "externalSandbox", "profile" => "remote-ci"},
        %{"type" => "workspaceWrite", "writableRoots" => ["relative/path"], "networkAccess" => true},
        %{"type" => "futureSandbox", "nested" => %{"flag" => true}}
      ]

      Enum.each(policy_cases, fn configured_policy ->
        File.rm(trace_file)

        write_workflow_file!(Workflow.workflow_file_path(),
          workspace_root: workspace_root,
          codex_command: "#{codex_binary} app-server",
          codex_turn_sandbox_policy: configured_policy
        )

        assert {:ok, _result} = AppServer.run(workspace, "Validate supported turn policy", issue)

        trace_lines(trace_file)
        |> assert_json_trace(fn payload ->
          payload["method"] == "turn/start" &&
            get_in(payload, ["params", "sandboxPolicy"]) == configured_policy
        end)
      end)
    end)
  end

  test "app server prefers runner config command model and provider over workflow codex settings" do
    with_test_root("symphony-elixir-app-server-runner-config", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-1002")
      runner_codex_binary = Path.join(test_root, "runner-codex")
      trace_file = Path.join(test_root, "codex-runner-config.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(runner_codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-runner-config.trace}"
      count=0
      printf 'ARGV:%s\\n' "$*" >> "$trace_file"

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1002"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-1002"}}}'
            ;;
          4)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "false",
        codex_model: "workflow-model",
        codex_model_provider: "workflow-provider"
      )

      issue =
        issue(
          "issue-runner-config",
          "MT-1002",
          "Validate runner config precedence",
          "Ensure AppServer uses runner config overrides"
        )

      runner_config = %{
        "command" => "#{runner_codex_binary} --runner-flag app-server",
        "model" => "runner-model",
        "model_provider" => "runner-provider"
      }

      assert {:ok, session} = SymphonyElixir.Runner.Codex.start_session(runner_config, workspace)

      try do
        assert {:ok, _result} =
                 SymphonyElixir.Runner.Codex.run_turn(session, "Use runner config", issue)
      after
        SymphonyElixir.Runner.Codex.stop_session(session)
      end

      lines = trace_lines(trace_file)
      assert argv_line = Enum.find(lines, &String.starts_with?(&1, "ARGV:"))
      assert String.contains?(argv_line, "--runner-flag app-server")

      decoded_messages = json_trace_payloads(lines)

      assert Enum.any?(decoded_messages, fn payload ->
               payload["method"] == "thread/start" &&
                 get_in(payload, ["params", "model"]) == "runner-model" &&
                 get_in(payload, ["params", "modelProvider"]) == "runner-provider"
             end)

      assert Enum.any?(decoded_messages, fn payload ->
               payload["method"] == "turn/start" &&
                 get_in(payload, ["params", "model"]) == "runner-model" &&
                 get_in(payload, ["params", "modelProvider"]) == "runner-provider"
             end)

      refute File.read!(trace_file) =~ "workflow-model"
      refute File.read!(trace_file) =~ "workflow-provider"
    end)
  end
end
