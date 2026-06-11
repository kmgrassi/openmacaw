defmodule SymphonyElixir.Cutover.AuditTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.Cutover.Audit
  alias SymphonyElixir.Cutover.Decision

  setup do
    put_app_envs(:symphony_elixir,
      cutover_audit_req_options: [plug: {Req.Test, __MODULE__}],
      cutover_audit: [
        endpoint: "https://platform.example",
        api_key: "platform-key"
      ]
    )

    :ok
  end

  test "posts the PR9 camelCase payload to the work item cutover endpoint" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:request, conn.method, conn.request_path, conn.req_headers})

      assert conn.method == "POST"
      assert conn.request_path == "/api/work-items/work-item-1/cutovers"
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer platform-key"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload == %{
               "workspaceId" => "workspace-1",
               "agentId" => "agent-1",
               "fromProvider" => "anthropic",
               "fromModel" => "claude-opus-4-7",
               "fromCredentialId" => "credential-primary",
               "toProvider" => "openai",
               "toModel" => "gpt-4.1",
               "toCredentialId" => "credential-fallback",
               "triggerErrorCode" => "provider_rate_limited",
               "triggerStatusCode" => 429,
               "elapsedMs" => 42,
               "outcome" => "fallback_succeeded"
             }

      Plug.Conn.send_resp(conn, 201, ~s({"id":"cutover-1"}))
    end)

    assert :ok = Audit.write(decision())
    assert_received {:request, "POST", "/api/work-items/work-item-1/cutovers", _headers}
  end

  test "logs audit failures without raising in best-effort mode" do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(503, ~s({"error":"unavailable"}))
    end)

    log =
      capture_log(fn ->
        assert :ok = Audit.write_best_effort(decision())
      end)

    assert log =~ "cutover_audit_persistence_failed"
    assert log =~ "\"non_fatal\":true"
    assert log =~ "\"work_item_id\":\"work-item-1\""
  end

  test "best-effort write is a no-op when cutover audit is not configured" do
    delete_app_env(:symphony_elixir, :cutover_audit)
    delete_system_envs(["CUTOVER_AUDIT_ENDPOINT", "CUTOVER_AUDIT_API_KEY"])

    log =
      capture_log(fn ->
        assert {:error, :cutover_audit_disabled} = Audit.write(decision())
        assert :ok = Audit.write_best_effort(decision())
      end)

    refute log =~ "cutover_audit_persistence_failed"
  end

  defp decision do
    %Decision{
      workspace_id: "workspace-1",
      agent_id: "agent-1",
      work_item_id: "work-item-1",
      from_provider: "anthropic",
      from_model: "claude-opus-4-7",
      from_credential_id: "credential-primary",
      to_provider: "openai",
      to_model: "gpt-4.1",
      to_credential_id: "credential-fallback",
      trigger_error_code: "provider_rate_limited",
      trigger_status_code: 429,
      elapsed_ms: 42,
      outcome: :fallback_succeeded
    }
  end
end
