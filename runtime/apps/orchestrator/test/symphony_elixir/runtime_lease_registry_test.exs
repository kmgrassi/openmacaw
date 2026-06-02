defmodule SymphonyElixir.RuntimeLease.RegistryTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.RuntimeLease.Registry
  alias SymphonyElixir.RuntimeLease.Registry.Lease

  setup do
    registry_name = :"runtime-lease-registry-#{System.unique_integer([:positive])}"
    start_supervised!({Registry, name: registry_name})
    {:ok, registry: registry_name}
  end

  test "stores run session cache and task lease metadata", %{registry: registry} do
    now = ~U[2026-05-19 12:00:00Z]

    assert {:ok,
            %Lease{
              id: "session-1",
              kind: "session",
              workspace_id: "workspace-1",
              agent_id: "agent-1",
              materialized_grant_versions: %{"grant-1" => 7}
            }} =
             Registry.upsert_lease(registry, %{
               id: "session-1",
               kind: "session",
               workspace_id: "workspace-1",
               agent_id: "agent-1",
               heartbeat_at: now,
               idle_expires_at: DateTime.add(now, 60_000, :millisecond),
               materialized_grant_versions: %{"grant-1" => 7}
             })

    assert {:ok, %Lease{id: "run-1", kind: "run"}} =
             Registry.upsert_lease(registry, %{id: "run-1", kind: "run"})

    assert {:ok, %Lease{id: "cache-1", kind: "cache"}} =
             Registry.upsert_lease(registry, %{id: "cache-1", kind: "cache"})

    assert {:ok, %Lease{id: "task-1", kind: "task", task_ref: "arn:aws:ecs:task/1"}} =
             Registry.upsert_lease(registry, %{
               id: "task-1",
               kind: "task",
               task_ref: "arn:aws:ecs:task/1"
             })

    assert ["cache", "run", "session", "task"] =
             registry
             |> Registry.list_leases()
             |> Enum.map(& &1.kind)
             |> Enum.sort()
  end

  test "heartbeat extends idle deadline and stale reaper preserves active leases", %{registry: registry} do
    started_at = ~U[2026-05-19 12:00:00Z]
    heartbeat_at = ~U[2026-05-19 12:00:30Z]
    before_deadline = ~U[2026-05-19 12:00:59Z]
    after_deadline = ~U[2026-05-19 12:01:31Z]

    assert {:ok, %Lease{}} =
             Registry.upsert_lease(registry, %{
               id: "session-active",
               kind: "session",
               heartbeat_at: started_at,
               idle_expires_at: DateTime.add(started_at, 60_000, :millisecond)
             })

    assert [] = Registry.reap_stale_leases(registry, now: before_deadline)

    assert {:ok, %Lease{idle_expires_at: extended}} =
             Registry.heartbeat(registry, "session-active",
               now: heartbeat_at,
               idle_timeout_ms: 60_000
             )

    assert DateTime.diff(extended, heartbeat_at, :millisecond) == 60_000
    assert [] = Registry.reap_stale_leases(registry, now: ~U[2026-05-19 12:01:29Z])
    assert [%Lease{id: "session-active", status: "stale"}] = Registry.reap_stale_leases(registry, now: after_deadline)
  end

  test "marks task leases missing from the active task list as orphaned", %{registry: registry} do
    assert {:ok, %Lease{}} =
             Registry.upsert_lease(registry, %{
               id: "task-1",
               kind: "task",
               task_ref: "arn:aws:ecs:task/1"
             })

    assert {:ok, %Lease{}} =
             Registry.upsert_lease(registry, %{
               id: "task-2",
               kind: "task",
               task_ref: "arn:aws:ecs:task/2"
             })

    assert [%Lease{id: "task-2", status: "orphaned"}] =
             Registry.mark_orphaned_tasks(registry, ["arn:aws:ecs:task/1"])

    assert {:ok, %Lease{status: "active"}} = Registry.get_lease(registry, "task-1")
    assert {:ok, %Lease{status: "orphaned"}} = Registry.get_lease(registry, "task-2")
  end
end
