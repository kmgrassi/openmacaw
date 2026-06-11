defmodule SymphonyElixir.Runner.OpenClawTest do
  use SymphonyElixir.TestSupport

  import ExUnit.CaptureLog

  alias SymphonyElixir.Runner.OpenClaw
  alias SymphonyElixir.WorkItem

  describe "requires_workspace?/0" do
    test "returns false" do
      assert OpenClaw.requires_workspace?() == false
    end
  end

  describe "start_session/2" do
    test "returns session with config fields" do
      config = %{
        "base_url" => "http://localhost:19999",
        "api_key" => "test-key",
        "model" => "o4-mini",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 100
      }

      {:ok, session} = OpenClaw.start_session(config, nil)

      assert session.base_url == "http://localhost:19999"
      assert session.api_key == "test-key"
      assert session.model == "o4-mini"
      assert session.poll_interval_ms == 100
      assert session.timeout_ms == 5_000
    end

    test "returns error when base_url is missing" do
      assert {:error, {:missing_config, "base_url"}} =
               OpenClaw.start_session(%{}, nil)
    end

    test "uses defaults for optional fields" do
      {:ok, session} = OpenClaw.start_session(%{"base_url" => "http://localhost:1234"}, nil)

      assert session.poll_interval_ms == 5_000
      assert session.timeout_ms == 300_000
      assert session.model == nil
      assert session.api_key == nil
    end
  end

  describe "run_turn/3" do
    test "successfully completes a run" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "run-1", status: "running"}}

          %{method: "GET", path: "/v1/runs/run-1"} ->
            {200, %{id: "run-1", status: "completed", output: "done"}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "timeout_ms" => 5_000, "poll_interval_ms" => 50}
      {:ok, session} = OpenClaw.start_session(config, nil)

      work_item = build_work_item()
      assert {:ok, result} = OpenClaw.run_turn(session, "Fix the bug", work_item)
      assert result["status"] == "completed"

      stop_test_server(server_ref)
    end

    test "returns fatal error on run failure" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "run-fail", status: "running"}}

          %{method: "GET", path: "/v1/runs/run-fail"} ->
            {200, %{id: "run-fail", status: "failed", error: "out of memory"}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "timeout_ms" => 5_000, "poll_interval_ms" => 50}
      {:ok, session} = OpenClaw.start_session(config, nil)

      work_item = build_work_item()
      assert {:error, {:fatal, {:run_failed, "out of memory"}}} = OpenClaw.run_turn(session, "Fix the bug", work_item)

      stop_test_server(server_ref)
    end

    test "returns retryable error on API failure" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {500, %{error: "internal server error"}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "timeout_ms" => 5_000, "poll_interval_ms" => 50}
      {:ok, session} = OpenClaw.start_session(config, nil)

      work_item = build_work_item()

      log =
        capture_log(fn ->
          assert {:error, {:retryable, {:api_error, 500, _}}} = OpenClaw.run_turn(session, "Fix the bug", work_item)
        end)

      assert log |> model_call_failed_events() |> length() == 1

      stop_test_server(server_ref)
    end

    test "walks fallback chain after provider failure" do
      {primary_port, primary_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {429, %{error: %{code: "rate_limit_exceeded", message: "try later"}}}
        end)

      {fallback_port, fallback_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "fallback-run", status: "running"}}

          %{method: "GET", path: "/v1/runs/fallback-run"} ->
            {200, %{id: "fallback-run", status: "completed", output: "fallback done"}}
        end)

      config = %{
        "base_url" => "http://localhost:#{primary_port}",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50,
        "fallbacks" => [
          %{"adapter_config" => %{"base_url" => "http://localhost:#{fallback_port}"}}
        ]
      }

      {:ok, session} = OpenClaw.start_session(config, nil)

      assert {:ok, %{"id" => "fallback-run", "status" => "completed"}} =
               OpenClaw.run_turn(session, "Fix the bug", build_work_item())

      stop_test_server(primary_ref)
      stop_test_server(fallback_ref)
    end

    test "reads fallback chain from embedded execution profile" do
      {primary_port, primary_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {429, %{error: %{code: "rate_limit_exceeded", message: "try later"}}}
        end)

      {fallback_port, fallback_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "profile-fallback-run", status: "running"}}

          %{method: "GET", path: "/v1/runs/profile-fallback-run"} ->
            {200, %{id: "profile-fallback-run", status: "completed", output: "fallback done"}}
        end)

      config = %{
        "base_url" => "http://localhost:#{primary_port}",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50
      }

      {:ok, session} = OpenClaw.start_session(config, nil)

      session =
        session
        |> Map.delete(:fallbacks)
        |> Map.put(:execution_profile, %{
          "fallbacks" => [
            %{"adapter_config" => %{"base_url" => "http://localhost:#{fallback_port}"}}
          ]
        })

      assert {:ok, %{"id" => "profile-fallback-run", "status" => "completed"}} =
               OpenClaw.run_turn(session, "Fix the bug", build_work_item())

      stop_test_server(primary_ref)
      stop_test_server(fallback_ref)
    end

    test "walks fallback chain after polling provider failure" do
      {primary_port, primary_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "poll-fails", status: "running"}}

          %{method: "GET", path: "/v1/runs/poll-fails"} ->
            {503, %{error: %{message: "overloaded"}}}
        end)

      {fallback_port, fallback_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "poll-fallback-run", status: "running"}}

          %{method: "GET", path: "/v1/runs/poll-fallback-run"} ->
            {200, %{id: "poll-fallback-run", status: "completed", output: "fallback done"}}
        end)

      config = %{
        "base_url" => "http://localhost:#{primary_port}",
        "timeout_ms" => 5_000,
        "poll_interval_ms" => 50,
        "fallbacks" => [
          %{"adapter_config" => %{"base_url" => "http://localhost:#{fallback_port}"}}
        ]
      }

      {:ok, session} = OpenClaw.start_session(config, nil)

      assert {:ok, %{"id" => "poll-fallback-run", "status" => "completed"}} =
               OpenClaw.run_turn(session, "Fix the bug", build_work_item())

      stop_test_server(primary_ref)
      stop_test_server(fallback_ref)
    end

    test "polls until completion with intermediate pending states" do
      counter = :counters.new(1, [:atomics])

      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs"} ->
            {200, %{id: "run-poll", status: "running"}}

          %{method: "GET", path: "/v1/runs/run-poll"} ->
            :counters.add(counter, 1, 1)
            count = :counters.get(counter, 1)
            status = if count >= 3, do: "completed", else: "running"
            {200, %{id: "run-poll", status: status, output: "result"}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "timeout_ms" => 10_000, "poll_interval_ms" => 50}
      {:ok, session} = OpenClaw.start_session(config, nil)

      work_item = build_work_item()
      assert {:ok, result} = OpenClaw.run_turn(session, "Fix the bug", work_item)
      assert result["status"] == "completed"
      assert :counters.get(counter, 1) >= 3

      stop_test_server(server_ref)
    end
  end

  describe "stop_session/1" do
    test "sends cancel request" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "POST", path: "/v1/runs/run-cancel/cancel"} ->
            {200, %{status: "cancelled"}}
        end)

      session = %{
        base_url: "http://localhost:#{port}",
        api_key: "test-key",
        run_id: "run-cancel"
      }

      assert :ok = OpenClaw.stop_session(session)
      stop_test_server(server_ref)
    end

    test "returns :ok when no run_id" do
      assert :ok = OpenClaw.stop_session(%{})
    end
  end

  describe "ping/1" do
    test "returns :ok when healthy" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "GET", path: "/v1/health"} ->
            {200, %{ok: true}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "api_key" => "key"}
      assert :ok = OpenClaw.ping(config)
      stop_test_server(server_ref)
    end

    test "returns error when unhealthy" do
      {port, server_ref} =
        start_test_server(fn
          %{method: "GET", path: "/v1/health"} ->
            {503, %{ok: false}}
        end)

      config = %{"base_url" => "http://localhost:#{port}", "api_key" => "key"}
      assert {:error, {:unhealthy, 503}} = OpenClaw.ping(config)
      stop_test_server(server_ref)
    end
  end

  defp build_work_item do
    %WorkItem{
      id: "wi-#{System.unique_integer([:positive])}",
      identifier: "TEST-1",
      title: "Test work item",
      description: "A test work item for runner tests",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{}
    }
  end

  defp start_test_server(handler) do
    port = Enum.random(30_000..39_999)

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

  defp model_call_failed_events(log) do
    Regex.scan(~r/\{.*\}/, log)
    |> Enum.map(fn [line] -> Jason.decode!(line) end)
    |> Enum.filter(&(&1["event"] == "model_call_failed"))
  end
end

defmodule SymphonyElixir.Runner.TestPlug do
  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    handler = Keyword.fetch!(opts, :handler)
    {:ok, body, conn} = Plug.Conn.read_body(conn)

    request = %{
      method: conn.method,
      path: conn.request_path,
      body: if(body != "", do: Jason.decode!(body), else: nil)
    }

    {status, response_body} = handler.(request)

    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.resp(status, Jason.encode!(response_body))
  end
end
