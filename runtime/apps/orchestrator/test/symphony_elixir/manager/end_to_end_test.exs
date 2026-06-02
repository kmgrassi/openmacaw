defmodule SymphonyElixir.Manager.EndToEndTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Manager.Scheduler
  alias SymphonyElixir.Manager.WorkItemRow

  @moduletag :integration

  defmodule TestWorkItemSource do
    alias SymphonyElixir.Manager.WorkItemRow

    def due_work_items(workspace_id, agent_id, now, opts) do
      send(test_pid(), {:due_query, {workspace_id, agent_id, now, opts}})

      rows =
        :symphony_elixir
        |> Application.fetch_env!(:manager_e2e_rows)
        |> Enum.map(&WorkItemRow.to_work_item/1)

      {:ok, rows}
    end

    defp test_pid, do: Application.fetch_env!(:symphony_elixir, :manager_e2e_test_pid)
  end

  defmodule TestChatGateway do
    def post_message(scope, body, opts) do
      send(test_pid(), {:manager_chat_posted, scope, body, opts})
      {:ok, Keyword.fetch!(opts, :run_id)}
    end

    defp test_pid, do: Application.fetch_env!(:symphony_elixir, :manager_e2e_test_pid)
  end

  setup do
    registry = :"manager_e2e_registry_#{System.unique_integer([:positive])}"
    workspace_id = "00000000-0000-0000-0000-000000000111"
    work_item_id = "00000000-0000-0000-0000-000000000001"
    now = ~U[2026-04-25 12:00:00Z]

    Application.put_env(:symphony_elixir, :manager_e2e_test_pid, self())

    Application.put_env(:symphony_elixir, :manager_e2e_rows, [
      %WorkItemRow{
        id: work_item_id,
        identifier: "PR-9",
        title: "Address requested review changes",
        state: "running",
        workspace_id: workspace_id,
        next_poll_at: DateTime.add(now, -5, :second),
        metadata: %{
          "kind" => "code",
          "runner_type" => "manager",
          "url" => "https://github.com/test-org/test-repo/pull/123",
          "agent_default_assignments" => []
        }
      }
    ])

    start_supervised!({Registry, keys: :unique, name: registry})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_e2e_test_pid)
      Application.delete_env(:symphony_elixir, :manager_e2e_rows)
    end)

    %{registry: registry, workspace_id: workspace_id, work_item_id: work_item_id, now: now}
  end

  test "scheduler tick dispatches Codex to address requested PR review changes without manager assignment",
       %{
         registry: registry,
         workspace_id: workspace_id,
         work_item_id: work_item_id,
         now: now
       } do
    session = %{
      workspace_id: workspace_id,
      agent_id: "manager-agent-1",
      runner: SymphonyElixir.Runner.LlmToolRunner,
      credential_id: "credential-manager",
      session_key: "agent:manager-agent-1:main",
      gateway_config: %{
        "runners" => %{
          "manager" => %{"model" => "gpt-5.4", "min_cadence_ms" => 60_000},
          "codex" => %{"agent_id" => "agent-codex"}
        }
      }
    }

    {:ok, pid} =
      Scheduler.start_link(workspace_id, "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: session,
        clock: fn -> now end,
        schedule_first_tick: false
      )

    assert %{last_decision_count: 1, batch: %{total: 1, ok: 1, error: 0}} = Scheduler.tick(pid)

    assert_receive {:due_query, {^workspace_id, "manager-agent-1", ^now, opts}}
    assert Keyword.fetch!(opts, :limit) == 25

    assert_receive {:manager_chat_posted, %{agent_id: "manager-agent-1"}, body, opts}
    assert %{"due_tasks" => [work_item]} = Jason.decode!(body)
    assert work_item["id"] == work_item_id
    assert work_item["url"] == "https://github.com/test-org/test-repo/pull/123"
    assert opts[:metadata]["source"] == "manager_scheduler"
    assert opts[:metadata]["kind"] == "due_tasks"
    assert opts[:metadata]["work_item_ids"] == [work_item_id]

    refute_received {:agent_default_assignment, _}

    assert %{
             workspace_id: ^workspace_id,
             status: :running,
             last_tick_at: ^now,
             last_decision_count: 1
           } = Scheduler.status(pid)
  end
end
