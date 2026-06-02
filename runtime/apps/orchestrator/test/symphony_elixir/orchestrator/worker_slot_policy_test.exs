defmodule SymphonyElixir.Orchestrator.WorkerSlotPolicyTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Orchestrator.WorkerSlotPolicy
  alias SymphonyElixir.Orchestrator.WorkerSlotPolicy.{Request, Slot}
  alias SymphonyElixir.Orchestrator.WorkerSlotReservations
  alias SymphonyElixir.Orchestrator.WorkerSlotReservations.Reservation

  describe "reusable?/2" do
    test "denies reuse across workspace boundaries" do
      slot = slot(workspace_id: "workspace-a")
      request = request(workspace_id: "workspace-b")

      assert WorkerSlotPolicy.reusable?(slot, request) == {:error, :workspace_boundary_mismatch}
    end

    test "denies reuse across customer boundaries" do
      slot = slot(customer_id: "customer-a")
      request = request(customer_id: "customer-b")

      assert WorkerSlotPolicy.reusable?(slot, request) == {:error, :customer_boundary_mismatch}
    end

    test "denies reuse for unsupported runner kinds" do
      slot = slot(runner_kinds: ["codex"])
      request = request(runner_kind: "planner")

      assert WorkerSlotPolicy.reusable?(slot, request) == {:error, :runner_not_supported_on_warm_slot}
    end

    test "denies reuse when required credentials or resources are missing" do
      request =
        request(
          required_credential_ids: ["credential-a"],
          required_resource_ids: ["repo-a"]
        )

      assert WorkerSlotPolicy.reusable?(slot(credential_ids: [], resource_ids: ["repo-a"]), request) ==
               {:error, :missing_required_credentials}

      assert WorkerSlotPolicy.reusable?(slot(credential_ids: ["credential-a"], resource_ids: []), request) ==
               {:error, :missing_required_resources}
    end

    test "denies reuse without disk or active session capacity" do
      request = request()

      assert WorkerSlotPolicy.reusable?(
               slot(available_disk_bytes: 512, min_available_disk_bytes: 1_024),
               request
             ) == {:error, :insufficient_disk_capacity}

      assert WorkerSlotPolicy.reusable?(
               slot(active_session_count: 2, max_active_session_count: 2),
               request
             ) == {:error, :warm_repo_slot_full}
    end

    test "allows reuse when all gates pass" do
      assert :ok =
               WorkerSlotPolicy.reusable?(
                 slot(
                   workspace_id: "workspace-a",
                   customer_id: "customer-a",
                   runner_kinds: ["codex"],
                   credential_ids: ["credential-a"],
                   resource_ids: ["repo-a"],
                   active_session_count: 1,
                   max_active_session_count: 2
                 ),
                 request(
                   workspace_id: "workspace-a",
                   customer_id: "customer-a",
                   runner_kind: "codex",
                   required_credential_ids: ["credential-a"],
                   required_resource_ids: ["repo-a"]
                 )
               )
    end
  end

  describe "WorkerSlotReservations" do
    setup do
      registry_name = :"worker-slot-reservations-#{System.unique_integer([:positive])}"
      start_supervised!({WorkerSlotReservations, name: registry_name})
      {:ok, registry: registry_name}
    end

    test "prevents duplicate assignment under concurrent dispatch", %{registry: registry} do
      slot = slot(active_session_count: 0, max_active_session_count: 1)
      request = request(workspace_id: "workspace-a", runner_kind: "codex")
      parent = self()

      contenders =
        Enum.map(1..2, fn index ->
          Task.async(fn ->
            send(parent, {:ready, index, self()})

            receive do
              :go -> WorkerSlotReservations.reserve(registry, slot, request, {:dispatcher, index})
            end
          end)
        end)

      for _ <- 1..2 do
        assert_receive {:ready, _index, pid}
        send(pid, :go)
      end

      results = Enum.map(contenders, &Task.await(&1, 1_000))

      assert Enum.count(results, &match?({:ok, %Reservation{}}, &1)) == 1
      assert Enum.count(results, &match?({:error, :warm_repo_slot_full}, &1)) == 1
    end

    test "denies reservation when an existing reservation is for another workspace", %{registry: registry} do
      slot = slot(max_active_session_count: 2)

      assert {:ok, %Reservation{}} =
               WorkerSlotReservations.reserve(
                 registry,
                 slot,
                 request(workspace_id: "workspace-a"),
                 :dispatcher_a
               )

      assert {:error, :workspace_boundary_mismatch} =
               WorkerSlotReservations.reserve(
                 registry,
                 slot,
                 request(workspace_id: "workspace-b"),
                 :dispatcher_b
               )
    end
  end

  defp slot(attrs) do
    attrs = Map.new(attrs)

    struct!(
      Slot,
      Map.merge(
        %{
          id: "worker_host:worker-a",
          runner_kinds: ["codex", "planner"],
          active_session_count: 0,
          max_active_session_count: 4,
          credential_ids: [],
          resource_ids: []
        },
        attrs
      )
    )
  end

  defp request(attrs \\ []) do
    attrs = Map.new(attrs)

    struct!(
      Request,
      Map.merge(
        %{
          runner_kind: "codex",
          required_credential_ids: [],
          required_resource_ids: []
        },
        attrs
      )
    )
  end
end
