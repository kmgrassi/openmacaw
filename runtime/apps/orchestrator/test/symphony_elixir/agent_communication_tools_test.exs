defmodule SymphonyElixir.AgentCommunicationToolsTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.AgentCommunicationTools

  setup do
    Application.put_env(:symphony_elixir, :agent_control_plane,
      endpoint: "https://platform.test",
      api_key: "platform-secret"
    )

    Application.put_env(:symphony_elixir, :agent_control_plane_req_options,
      plug: {Req.Test, __MODULE__}
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_control_plane)
      Application.delete_env(:symphony_elixir, :agent_control_plane_req_options)
    end)

    :ok
  end

  test "tool_specs advertises message and remediation contracts" do
    assert Enum.map(AgentCommunicationTools.tool_specs(), & &1["name"]) == [
             "agent.message",
             "agent.remediate"
           ]

    message = Enum.find(AgentCommunicationTools.tool_specs(), &(&1["name"] == "agent.message"))
    assert message["inputSchema"]["required"] == ["target_agent_id", "body"]

    remediation =
      Enum.find(AgentCommunicationTools.tool_specs(), &(&1["name"] == "agent.remediate"))

    assert remediation["inputSchema"]["required"] == ["target_agent_id", "action"]

    assert remediation["inputSchema"]["properties"]["action"]["enum"] ==
             ~w(retry restart request_credentials request_user_input)
  end

  test "agent.message posts a structured handoff to the target agent API" do
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/api/agents/agent-target/messages"
      assert {"authorization", "Bearer platform-secret"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(parent, {:message_payload, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!(%{"id" => "msg-1"}))
    end)

    assert {:ok, %{"message" => %{"id" => "msg-1"}, "target_agent_id" => "agent-target"}} =
             AgentCommunicationTools.execute("agent.message", %{
               "workspace_id" => "workspace-1",
               "observer_agent_id" => "agent-manager",
               "target_agent_id" => "agent-target",
               "message_type" => "handoff",
               "body" => "Please continue from the failing test.",
               "payload" => %{"failing_check" => "unit"},
               "trace_id" => "trc-1",
               "run_id" => "run-1"
             })

    assert_received {:message_payload,
                     %{
                       "workspace_id" => "workspace-1",
                       "observer_agent_id" => "agent-manager",
                       "target_agent_id" => "agent-target",
                       "message_type" => "handoff",
                       "body" => "Please continue from the failing test.",
                       "payload" => %{"failing_check" => "unit"},
                       "trace_id" => "trc-1",
                       "run_id" => "run-1"
                     }}
  end

  test "agent.message defaults workspace and observer from tool context" do
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(parent, {:message_payload, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!(%{"id" => "msg-1"}))
    end)

    assert {:ok, %{"message" => %{"id" => "msg-1"}}} =
             AgentCommunicationTools.execute(
               "agent.message",
               %{
                 "target_agent_id" => "agent-target",
                 "body" => "Please continue."
               },
               workspace_id: "workspace-1",
               agent_id: "agent-manager"
             )

    assert_received {:message_payload,
                     %{
                       "workspace_id" => "workspace-1",
                       "observer_agent_id" => "agent-manager",
                       "target_agent_id" => "agent-target",
                       "body" => "Please continue."
                     }}
  end

  test "agent.remediate posts an allowed action and rejects unknown actions" do
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/api/agents/agent-target/remediations"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(parent, {:remediation_payload, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(202, Jason.encode!(%{"id" => "rem-1", "status" => "queued"}))
    end)

    assert {:error, {:invalid_remediation_action, "delete_everything"}} =
             AgentCommunicationTools.execute("agent.remediate", %{
               "workspace_id" => "workspace-1",
               "observer_agent_id" => "agent-manager",
               "target_agent_id" => "agent-target",
               "action" => "delete_everything"
             })

    assert {:ok, %{"remediation" => %{"id" => "rem-1", "status" => "queued"}}} =
             AgentCommunicationTools.execute("agent.remediate", %{
               "workspace_id" => "workspace-1",
               "observer_agent_id" => "agent-manager",
               "target_agent_id" => "agent-target",
               "action" => "restart",
               "reason" => "gateway_ws_upstream_failed",
               "payload" => %{"connection_id" => "conn-1"},
               "trace_id" => "trc-1"
             })

    assert_received {:remediation_payload,
                     %{
                       "workspace_id" => "workspace-1",
                       "observer_agent_id" => "agent-manager",
                       "target_agent_id" => "agent-target",
                       "action" => "restart",
                       "reason" => "gateway_ws_upstream_failed",
                       "payload" => %{"connection_id" => "conn-1"},
                       "trace_id" => "trc-1"
                     }}
  end

  test "agent communication tools fail closed when platform endpoint is not configured" do
    Application.delete_env(:symphony_elixir, :agent_control_plane)

    assert {:error, :missing_control_plane_endpoint} =
             AgentCommunicationTools.execute("agent.message", %{
               "workspace_id" => "workspace-1",
               "observer_agent_id" => "agent-manager",
               "target_agent_id" => "agent-target",
               "body" => "handoff"
             })
  end
end
