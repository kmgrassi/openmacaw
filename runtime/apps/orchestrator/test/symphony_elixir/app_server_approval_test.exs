defmodule SymphonyElixir.AppServerApprovalTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.AppServerTestSupport

  test "app server marks request-for-input events as a hard failure" do
    with_test_root("symphony-elixir-app-server-input", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-88")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-input.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-input.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-88"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-88"}}}'
            ;;
          4)
            printf '%s\\n' '{"method":"turn/input_required","id":"resp-1","params":{"requiresInput":true,"reason":"blocked"}}'
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-input",
          "MT-88",
          "Input needed",
          "Cannot satisfy codex input"
        )

      assert {:error, {:turn_input_required, payload}} =
               AppServer.run(workspace, "Needs input", issue)

      assert payload["method"] == "turn/input_required"
    end)
  end

  test "app server fails when command execution approval is required under safer defaults" do
    with_test_root("symphony-elixir-app-server-approval-required", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-89")
      codex_binary = Path.join(test_root, "fake-codex")

      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      count=0
      while IFS= read -r _line; do
        count=$((count + 1))

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-89"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-89"}}}'
            printf '%s\\n' '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}'
            ;;
          *)
            sleep 1
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-approval-required",
          "MT-89",
          "Approval required",
          "Ensure safer defaults do not auto approve requests"
        )

      assert {:error, {:approval_required, payload}} =
               AppServer.run(workspace, "Handle approval request", issue)

      assert payload["method"] == "item/commandExecution/requestApproval"
    end)
  end

  test "app server auto-approves command execution approval requests when approval policy is never" do
    with_test_root("symphony-elixir-app-server-auto-approve", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-89")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-auto-approve.trace")

      put_env_for_test("SYMP_TEST_CODex_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODex_TRACE:-/tmp/codex-auto-approve.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-89"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-89"}}}'
            printf '%s\\n' '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}'
            ;;
          5)
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
        codex_command: "#{codex_binary} app-server",
        codex_approval_policy: "never"
      )

      issue =
        issue(
          "issue-auto-approve",
          "MT-89",
          "Auto approve request",
          "Ensure app-server approval requests are handled automatically"
        )

      assert {:ok, _result} = AppServer.run(workspace, "Handle approval request", issue)

      lines = trace_lines(trace_file)

      assert_json_trace(lines, fn payload ->
        payload["id"] == 1 and
          get_in(payload, ["params", "capabilities", "experimentalApi"]) == true
      end)

      assert_json_trace(lines, fn payload ->
        payload["id"] == 2 and
          case get_in(payload, ["params", "dynamicTools"]) do
            [
              %{
                "description" => description,
                "inputSchema" => %{"required" => ["query"]},
                "name" => "linear_graphql"
              },
              %{"name" => "snooze_work_item"}
            ] ->
              description =~ "Linear"

            _ ->
              false
          end
      end)

      assert_json_trace(lines, fn payload ->
        payload["id"] == 99 and get_in(payload, ["result", "decision"]) == "acceptForSession"
      end)
    end)
  end

  test "app server auto-approves MCP tool approval prompts when approval policy is never" do
    with_test_root("symphony-elixir-app-server-tool-user-input-auto-approve", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-717")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-tool-user-input-auto-approve.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-tool-user-input-auto-approve.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-717"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-717"}}}'
            printf '%s\\n' '{"id":110,"method":"item/tool/requestUserInput","params":{"itemId":"call-717","questions":[{"header":"Approve app tool call?","id":"mcp_tool_call_approval_call-717","isOther":false,"isSecret":false,"options":[{"description":"Run the tool and continue.","label":"Approve Once"},{"description":"Run the tool and remember this choice for this session.","label":"Approve this Session"},{"description":"Decline this tool call and continue.","label":"Deny"},{"description":"Cancel this tool call","label":"Cancel"}],"question":"The linear MCP server wants to run the tool \\"Save issue\\", which may modify or delete data. Allow this action?"}],"threadId":"thread-717","turnId":"turn-717"}}'
            ;;
          5)
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
        codex_command: "#{codex_binary} app-server",
        codex_approval_policy: "never"
      )

      issue =
        issue(
          "issue-tool-user-input-auto-approve",
          "MT-717",
          "Auto approve MCP tool request user input",
          "Ensure app tool approval prompts continue automatically"
        )

      assert {:ok, _result} = AppServer.run(workspace, "Handle tool approval prompt", issue)

      trace_lines(trace_file)
      |> assert_json_trace(fn payload ->
        payload["id"] == 110 and
          get_in(payload, ["result", "answers", "mcp_tool_call_approval_call-717", "answers"]) ==
            ["Approve this Session"]
      end)
    end)
  end

  test "app server sends a generic non-interactive answer for freeform tool input prompts" do
    with_test_root("symphony-elixir-app-server-tool-user-input-required", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-718")
      codex_binary = Path.join(test_root, "fake-codex")

      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      count=0
      while IFS= read -r _line; do
        count=$((count + 1))

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-718"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-718"}}}'
            printf '%s\\n' '{"id":111,"method":"item/tool/requestUserInput","params":{"itemId":"call-718","questions":[{"header":"Provide context","id":"freeform-718","isOther":false,"isSecret":false,"options":null,"question":"What comment should I post back to the issue?"}],"threadId":"thread-718","turnId":"turn-718"}}'
            ;;
          5)
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
        codex_command: "#{codex_binary} app-server",
        codex_approval_policy: "never"
      )

      issue =
        issue(
          "issue-tool-user-input-required",
          "MT-718",
          "Non interactive tool input answer",
          "Ensure arbitrary tool prompts receive a generic answer"
        )

      on_message = fn message -> send(self(), {:app_server_message, message}) end

      assert {:ok, _result} =
               AppServer.run(workspace, "Handle generic tool input", issue, on_message: on_message)

      assert_received {:app_server_message,
                       %{
                         event: :tool_input_auto_answered,
                         answer: "This is a non-interactive session. Operator input is unavailable."
                       }}
    end)
  end

  test "app server sends a generic non-interactive answer for option-based tool input prompts" do
    with_test_root("symphony-elixir-app-server-tool-user-input-options", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-719")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-tool-user-input-options.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-tool-user-input-options.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-719"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-719"}}}'
            printf '%s\\n' '{"id":112,"method":"item/tool/requestUserInput","params":{"itemId":"call-719","questions":[{"header":"Choose an action","id":"options-719","isOther":false,"isSecret":false,"options":[{"description":"Use the default behavior.","label":"Use default"},{"description":"Skip this step.","label":"Skip"}],"question":"How should I proceed?"}],"threadId":"thread-719","turnId":"turn-719"}}'
            ;;
          5)
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
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-tool-user-input-options",
          "MT-719",
          "Option based tool input answer",
          "Ensure option prompts receive a generic non-interactive answer"
        )

      assert {:ok, _result} =
               AppServer.run(workspace, "Handle option based tool input", issue)

      trace_lines(trace_file)
      |> assert_json_trace(fn payload ->
        payload["id"] == 112 and
          get_in(payload, ["result", "answers", "options-719", "answers"]) == [
            "This is a non-interactive session. Operator input is unavailable."
          ]
      end)
    end)
  end
end
