defmodule SymphonyElixir.WorkspaceDispatchAndLinearTest do
  use SymphonyElixir.TestSupport

  test "linear issue helpers" do
    issue = %WorkItem{
      id: "abc",
      labels: ["frontend", "infra"],
      assigned_to_worker: false
    }

    assert WorkItem.label_names(issue) == ["frontend", "infra"]
    assert issue.labels == ["frontend", "infra"]
    refute issue.assigned_to_worker
  end

  test "linear client normalizes blockers from inverse relations" do
    raw_issue = %{
      "id" => "issue-1",
      "identifier" => "MT-1",
      "title" => "Blocked todo",
      "description" => "Needs dependency",
      "priority" => 2,
      "state" => %{"name" => "Todo"},
      "branchName" => "mt-1",
      "url" => "https://example.org/issues/MT-1",
      "assignee" => %{
        "id" => "user-1"
      },
      "labels" => %{"nodes" => [%{"name" => "Backend"}]},
      "inverseRelations" => %{
        "nodes" => [
          %{
            "type" => "blocks",
            "issue" => %{
              "id" => "issue-2",
              "identifier" => "MT-2",
              "state" => %{"name" => "In Progress"}
            }
          },
          %{
            "type" => "relatesTo",
            "issue" => %{
              "id" => "issue-3",
              "identifier" => "MT-3",
              "state" => %{"name" => "Done"}
            }
          }
        ]
      },
      "createdAt" => "2026-01-01T00:00:00Z",
      "updatedAt" => "2026-01-02T00:00:00Z"
    }

    issue = Client.normalize_issue_for_test(raw_issue, "user-1")

    assert issue.metadata.blocked_by == [%{id: "issue-2", identifier: "MT-2", state: "In Progress"}]
    assert issue.labels == ["backend"]
    assert issue.priority == "2"
    assert issue.state == "Todo"
    assert issue.metadata.assignee_id == "user-1"
    assert issue.assigned_to_worker
  end

  test "linear client marks explicitly unassigned issues as not routed to worker" do
    raw_issue = %{
      "id" => "issue-99",
      "identifier" => "MT-99",
      "title" => "Someone else's task",
      "state" => %{"name" => "Todo"},
      "assignee" => %{
        "id" => "user-2"
      }
    }

    issue = Client.normalize_issue_for_test(raw_issue, "user-1")

    refute issue.assigned_to_worker
  end

  test "linear client pagination merge helper preserves issue ordering" do
    issue_page_1 = [
      %WorkItem{id: "issue-1", identifier: "MT-1"},
      %WorkItem{id: "issue-2", identifier: "MT-2"}
    ]

    issue_page_2 = [
      %WorkItem{id: "issue-3", identifier: "MT-3"}
    ]

    merged = Client.merge_issue_pages_for_test([issue_page_1, issue_page_2])

    assert Enum.map(merged, & &1.identifier) == ["MT-1", "MT-2", "MT-3"]
  end

  test "linear client paginates issue state fetches by id beyond one page" do
    issue_ids = Enum.map(1..55, &"issue-#{&1}")
    first_batch_ids = Enum.take(issue_ids, 50)
    second_batch_ids = Enum.drop(issue_ids, 50)

    raw_issue = fn issue_id ->
      suffix = String.replace_prefix(issue_id, "issue-", "")

      %{
        "id" => issue_id,
        "identifier" => "MT-#{suffix}",
        "title" => "Issue #{suffix}",
        "description" => "Description #{suffix}",
        "state" => %{"name" => "In Progress"},
        "labels" => %{"nodes" => []},
        "inverseRelations" => %{"nodes" => []}
      }
    end

    graphql_fun = fn query, variables ->
      send(self(), {:fetch_issue_states_page, query, variables})

      body = %{
        "data" => %{
          "issues" => %{
            "nodes" => Enum.map(variables.ids, raw_issue)
          }
        }
      }

      {:ok, body}
    end

    assert {:ok, issues} = Client.fetch_issue_states_by_ids_for_test(issue_ids, graphql_fun)

    assert Enum.map(issues, & &1.id) == issue_ids

    assert_receive {:fetch_issue_states_page, query, %{ids: ^first_batch_ids, first: 50, relationFirst: 50}}
    assert query =~ "SymphonyLinearIssuesById"

    assert_receive {:fetch_issue_states_page, ^query, %{ids: ^second_batch_ids, first: 5, relationFirst: 50}}
  end

  test "linear client logs response bodies for non-200 graphql responses" do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, {:linear_api_status, 400}} =
                 Client.graphql(
                   "query Viewer { viewer { id } }",
                   %{},
                   request_fun: fn _payload, _headers ->
                     {:ok,
                      %{
                        status: 400,
                        body: %{
                          "errors" => [
                            %{
                              "message" => "Variable \"$ids\" got invalid value",
                              "extensions" => %{"code" => "BAD_USER_INPUT"}
                            }
                          ]
                        }
                      }}
                   end
                 )
      end)

    assert log =~ "Linear GraphQL request failed status=400"
    assert log =~ ~s(body=%{"errors" => [%{"extensions" => %{"code" => "BAD_USER_INPUT"})
    assert log =~ "Variable \\\"$ids\\\" got invalid value"
  end

  test "orchestrator sorts dispatch by priority then oldest created_at" do
    issue_same_priority_older = %WorkItem{
      id: "issue-old-high",
      identifier: "MT-200",
      title: "Old high priority",
      state: "Todo",
      priority: 1,
      created_at: ~U[2026-01-01 00:00:00Z]
    }

    issue_same_priority_newer = %WorkItem{
      id: "issue-new-high",
      identifier: "MT-201",
      title: "New high priority",
      state: "Todo",
      priority: 1,
      created_at: ~U[2026-01-02 00:00:00Z]
    }

    issue_lower_priority_older = %WorkItem{
      id: "issue-old-low",
      identifier: "MT-199",
      title: "Old lower priority",
      state: "Todo",
      priority: 2,
      created_at: ~U[2025-12-01 00:00:00Z]
    }

    sorted =
      Orchestrator.DispatchPolicy.sort_issues_for_dispatch([
        issue_lower_priority_older,
        issue_same_priority_newer,
        issue_same_priority_older
      ])

    assert Enum.map(sorted, & &1.identifier) == ["MT-200", "MT-201", "MT-199"]
  end

  test "todo issue with non-terminal blocker is not dispatch-eligible" do
    state = dispatch_state()

    issue = %WorkItem{
      id: "blocked-1",
      identifier: "MT-1001",
      title: "Blocked work",
      state: "Todo",
      metadata: %{blocked_by: [%{id: "blocker-1", identifier: "MT-1002", state: "In Progress"}]}
    }

    refute Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "issue assigned to another worker is not dispatch-eligible" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_assignee: "dev@example.com")

    state = dispatch_state()

    issue = %WorkItem{
      id: "assigned-away-1",
      identifier: "MT-1007",
      title: "Owned elsewhere",
      state: "Todo",
      assigned_to_worker: false
    }

    refute Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "todo issue with terminal blockers remains dispatch-eligible" do
    state = dispatch_state()

    issue = %WorkItem{
      id: "ready-1",
      identifier: "MT-1003",
      title: "Ready work",
      state: "Todo",
      metadata: %{blocked_by: [%{id: "blocker-2", identifier: "MT-1004", state: "Closed"}]}
    }

    assert Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "effective dispatch cap uses the minimum of workflow and workspace caps" do
    state = dispatch_state(max_concurrent_agents: 5, workspace_max_concurrent_agents: 2, workspace_active_agents_count: 1, running: %{"running-1" => %{}})

    assert Orchestrator.DispatchPolicy.effective_global_cap(state) == 2
    assert Orchestrator.DispatchPolicy.available_slots(state) == 1
  end

  test "workspace capacity full returns structured skip reason and leaves candidate ineligible" do
    state = dispatch_state(max_concurrent_agents: 5, workspace_max_concurrent_agents: 2, workspace_active_agents_count: 2, running: %{"running-1" => %{}})

    issue = %WorkItem{id: "ready-2", identifier: "MT-1008", title: "Ready work", state: "Todo"}

    assert Orchestrator.DispatchPolicy.capacity_skip_reason(issue, state) == :workspace_capacity_full
    refute Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "release below workspace cap allows a later dispatch" do
    state = dispatch_state(max_concurrent_agents: 5, workspace_max_concurrent_agents: 2, workspace_active_agents_count: 1, running: %{"running-1" => %{}})

    issue = %WorkItem{id: "ready-3", identifier: "MT-1009", title: "Ready work", state: "Todo"}

    assert Orchestrator.DispatchPolicy.capacity_skip_reason(issue, state) == nil
    assert Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "lowering workspace cap below active count does not make existing running state terminal" do
    state =
      dispatch_state(
        max_concurrent_agents: 5,
        workspace_max_concurrent_agents: 1,
        workspace_active_agents_count: 1,
        running: %{
          "running-1" => %{issue: %WorkItem{id: "running-1", identifier: "MT-1010", state: "In Progress"}}
        },
        claimed: MapSet.new(["running-1"])
      )

    issue = %WorkItem{id: "running-1", identifier: "MT-1010", title: "Running work", state: "In Progress"}

    assert %{running: %{"running-1" => _}} = Orchestrator.reconcile_issue_states_for_test([issue], state)
  end

  test "workspace dispatch cap uses shared launcher running count instead of local running map" do
    state = dispatch_state(max_concurrent_agents: 5, workspace_max_concurrent_agents: 2, workspace_active_agents_count: 2, running: %{"running-1" => %{}})

    issue = %WorkItem{id: "ready-4", identifier: "MT-1011", title: "Ready work", state: "Todo"}

    assert Orchestrator.DispatchPolicy.available_slots(state) == 0
    assert Orchestrator.DispatchPolicy.capacity_skip_reason(issue, state) == :workspace_capacity_full
    refute Orchestrator.DispatchPolicy.dispatch_eligible?(issue, state)
  end

  test "dispatch revalidation skips stale todo issue once a non-terminal blocker appears" do
    stale_issue = %WorkItem{
      id: "blocked-2",
      identifier: "MT-1005",
      title: "Stale blocked work",
      state: "Todo",
      metadata: %{blocked_by: []}
    }

    refreshed_issue = %WorkItem{
      id: "blocked-2",
      identifier: "MT-1005",
      title: "Stale blocked work",
      state: "Todo",
      metadata: %{blocked_by: [%{id: "blocker-3", identifier: "MT-1006", state: "In Progress"}]}
    }

    fetcher = fn ["blocked-2"] -> {:ok, [refreshed_issue]} end

    assert {:skip, %WorkItem{} = skipped_issue} =
             Orchestrator.DispatchPolicy.revalidate_issue_for_dispatch(stale_issue, fetcher)

    assert skipped_issue.identifier == "MT-1005"
    assert skipped_issue.metadata.blocked_by == [%{id: "blocker-3", identifier: "MT-1006", state: "In Progress"}]
  end

  defp dispatch_state(overrides \\ []) do
    struct!(
      Orchestrator.State,
      Keyword.merge(
        [
          max_concurrent_agents: 3,
          workspace_max_concurrent_agents: nil,
          workspace_active_agents_count: 0,
          running: %{},
          claimed: MapSet.new(),
          codex_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
          retry_attempts: %{}
        ],
        overrides
      )
    )
  end
end
