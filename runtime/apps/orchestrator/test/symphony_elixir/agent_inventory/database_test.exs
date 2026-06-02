defmodule SymphonyElixir.AgentInventory.DatabaseTest do
  use SymphonyElixir.TestSupport, async: false
  import ExUnit.CaptureLog

  alias SymphonyElixir.AgentInventory.{Database, StoredCredential}
  alias SymphonyElixir.SupabaseSchema

  setup do
    put_app_envs(:symphony_elixir,
      agent_inventory_req_options: [plug: {Req.Test, Database}],
      agent_inventory: [
        endpoint: "https://test.supabase.co/rest/v1",
        api_key: "test-api-key",
        table: "agent",
        credential_table: "credential"
      ]
    )

    :ok
  end

  test "list_agents returns mapped agent records" do
    agent_rows = [
      agent_row(%{
        "id" => "agent-1",
        "name" => "Builder",
        "workspace_id" => "workspace-1",
        "project_id" => "project-1",
        "status" => "ready",
        "model_settings" => %{"primary" => "openai/gpt-5"},
        "tool_policy" => %{"mode" => "default"}
      })
    ]

    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path in ["/rest/v1/agent", "/rest/v1/credential"]

      params = URI.decode_query(conn.query_string)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            assert params["select"] == SupabaseSchema.select_columns!("agent")
            agent_rows
          else
            assert params["select"] == SupabaseSchema.select_columns!("credential", ["workspace_id"])
            assert params["workspace_id"] == "in.(workspace-1)"
            [%{"workspace_id" => "workspace-1"}]
          end
        )
      )
    end)

    log =
      capture_log([level: :debug], fn ->
        assert {:ok, [agent]} = Database.list_agents()
        assert agent.id == "agent-1"
        assert agent.model_settings == %{"primary" => "openai/gpt-5"}
        assert agent.workspace_id == "workspace-1"
        assert agent.type == "coding"
        assert agent.has_credentials == true
      end)

    assert log =~ ~s("caller":"agent_inventory.list_agents")
    assert log =~ ~s("caller":"agent_inventory.credential_workspace_ids")
  end

  test "list_agents preserves false boolean fields from Supabase rows" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path in ["/rest/v1/agent", "/rest/v1/credential"]

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            [
              agent_row(%{
                "id" => "agent-1",
                "name" => "Builder",
                "workspace_id" => "workspace-1",
                "status" => "ready",
                "is_active" => false,
                "model_settings" => %{},
                "tool_policy" => %{}
              })
            ]
          else
            []
          end
        )
      )
    end)

    assert {:ok, [agent]} = Database.list_agents()
    assert agent.is_active == false
  end

  test "get_agent returns not_found when the row is missing" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:error, :not_found} = Database.get_agent("missing-agent")
  end

  test "get_agent returns a config error instead of crashing when Supabase is not configured" do
    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")

    Application.delete_env(:symphony_elixir, :agent_inventory)
    System.delete_env("SUPABASE_URL")
    System.delete_env("SUPABASE_SERVICE_ROLE_KEY")

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
    end)

    assert {:error, {:missing_supabase_config, message}} = Database.get_agent("agent-1")
    assert message =~ "Supabase PostgREST endpoint is not configured"
  end

  test "list_agents returns a config error when table is not a string" do
    Application.put_env(:symphony_elixir, :agent_inventory,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: :agent,
      credential_table: "credential"
    )

    assert {:error, {:invalid_agent_inventory_config, message}} = Database.list_agents()
    assert message =~ "table must be a non-empty string"
    assert message =~ ":agent"
  end

  test "list_credentials returns a config error when credential_table is not a string" do
    Application.put_env(:symphony_elixir, :agent_inventory,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: "agent",
      credential_table: nil
    )

    assert {:error, {:invalid_agent_inventory_config, message}} = Database.list_credentials("agent-1")
    assert message =~ "credential_table must be a non-empty string"
    assert message =~ "nil"
  end

  test "list_credentials returns redacted launchable credentials" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      params = URI.decode_query(conn.query_string)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            assert params["select"] == SupabaseSchema.select_columns!("agent", ["workspace_id"])
            assert params["id"] == "eq.agent-1"
            [agent_row(%{"id" => "agent-1", "workspace_id" => "workspace-1"})]
          else
            assert conn.request_path == "/rest/v1/credential"
            assert params["select"] == SupabaseSchema.select_columns!("credential")
            assert params["workspace_id"] == "eq.workspace-1"

            [
              credential_row(%{
                "id" => "cred-1",
                "workspace_id" => "workspace-1",
                "updated_at" => "2026-04-14T00:00:00Z",
                "key_value" => %{"OPENAI_API_KEY" => "sk-test", "key_last4" => "1234"}
              })
            ]
          end
        )
      )
    end)

    assert {:ok, [credential]} = Database.list_credentials("agent-1")
    assert credential.agent_id == "agent-1"
    assert credential.env_var == "OPENAI_API_KEY"
    assert credential.launchable_kind == "codex"
    assert credential.has_secret == true
    assert credential.secret_value == "sk-test"
    assert credential.aliases == ["OPENAI_API_KEY", "openai_api_key", "api_key"]
    refute Map.has_key?(StoredCredential.to_public_map(credential), :secret_value)
  end

  test "list_credentials returns ChatGPT OAuth credential as launchable codex" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            [agent_row(%{"id" => "agent-1", "workspace_id" => "workspace-1"})]
          else
            assert conn.request_path == "/rest/v1/credential"

            [
              credential_row(%{
                "id" => "cred-oauth",
                "workspace_id" => "workspace-1",
                "updated_at" => "2026-05-13T00:00:00Z",
                "key_value" => %{
                  "provider" => "openai_codex",
                  "access_token" => "eyJaccess",
                  "refresh_token" => "eyJrefresh",
                  "expires_at" => 1_900_000_000_000,
                  "email" => "kg@example.com",
                  "plan_type" => "pro",
                  "key_last4" => "cess"
                }
              })
            ]
          end
        )
      )
    end)

    assert {:ok, [credential]} = Database.list_credentials("agent-1")
    assert credential.provider == "openai_codex"
    assert credential.env_var == "OPENAI_API_KEY"
    assert credential.launchable_kind == "codex"
    assert credential.has_secret == true
    assert credential.secret_value == "eyJaccess"
    assert credential.aliases == ["access_token"]
    assert credential.label == "ChatGPT (kg@example.com, pro)"
  end

  test "list_credentials returns ChatGPT OAuth credential when tokens are in a secret_ref" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            [agent_row(%{"id" => "agent-1", "workspace_id" => "workspace-1"})]
          else
            assert conn.request_path == "/rest/v1/credential"

            [
              credential_row(%{
                "id" => "cred-oauth-secret",
                "workspace_id" => "workspace-1",
                "updated_at" => "2026-05-13T00:00:00Z",
                "key_value" => %{
                  "provider" => "openai_codex",
                  "secret_ref" => "vault://chatgpt/agent-1",
                  "email" => "kg@example.com"
                }
              })
            ]
          end
        )
      )
    end)

    assert {:ok, [credential]} = Database.list_credentials("agent-1")
    assert credential.provider == "openai_codex"
    assert credential.env_var == "OPENAI_API_KEY"
    assert credential.launchable_kind == "codex"
    assert credential.has_secret == true
    assert credential.secret_value == nil
    assert credential.secret_ref == "vault://chatgpt/agent-1"
    assert credential.aliases == ["access_token"]
  end

  test "list_credentials accepts null key_value for nullable json columns" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            [agent_row(%{"id" => "agent-1", "workspace_id" => "workspace-1"})]
          else
            assert conn.request_path == "/rest/v1/credential"

            [
              credential_row(%{
                "id" => "cred-1",
                "workspace_id" => "workspace-1",
                "key_value" => nil
              })
            ]
          end
        )
      )
    end)

    assert {:ok, []} = Database.list_credentials("agent-1")
  end

  test "list_agents rejects rows that drift from the canonical Supabase types" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(
          if conn.request_path == "/rest/v1/agent" do
            [agent_row(%{"status" => 123})]
          else
            []
          end
        )
      )
    end)

    assert {:error, {:invalid_column_type, "agent", "status", ["string"], 123}} = Database.list_agents()
  end

  test "credential lookup follows the generated workspace-scoped schema" do
    assert SupabaseSchema.column?("credential", "agent_id")
    assert SupabaseSchema.column?("credential", "workspace_id")
    assert SupabaseSchema.select_columns!("credential", ["workspace_id"]) == "workspace_id"
  end

  defp agent_row(overrides) do
    Map.merge(
      %{
        "assistant_id" => nil,
        "context" => nil,
        "created_at" => "2026-04-14T00:00:00Z",
        "created_by_user_id" => nil,
        "current_version" => nil,
        "description" => nil,
        "draft_version" => nil,
        "execution_target_kind" => "codex",
        "id" => "agent-default",
        "is_active" => true,
        "model_settings" => %{},
        "name" => "Default Agent",
        "project_id" => nil,
        "session_id" => nil,
        "slug" => nil,
        "status" => "ready",
        "tool_policy" => %{},
        "type" => nil,
        "updated_at" => "2026-04-14T00:00:00Z",
        "vector_store_id" => nil,
        "workspace_id" => "workspace-default"
      },
      overrides
    )
  end

  defp credential_row(overrides) do
    Map.merge(
      %{
        "agent_id" => nil,
        "created_at" => "2026-04-14T00:00:00Z",
        "display_name" => "Default credential",
        "format" => "env",
        "id" => "cred-default",
        "key_value" => nil,
        "kind" => "api_key",
        "provider" => "openai",
        "updated_at" => "2026-04-14T00:00:00Z",
        "validated_at" => nil,
        "validation_state" => "valid",
        "user_id" => nil,
        "workspace_id" => "workspace-default"
      },
      overrides
    )
  end
end
