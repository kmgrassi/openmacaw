defmodule SymphonyElixir.Linear.ClientPlannerMutationTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.Client

  test "create_issue constructs the planner Linear GraphQL request" do
    test_pid = self()

    assert {:ok, %{"id" => "issue-1", "title" => "Plan rollout"}} =
             Client.create_issue(
               %{"teamId" => "team-1", "title" => "Plan rollout"},
               api_key: "lin_api_key",
               request_fun: fn payload, headers ->
                 send(test_pid, {:linear_request, payload, headers})

                 {:ok,
                  %{
                    status: 200,
                    body: %{
                      "data" => %{
                        "issueCreate" => %{
                          "success" => true,
                          "issue" => %{"id" => "issue-1", "title" => "Plan rollout"}
                        }
                      }
                    }
                  }}
               end
             )

    assert_received {:linear_request,
                     %{
                       "operationName" => "SymphonyPlannerLinearIssueCreate",
                       "query" => query,
                       "variables" => %{"input" => %{"teamId" => "team-1", "title" => "Plan rollout"}}
                     }, headers}

    assert query =~ "issueCreate"
    assert {"Authorization", "lin_api_key"} in headers
  end

  test "update_issue constructs the planner Linear GraphQL request" do
    test_pid = self()

    assert {:ok, %{"id" => "issue-1", "title" => "Updated"}} =
             Client.update_issue(
               "issue-1",
               %{"title" => "Updated"},
               api_key: "lin_api_key",
               request_fun: fn payload, headers ->
                 send(test_pid, {:linear_request, payload, headers})

                 {:ok,
                  %{
                    status: 200,
                    body: %{
                      "data" => %{
                        "issueUpdate" => %{
                          "success" => true,
                          "issue" => %{"id" => "issue-1", "title" => "Updated"}
                        }
                      }
                    }
                  }}
               end
             )

    assert_received {:linear_request,
                     %{
                       "operationName" => "SymphonyPlannerLinearIssueUpdate",
                       "query" => query,
                       "variables" => %{"id" => "issue-1", "input" => %{"title" => "Updated"}}
                     }, headers}

    assert query =~ "issueUpdate"
    assert {"Authorization", "lin_api_key"} in headers
  end
end
