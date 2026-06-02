defmodule SymphonyElixir.Manager.Workspaces.DatabaseTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Manager.Workspaces.Database

  setup do
    Application.put_env(:symphony_elixir, :manager_workspaces,
      endpoint: "https://test.supabase.co",
      api_key: "secret",
      table: "gateway_config"
    )

    Application.put_env(:symphony_elixir, :manager_workspaces_req_options, plug: {Req.Test, __MODULE__})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_workspaces)
      Application.delete_env(:symphony_elixir, :manager_workspaces_req_options)
    end)

    :ok
  end

  test "lists workspace gateway_config rows that enable the manager runner" do
    Req.Test.stub(__MODULE__, fn conn ->
      params = URI.decode_query(conn.query_string)

      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/gateway_config"
      assert params["select"] == "scope_id,config_json"
      assert params["scope_type"] == "eq.workspace"

      rows = [
        %{"scope_id" => "workspace-a", "config_json" => %{"runners" => %{"manager" => %{"model" => "gpt-5"}}}},
        %{"scope_id" => "workspace-b", "config_json" => %{"runners" => %{"manager" => false}}},
        %{"scope_id" => "workspace-c", "config_json" => %{"runners" => %{"codex" => %{}}}},
        %{"scope_id" => "workspace-a", "config_json" => %{"runners" => %{"manager" => %{"model" => "gpt-5"}}}}
      ]

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(rows))
    end)

    log =
      capture_log([level: :debug], fn ->
        assert {:ok, ["workspace-a"]} = Database.list_active_workspace_ids()
      end)

    assert log =~ ~s("caller":"manager.workspaces.list_active_workspace_ids")
    assert log =~ ~s("table":"gateway_config")
  end
end
