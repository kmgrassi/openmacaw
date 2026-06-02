defmodule SymphonyElixirWeb.GatewaySocket.ConnectionMetadataTest do
  use ExUnit.Case, async: true

  alias SymphonyElixirWeb.GatewaySocket.ConnectionMetadata

  describe "scope_from_query/1" do
    test "builds scoped metadata with the shared agent session key" do
      assert %{
               agent_id: "agent-1",
               workspace_id: "workspace-1",
               user_id: "user-1",
               session_key: "workspace-1:agent-1"
             } =
               ConnectionMetadata.scope_from_query(%{
                 "agent_id" => "agent-1",
                 "workspace_id" => "workspace-1",
                 "user_id" => "user-1"
               })
    end

    test "ignores explicit client session keys for shared chat partitioning" do
      assert %{session_key: "workspace-1:agent-1"} =
               ConnectionMetadata.scope_from_query(%{
                 "agent_id" => "agent-1",
                 "workspace_id" => "workspace-1",
                 "user_id" => "user-1",
                 "session_key" => "session-123"
               })
    end

    test "rejects missing or blank scope members" do
      assert nil ==
               ConnectionMetadata.scope_from_query(%{
                 "agent_id" => "agent-1",
                 "workspace_id" => "workspace-1"
               })

      assert nil ==
               ConnectionMetadata.scope_from_query(%{
                 "agent_id" => "agent-1",
                 "workspace_id" => "workspace-1",
                 "user_id" => " "
               })
    end
  end

  describe "connection_id_from/2" do
    test "prefers query params over request headers" do
      assert "conn-from-query" ==
               ConnectionMetadata.connection_id_from(
                 %{"connection_id" => "conn-from-query"},
                 %{"x-connection-id" => "conn-from-header"}
               )
    end

    test "accepts the legacy conn_id query alias" do
      assert "conn-from-alias" ==
               ConnectionMetadata.connection_id_from(
                 %{"conn_id" => "conn-from-alias"},
                 %{}
               )
    end

    test "falls back to a generated id when neither source is present" do
      generated = ConnectionMetadata.connection_id_from(%{}, %{})

      assert is_binary(generated)
      refute generated == ""
    end
  end

  describe "close_fields/2" do
    test "marks abnormal closes with an error code" do
      assert %{
               close_code: 1001,
               close_reason: "{:remote, 1001, \"going away\"}",
               error_code: "gateway_ws_closed_abnormally",
               protocol_version: 3
             } = ConnectionMetadata.close_fields({:remote, 1001, "going away"}, 3)
    end

    test "treats normal close tuples as non-errors" do
      assert %{close_code: 1000, error_code: nil, protocol_version: 3} =
               ConnectionMetadata.close_fields(
                 {:remote, 1000, "normal", %{adapter: :websock}},
                 3
               )
    end
  end
end
