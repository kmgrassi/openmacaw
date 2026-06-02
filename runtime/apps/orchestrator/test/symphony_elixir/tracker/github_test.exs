defmodule SymphonyElixir.Tracker.GitHubTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tracker.GitHub
  alias SymphonyElixir.WorkItem

  @moduletag :tracker_github

  setup do
    Application.put_env(:symphony_elixir, :github_tracker_req_options, plug: {Req.Test, GitHub})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :github_tracker_req_options)
    end)

    :ok
  end

  defp write_github_workflow(overrides \\ []) do
    defaults = [
      repository: "test-org/test-repo",
      api_key: "ghp_test_token",
      active_states: ["open"],
      terminal_states: ["closed"]
    ]

    config = Keyword.merge(defaults, overrides)
    workflow_path = Application.get_env(:symphony_elixir, :workflow_file_path)

    content = """
    ---
    tracker:
      kind: github
      repository: "#{config[:repository]}"
      api_key: "#{config[:api_key]}"
      active_states: #{inspect(config[:active_states])}
      terminal_states: #{inspect(config[:terminal_states])}
    polling:
      interval_ms: 30000
    workspace:
      root: "#{Path.join(System.tmp_dir!(), "symphony_workspaces")}"
    agent:
      max_concurrent_agents: 10
      max_turns: 20
    codex:
      command: "codex app-server"
    ---
    You are an agent for this repository.
    """

    File.write!(workflow_path, content)

    if Process.whereis(SymphonyElixir.WorkflowStore) do
      try do
        SymphonyElixir.WorkflowStore.force_reload()
      catch
        :exit, _reason -> :ok
      end
    end
  end

  @github_issue %{
    "number" => 42,
    "title" => "Fix login bug",
    "body" => "Users can't login with SSO",
    "state" => "open",
    "html_url" => "https://github.com/test-org/test-repo/issues/42",
    "labels" => [%{"name" => "bug"}, %{"name" => "priority:high"}],
    "assignee" => %{"login" => "developer1"},
    "milestone" => %{"title" => "v2.0"},
    "pull_request" => nil,
    "created_at" => "2024-01-15T10:00:00Z",
    "updated_at" => "2024-01-16T14:30:00Z"
  }

  describe "fetch_candidate_issues/0" do
    test "maps GitHub issues to WorkItems" do
      write_github_workflow()

      Req.Test.stub(GitHub, fn conn ->
        assert conn.method == "GET"
        assert String.contains?(conn.request_path, "/repos/test-org/test-repo/issues")

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([@github_issue]))
      end)

      assert {:ok, [%WorkItem{} = item]} = GitHub.fetch_candidate_issues()
      assert item.id == "42"
      assert item.identifier == "GH-42"
      assert item.title == "Fix login bug"
      assert item.source == "github"
      assert item.state == "open"
      assert "bug" in item.labels
      assert item.metadata.assignee == "developer1"
      assert item.metadata.milestone == "v2.0"
    end

    test "uses status: label for granular state" do
      write_github_workflow(active_states: ["in-progress"])

      issue = Map.put(@github_issue, "labels", [
        %{"name" => "status:in-progress"},
        %{"name" => "bug"}
      ])

      Req.Test.stub(GitHub, fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([issue]))
      end)

      assert {:ok, [%WorkItem{state: "in-progress"}]} = GitHub.fetch_candidate_issues()
    end
  end

  describe "create_comment/2" do
    test "posts comment to GitHub" do
      write_github_workflow()

      Req.Test.stub(GitHub, fn conn ->
        assert conn.method == "POST"
        assert String.contains?(conn.request_path, "/issues/42/comments")

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(201, Jason.encode!(%{"id" => 1}))
      end)

      assert :ok = GitHub.create_comment("42", "Work completed")
    end
  end

  describe "update_issue_state/2" do
    test "patches issue state" do
      write_github_workflow()

      Req.Test.stub(GitHub, fn conn ->
        assert conn.method == "PATCH"
        assert String.contains?(conn.request_path, "/issues/42")

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!(%{"state" => "closed"}))
      end)

      assert :ok = GitHub.update_issue_state("42", "closed")
    end
  end
end
