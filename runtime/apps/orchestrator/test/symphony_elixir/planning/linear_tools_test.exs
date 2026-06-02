defmodule SymphonyElixir.Planning.LinearToolsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planning.LinearTools

  @linear_policy %{
    "planning" => %{
      "destination" => "linear",
      "linear" => %{
        "api_key" => "lin_api_key",
        "endpoint" => "https://linear.test/graphql",
        "team_id" => "team-1",
        "project_id" => "project-1",
        "label_ids" => ["planner"]
      }
    }
  }

  test "create_issue is disabled unless planner destination is linear" do
    response =
      LinearTools.create_issue(
        %{"name" => "Break rollout into tasks"},
        %{"planning" => %{"destination" => "database"}},
        linear_client: fn _input, _opts ->
          flunk("linear client should not be called when Linear planning is disabled")
        end
      )

    assert response == {:error, :linear_planning_disabled}
  end

  test "create_issue builds Linear issue input from arguments and policy config" do
    test_pid = self()

    assert {:ok, %{"id" => "issue-1"}} =
             LinearTools.create_issue(
               %{
                 "name" => "Break rollout into tasks",
                 "description" => "Create implementation tickets",
                 "priority" => "2"
               },
               @linear_policy,
               linear_client: fn input, opts ->
                 send(test_pid, {:linear_create_called, input, opts})
                 {:ok, %{"id" => "issue-1"}}
               end
             )

    assert_received {:linear_create_called,
                     %{
                       "teamId" => "team-1",
                       "title" => "Break rollout into tasks",
                       "description" => "Create implementation tickets",
                       "priority" => 2,
                       "projectId" => "project-1",
                       "labelIds" => ["planner"]
                     }, opts}

    assert Keyword.fetch!(opts, :api_key) == "lin_api_key"
    assert Keyword.fetch!(opts, :endpoint) == "https://linear.test/graphql"
  end

  test "update_issue builds Linear update input and requires allowed fields" do
    test_pid = self()

    assert {:ok, %{"id" => "issue-1"}} =
             LinearTools.update_issue(
               %{
                 "issue_id" => "issue-1",
                 "name" => "Updated task",
                 "status" => "ignored",
                 "label_ids" => ["planner", ""]
               },
               @linear_policy,
               linear_client: fn issue_id, input, opts ->
                 send(test_pid, {:linear_update_called, issue_id, input, opts})
                 {:ok, %{"id" => issue_id}}
               end
             )

    assert_received {:linear_update_called, "issue-1",
                     %{
                       "title" => "Updated task",
                       "labelIds" => ["planner"]
                     }, opts}

    assert Keyword.fetch!(opts, :api_key) == "lin_api_key"
  end
end
