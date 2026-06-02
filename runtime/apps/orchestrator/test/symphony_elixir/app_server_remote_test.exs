defmodule SymphonyElixir.AppServerRemoteTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.AppServerTestSupport

  test "app server launches over ssh for remote workers" do
    with_test_root("symphony-elixir-app-server-remote-ssh", fn test_root ->
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = Path.join(test_root, "ssh")
      remote_workspace = "/remote/workspaces/MT-REMOTE"

      put_env_for_test("SYMP_TEST_SSH_TRACE", trace_file)
      put_env_for_test("PATH", test_root <> ":" <> (System.get_env("PATH") || ""))

      write_executable!(fake_ssh, """
      #!/bin/sh
      trace_file="${SYMP_TEST_SSH_TRACE:-/tmp/symphony-fake-ssh.trace}"
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
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-remote"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-remote"}}}'
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
        workspace_root: "/remote/workspaces",
        codex_command: "fake-remote-codex app-server"
      )

      issue =
        issue(
          "issue-remote",
          "MT-REMOTE",
          "Run remote app server",
          "Validate ssh-backed codex startup"
        )

      assert {:ok, _result} =
               AppServer.run(
                 remote_workspace,
                 "Run remote worker",
                 issue,
                 worker_host: "worker-01:2200"
               )

      lines = trace_lines(trace_file)
      assert argv_line = Enum.find(lines, &String.starts_with?(&1, "ARGV:"))
      assert argv_line =~ "-T -p 2200 worker-01 bash -lc"
      assert argv_line =~ "cd "
      assert argv_line =~ remote_workspace
      assert argv_line =~ "exec "
      assert argv_line =~ "fake-remote-codex app-server"

      expected_turn_policy = %{
        "type" => "workspaceWrite",
        "writableRoots" => [remote_workspace],
        "readOnlyAccess" => %{"type" => "fullAccess"},
        "networkAccess" => false,
        "excludeTmpdirEnvVar" => false,
        "excludeSlashTmp" => false
      }

      assert_json_trace(lines, fn payload ->
        payload["method"] == "thread/start" &&
          get_in(payload, ["params", "cwd"]) == remote_workspace
      end)

      assert_json_trace(lines, fn payload ->
        payload["method"] == "turn/start" &&
          get_in(payload, ["params", "cwd"]) == remote_workspace &&
          get_in(payload, ["params", "sandboxPolicy"]) == expected_turn_policy
      end)
    end)
  end
end
