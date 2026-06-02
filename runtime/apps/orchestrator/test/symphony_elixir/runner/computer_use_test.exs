defmodule SymphonyElixir.Runner.ComputerUseTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.ComputerUse
  alias SymphonyElixir.WorkItem

  describe "requires_workspace?/0" do
    test "returns false" do
      assert ComputerUse.requires_workspace?() == false
    end
  end

  describe "start_session/2" do
    test "creates a session via API" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/sessions"} ->
            {200, %{session_id: "sess-123"}}
        end)

      config = %{
        "endpoint" => "http://localhost:#{port}",
        "api_key" => "test-key",
        "session_type" => "browser",
        "timeout_ms" => 10_000,
        "poll_interval_ms" => 100
      }

      assert {:ok, session} = ComputerUse.start_session(config, nil)
      assert session.session_id == "sess-123"
      assert session.endpoint == "http://localhost:#{port}"
      assert session.api_key == "test-key"
      assert session.timeout_ms == 10_000

      stop_test_server(server_ref)
    end

    test "returns error when endpoint is missing" do
      assert {:error, {:missing_config, "endpoint"}} = ComputerUse.start_session(%{}, nil)
    end

    test "returns error on API failure" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/sessions"} ->
            {500, %{error: "internal error"}}
        end)

      config = %{"endpoint" => "http://localhost:#{port}"}
      assert {:error, {:session_create_failed, 500, _}} = ComputerUse.start_session(config, nil)
      stop_test_server(server_ref)
    end
  end

  describe "run_turn/3" do
    test "sends action and polls until completion" do
      session_id = "sess-rt-#{System.unique_integer([:positive])}"

      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/sessions"} ->
            {200, %{session_id: session_id}}

          %{method: "POST", path: "/sessions/" <> _rest} ->
            {200, %{action_id: "act-1"}}

          %{method: "GET", path: "/sessions/" <> _rest} ->
            {200, %{status: "completed", result: "task done"}}
        end)

      config = %{
        "endpoint" => "http://localhost:#{port}",
        "api_key" => "test-key",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50
      }

      {:ok, session} = ComputerUse.start_session(config, nil)
      work_item = build_work_item()
      assert {:ok, result} = ComputerUse.run_turn(session, "Click the button", work_item)
      assert result["status"] == "completed"

      stop_test_server(server_ref)
    end

    test "returns synchronous completion without polling" do
      session_id = "sess-sync-#{System.unique_integer([:positive])}"

      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/sessions"} ->
            {200, %{session_id: session_id}}

          %{method: "POST", path: "/sessions/" <> _rest} ->
            {200, %{status: "completed", result: "instant"}}
        end)

      config = %{
        "endpoint" => "http://localhost:#{port}",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50
      }

      {:ok, session} = ComputerUse.start_session(config, nil)
      work_item = build_work_item()
      assert {:ok, result} = ComputerUse.run_turn(session, "Quick task", work_item)
      assert result["status"] == "completed"

      stop_test_server(server_ref)
    end

    test "returns fatal error on session failure" do
      session_id = "sess-fail-#{System.unique_integer([:positive])}"

      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/sessions"} ->
            {200, %{session_id: session_id}}

          %{method: "POST", path: "/sessions/" <> _rest} ->
            {200, %{action_id: "act-2"}}

          %{method: "GET", path: "/sessions/" <> _rest} ->
            {200, %{status: "failed", error: "browser crashed"}}
        end)

      config = %{
        "endpoint" => "http://localhost:#{port}",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50
      }

      {:ok, session} = ComputerUse.start_session(config, nil)
      work_item = build_work_item()
      assert {:error, {:fatal, {:session_failed, "browser crashed"}}} = ComputerUse.run_turn(session, "task", work_item)

      stop_test_server(server_ref)
    end
  end

  describe "stop_session/1" do
    test "sends DELETE request" do
      session_id = "sess-del-#{System.unique_integer([:positive])}"

      {port, server_ref} =
        start_test_server(fn
          %{method: "DELETE", path: "/sessions/" <> _rest} ->
            {200, %{status: "deleted"}}
        end)

      session = %{
        endpoint: "http://localhost:#{port}",
        session_id: session_id,
        api_key: "test-key"
      }

      assert :ok = ComputerUse.stop_session(session)
      stop_test_server(server_ref)
    end

    test "returns :ok for session without endpoint" do
      assert :ok = ComputerUse.stop_session(%{})
    end
  end

  describe "ping/1" do
    test "returns :ok when healthy" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "GET", path: "/health"} ->
            {200, %{ok: true}}
        end)

      config = %{"endpoint" => "http://localhost:#{port}"}
      assert :ok = ComputerUse.ping(config)
      stop_test_server(server_ref)
    end

    test "returns error when unhealthy" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "GET", path: "/health"} ->
            {503, %{ok: false}}
        end)

      config = %{"endpoint" => "http://localhost:#{port}"}
      assert {:error, {:unhealthy, 503}} = ComputerUse.ping(config)
      stop_test_server(server_ref)
    end
  end

  defp build_work_item do
    %WorkItem{
      id: "wi-#{System.unique_integer([:positive])}",
      identifier: "TEST-1",
      title: "Test work item",
      description: "A test description",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{}
    }
  end

  defp start_test_server(handler) do
    port = Enum.random(40_000..49_999)

    plug = {SymphonyElixir.Runner.TestPlug, handler: handler}

    {:ok, server_ref} =
      Bandit.start_link(
        plug: plug,
        port: port,
        ip: :loopback,
        startup_log: false
      )

    {port, server_ref}
  end

  defp stop_test_server(server_ref) do
    Supervisor.stop(server_ref)
  catch
    :exit, _ -> :ok
  end
end
