defmodule SymphonyElixir.Manager.WorkItems.DatabaseTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Manager.WorkItems.Database
  alias SymphonyElixir.WorkItem

  @workspace_id "00000000-0000-0000-0000-000000000111"
  @agent_id "00000000-0000-0000-0000-000000000100"
  @now ~U[2026-04-25 12:00:00Z]

  setup do
    Application.put_env(:symphony_elixir, Database,
      endpoint: "https://test.supabase.co",
      api_key: "secret",
      table: "work_items"
    )

    Application.put_env(:symphony_elixir, :manager_due_work_items_req_options,
      plug: {Req.Test, __MODULE__}
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, Database)
      Application.delete_env(:symphony_elixir, :manager_due_work_items_req_options)
    end)

    :ok
  end

  defp stub_get(assertions) when is_function(assertions, 1) do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/work_items"

      params = URI.decode_query(conn.query_string)

      assertions.(params)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([]))
    end)
  end

  test "filters by workspace and the manager_runner_id ownership or-clause" do
    stub_get(fn params ->
      assert params["workspace_id"] == "eq.#{@workspace_id}"
      assert params["or"] == "(manager_runner_id.is.null,manager_runner_id.eq.#{@agent_id})"
      assert params["next_poll_at"] == "lte.#{DateTime.to_iso8601(@now)}"
      assert params["order"] == "next_poll_at.asc"
      assert params["limit"] == "25"
      assert params["select"] =~ "id,identifier"
      refute Map.has_key?(params, "state")
      refute Map.has_key?(params, "plan_id")
    end)

    assert {:ok, []} = Database.due_work_items(@workspace_id, @agent_id, @now)
  end

  test "omits the manager_runner or-clause when agent_id is nil" do
    stub_get(fn params ->
      refute Map.has_key?(params, "or")
      assert params["workspace_id"] == "eq.#{@workspace_id}"
    end)

    assert {:ok, []} = Database.due_work_items(@workspace_id, nil, @now)
  end

  test "encodes plan_ids and states as PostgREST in.() filters" do
    plan_a = "00000000-0000-0000-0000-000000000010"
    plan_b = "00000000-0000-0000-0000-000000000020"

    stub_get(fn params ->
      assert params["state"] == "in.(running,awaiting_review)"
      assert params["plan_id"] == "in.(#{plan_a},#{plan_b})"
    end)

    assert {:ok, []} =
             Database.due_work_items(@workspace_id, @agent_id, @now,
               states: ["running", "awaiting_review"],
               plan_ids: [plan_a, plan_b]
             )
  end

  test "treats an empty plan_ids list as no plan filter (not filter-to-nothing)" do
    stub_get(fn params -> refute Map.has_key?(params, "plan_id") end)

    assert {:ok, []} =
             Database.due_work_items(@workspace_id, @agent_id, @now, plan_ids: [])
  end

  test "treats a nil plan_ids option as no plan filter" do
    stub_get(fn params -> refute Map.has_key?(params, "plan_id") end)

    assert {:ok, []} =
             Database.due_work_items(@workspace_id, @agent_id, @now, plan_ids: nil)
  end

  test "treats an empty states list as no state filter" do
    stub_get(fn params -> refute Map.has_key?(params, "state") end)

    assert {:ok, []} = Database.due_work_items(@workspace_id, @agent_id, @now, states: [])
  end

  test "passes through a custom limit and keeps the next_poll_at order asc" do
    stub_get(fn params ->
      assert params["limit"] == "7"
      assert params["order"] == "next_poll_at.asc"
    end)

    assert {:ok, []} =
             Database.due_work_items(@workspace_id, @agent_id, @now, limit: 7)
  end

  test "maps response rows into WorkItem structs and lifts url/runner_type from metadata" do
    row = %{
      "id" => "00000000-0000-0000-0000-000000000001",
      "identifier" => "WI-1",
      "title" => "Address review",
      "description" => "Review feedback",
      "priority" => "high",
      "state" => "running",
      "workspace_id" => @workspace_id,
      "plan_id" => "00000000-0000-0000-0000-000000000010",
      "task_id" => nil,
      "labels" => ["backend"],
      "metadata" => %{
        "url" => "https://example.test/pr/1",
        "runner_type" => "manager",
        "extra" => "preserved"
      },
      "next_poll_at" => "2026-04-25T11:59:00Z",
      "created_at" => "2026-04-25T10:00:00Z",
      "updated_at" => "2026-04-25T11:00:00Z"
    }

    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([row]))
    end)

    assert {:ok, [item]} = Database.due_work_items(@workspace_id, @agent_id, @now)

    assert %WorkItem{
             id: "00000000-0000-0000-0000-000000000001",
             identifier: "WI-1",
             title: "Address review",
             description: "Review feedback",
             priority: "high",
             state: "running",
             url: "https://example.test/pr/1",
             source: "database",
             runner_type: "manager",
             plan_id: "00000000-0000-0000-0000-000000000010",
             task_id: nil,
             labels: ["backend"]
           } = item

    assert item.metadata["extra"] == "preserved"
    assert item.created_at == ~U[2026-04-25 10:00:00Z]
    assert item.updated_at == ~U[2026-04-25 11:00:00Z]
  end

  test "handles missing metadata by defaulting to an empty map" do
    row = %{
      "id" => "00000000-0000-0000-0000-000000000002",
      "identifier" => "WI-2",
      "title" => "No metadata",
      "state" => "running",
      "workspace_id" => @workspace_id,
      "labels" => nil,
      "metadata" => nil,
      "created_at" => nil,
      "updated_at" => nil
    }

    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([row]))
    end)

    assert {:ok, [item]} = Database.due_work_items(@workspace_id, @agent_id, @now)
    assert item.metadata == %{}
    assert item.labels == []
    assert item.url == nil
    assert item.runner_type == nil
    assert item.created_at == nil
  end

  test "returns a {:missing_supabase_config, _} error when no endpoint is configured" do
    Application.delete_env(:symphony_elixir, Database)

    assert {:error, {:missing_supabase_config, message}} =
             Database.due_work_items(@workspace_id, @agent_id, @now)

    assert is_binary(message)
  end
end
