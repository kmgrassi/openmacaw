defmodule SymphonyElixir.WorkItem.MapperTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkItem.Mapper

  describe "from_database_row/2" do
    test "maps work_items rows through the canonical WorkItem contract" do
      row = %{
        "id" => "wi-1",
        "identifier" => "WI-1",
        "title" => "Fix dispatch",
        "description" => "Route the runner",
        "priority" => "2",
        "state" => "Todo",
        "source" => nil,
        "runner_type" => nil,
        "repository_id" => "repo-1",
        "repository" => "parallel-agent-runtime",
        "plan_id" => "plan-1",
        "task_id" => "task-1",
        "workspace_id" => "workspace-1",
        "labels" => ["backend", %{"name" => "status:ready"}, %{"bad" => "ignored"}],
        "metadata" => %{"url" => "https://example.test/wi-1", "runner_type" => "codex"},
        "created_at" => "2026-04-25T12:00:00Z",
        "updated_at" => "not-a-timestamp"
      }

      assert %WorkItem{} = item = Mapper.from_database_row(row)
      assert item.id == "wi-1"
      assert item.source == "database"
      assert item.runner_type == "codex"
      assert item.repository_id == "repo-1"
      assert item.repository == "parallel-agent-runtime"
      assert item.url == "https://example.test/wi-1"
      assert item.labels == ["backend", "status:ready"]
      assert item.metadata["workspace_id"] == "workspace-1"
      assert item.created_at == ~U[2026-04-25 12:00:00Z]
      assert item.updated_at == nil
    end

    test "lets manager dispatch override runner_type without changing row metadata" do
      item =
        Mapper.from_database_row(
          %{"id" => "wi-1", "source" => "github", "metadata" => %{"runner_type" => "planner"}},
          runner_type: "codex",
          source: :row
        )

      assert item.runner_type == "codex"
      assert item.source == "github"
      assert item.metadata["runner_type"] == "planner"
    end

    test "derives runner_type from routing intent when no runner kind is stored" do
      item =
        Mapper.from_database_row(%{
          "id" => "wi-1",
          "source" => "planner",
          "metadata" => %{"routing" => %{"intent" => "follow_up"}}
        })

      assert item.runner_type == "planner"
    end

    test "defaults database tracker rows to database source" do
      item = Mapper.from_database_row(%{"id" => "wi-1", "source" => "github"})

      assert item.source == "database"
    end

    test "maps depends_on rows into dispatch blockers" do
      item =
        Mapper.from_database_row(%{
          "id" => "wi-1",
          "metadata" => %{},
          "depends_on" => ["wi-0"]
        })

      assert item.metadata.blocked_by == ["wi-0"]
    end

    test "preserves explicit blocked_by metadata over depends_on" do
      item =
        Mapper.from_database_row(%{
          "id" => "wi-1",
          "metadata" => %{blocked_by: [%{id: "custom", state: "running"}]},
          "depends_on" => ["wi-0"]
        })

      assert item.metadata.blocked_by == [%{id: "custom", state: "running"}]
    end
  end

  describe "from_github_issue/3" do
    test "normalizes labels, status labels, timestamps, and source metadata" do
      issue = %{
        "number" => 42,
        "title" => "Fix login",
        "body" => "SSO is broken",
        "state" => "open",
        "html_url" => "https://github.com/test-org/test-repo/issues/42",
        "labels" => [%{"name" => "bug"}, %{"name" => "status:in-progress"}],
        "assignee" => %{"login" => "dev1"},
        "milestone" => %{"title" => "v2"},
        "pull_request" => nil,
        "created_at" => "2026-04-25T12:00:00Z",
        "updated_at" => "2026-04-25T13:00:00Z"
      }

      item = Mapper.from_github_issue("test-org", "test-repo", issue)

      assert item.identifier == "GH-42"
      assert item.state == "in-progress"
      assert item.labels == ["bug", "status:in-progress"]
      assert item.metadata.assignee == "dev1"
      assert item.metadata.repository == "test-org/test-repo"
      assert item.created_at == ~U[2026-04-25 12:00:00Z]
      assert item.updated_at == ~U[2026-04-25 13:00:00Z]
    end
  end

  describe "from_api_payload/2" do
    test "maps pushed payloads with generated defaults" do
      now = ~U[2026-04-25 12:00:00Z]

      item =
        Mapper.from_api_payload(
          %{
            "id" => "api-1",
            "title" => "Deploy",
            "labels" => [%{name: "release"}],
            "metadata" => %{url: "https://example.test/api-1"}
          },
          now
        )

      assert item.identifier == "API-api-1"
      assert item.state == "Todo"
      assert item.source == "api"
      assert item.labels == ["release"]
      assert item.url == "https://example.test/api-1"
      assert item.created_at == now
      assert item.updated_at == now
    end
  end
end
