defmodule SymphonyElixir.RepoCache.RegistryTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.RepoCache.Registry
  alias SymphonyElixir.RepoCache.Registry.{RefreshLease, Repository}

  setup do
    registry_name = :"repo-cache-registry-#{System.unique_integer([:positive])}"
    start_supervised!({Registry, name: registry_name})
    {:ok, registry: registry_name}
  end

  test "upsert_repository stores observable cache metadata", %{registry: registry} do
    fetched_at = ~U[2026-04-14 15:00:00Z]
    used_at = ~U[2026-04-14 15:01:00Z]

    assert {:ok,
            %Repository{
              repo_id: "repo-1",
              repo_url: "https://github.com/openai/example.git",
              cache_path: "/mnt/efs/symphony/repo-cache/repo-1",
              cache_kind: "mirror",
              last_fetched_at: ^fetched_at,
              last_used_at: ^used_at,
              cache_size_bytes: 1_024,
              active_session_count: 2,
              refresh_state: "ready",
              metadata: %{"branch" => "main"}
            }} =
             Registry.upsert_repository(registry, %{
               repo_id: "repo-1",
               repo_url: "https://github.com/openai/example.git",
               cache_path: "/mnt/efs/symphony/repo-cache/repo-1",
               cache_kind: "mirror",
               last_fetched_at: fetched_at,
               last_used_at: used_at,
               cache_size_bytes: 1_024,
               active_session_count: 2,
               refresh_state: "ready",
               metadata: %{"branch" => "main"}
             })

    assert {:ok, %Repository{repo_id: "repo-1"}} = Registry.get_repository(registry, "repo-1")
    assert [%Repository{repo_id: "repo-1"}] = Registry.list_repositories(registry)
  end

  test "upsert_repository normalizes string keyed metadata maps", %{registry: registry} do
    fetched_at = ~U[2026-04-14 15:05:00Z]

    assert {:ok,
            %Repository{
              repo_id: "repo-1b",
              repo_url: "https://github.com/openai/string-keys.git",
              cache_kind: "mirror",
              last_fetched_at: ^fetched_at,
              refresh_state: "ready"
            }} =
             Registry.upsert_repository(registry, %{
               "repo_id" => "repo-1b",
               "repo_url" => "https://github.com/openai/string-keys.git",
               "cache_kind" => "mirror",
               "last_fetched_at" => fetched_at,
               "refresh_state" => "ready"
             })
  end

  test "refresh lease acquire renew and release follow owner semantics", %{registry: registry} do
    acquired_at = ~U[2026-04-14 16:00:00Z]
    renewed_at = ~U[2026-04-14 16:00:30Z]

    assert {:ok,
            %RefreshLease{
              repo_id: "repo-2",
              lease_owner: "worker-a",
              lease_acquired_at: ^acquired_at
            } = lease} =
             Registry.acquire_refresh_lease(
               registry,
               "repo-2",
               "worker-a",
               ttl_ms: 60_000,
               now: acquired_at
             )

    assert DateTime.diff(lease.lease_expires_at, acquired_at, :millisecond) == 60_000

    assert {:error, {:lease_unavailable, %RefreshLease{lease_owner: "worker-a"}}} =
             Registry.acquire_refresh_lease(
               registry,
               "repo-2",
               "worker-b",
               ttl_ms: 60_000,
               now: acquired_at
             )

    assert {:ok, %RefreshLease{lease_owner: "worker-a"} = renewed} =
             Registry.renew_refresh_lease(
               registry,
               "repo-2",
               "worker-a",
               ttl_ms: 90_000,
               now: renewed_at
             )

    assert renewed.updated_at == renewed_at
    assert DateTime.diff(renewed.lease_expires_at, renewed_at, :millisecond) == 90_000

    assert :ok = Registry.release_refresh_lease(registry, "repo-2", "worker-a")
    assert :error = Registry.get_refresh_lease(registry, "repo-2")
    assert {:ok, %Repository{refresh_state: "idle"}} = Registry.get_repository(registry, "repo-2")
  end

  test "concurrent refresh attempts allow only one active writer", %{registry: registry} do
    parent = self()

    contenders =
      Enum.map(["worker-a", "worker-b"], fn worker ->
        Task.async(fn ->
          send(parent, {:ready, worker, self()})

          receive do
            :go ->
              Registry.acquire_refresh_lease(
                registry,
                "repo-3",
                worker,
                ttl_ms: 60_000,
                now: ~U[2026-04-14 17:00:00Z]
              )
          end
        end)
      end)

    for _ <- 1..2 do
      assert_receive {:ready, _worker, pid}
      send(pid, :go)
    end

    results = Enum.map(contenders, &Task.await(&1, 1_000))
    success_count = Enum.count(results, &match?({:ok, %RefreshLease{}}, &1))
    conflict_count = Enum.count(results, &match?({:error, {:lease_unavailable, %RefreshLease{}}}, &1))

    assert success_count == 1
    assert conflict_count == 1
    assert {:ok, %RefreshLease{repo_id: "repo-3"}} = Registry.get_refresh_lease(registry, "repo-3")
  end

  test "stale lease recovery expires dead owners and allows takeover", %{registry: registry} do
    acquired_at = ~U[2026-04-14 18:00:00Z]
    takeover_at = ~U[2026-04-14 18:10:00Z]

    assert {:ok, %RefreshLease{lease_owner: "worker-a"}} =
             Registry.acquire_refresh_lease(
               registry,
               "repo-4",
               "worker-a",
               ttl_ms: 30_000,
               now: acquired_at
             )

    assert [%RefreshLease{repo_id: "repo-4", lease_owner: "worker-a"}] =
             Registry.expire_stale_leases(registry, now: takeover_at)

    assert :error = Registry.get_refresh_lease(registry, "repo-4")
    assert {:ok, %Repository{refresh_state: "stale"}} = Registry.get_repository(registry, "repo-4")

    assert {:ok, %RefreshLease{lease_owner: "worker-b"}} =
             Registry.acquire_refresh_lease(
               registry,
               "repo-4",
               "worker-b",
               ttl_ms: 30_000,
               now: takeover_at
             )

    assert {:ok, %Repository{refresh_state: "leased"}} = Registry.get_repository(registry, "repo-4")
  end
end
