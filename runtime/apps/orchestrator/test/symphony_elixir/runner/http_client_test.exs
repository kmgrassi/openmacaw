defmodule SymphonyElixir.Runner.HttpClientTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.HttpClient

  describe "request helpers" do
    test "posts JSON with bearer auth and trims trailing base URL slash" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert request.method == "POST"
          assert request.path == "/v1/runs"
          assert request.body == %{"prompt" => "fix"}
          assert {"authorization", "Bearer secret"} in request.headers
          assert {"content-type", "application/json"} in request.headers

          {201, %{id: "run-1"}}
        end)

      assert {:ok, %{status: 201, body: %{"id" => "run-1"}}} =
               HttpClient.post("http://localhost:#{port}/", "/v1/runs", %{prompt: "fix"}, "secret")

      stop_test_server(server_ref)
    end

    test "gets without bearer auth" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert request.method == "GET"
          assert request.path == "/health"
          refute Enum.any?(request.headers, fn {name, _value} -> name == "authorization" end)

          {200, %{ok: true}}
        end)

      assert {:ok, %{status: 200, body: %{"ok" => true}}} =
               HttpClient.get("http://localhost:#{port}", "/health")

      stop_test_server(server_ref)
    end

    test "merges request options passed as the third get argument" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert {"x-runner-test", "true"} in request.headers
          refute Enum.any?(request.headers, fn {name, _value} -> name == "authorization" end)

          {200, %{ok: true}}
        end)

      assert {:ok, %{status: 200, body: %{"ok" => true}}} =
               HttpClient.get("http://localhost:#{port}", "/health", headers: [{"x-runner-test", "true"}])

      stop_test_server(server_ref)
    end

    test "merges request options passed with an api key" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert {"authorization", "Bearer secret"} in request.headers
          assert {"x-runner-test", "true"} in request.headers

          {200, %{ok: true}}
        end)

      assert {:ok, %{status: 200, body: %{"ok" => true}}} =
               HttpClient.get("http://localhost:#{port}", "/health", "secret", headers: [{"x-runner-test", "true"}])

      stop_test_server(server_ref)
    end

    test "posts JSON with unauthenticated request options" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert request.method == "POST"
          assert request.body == %{"prompt" => "fix"}
          assert {"x-runner-test", "true"} in request.headers
          refute Enum.any?(request.headers, fn {name, _value} -> name == "authorization" end)

          {201, %{id: "run-1"}}
        end)

      assert {:ok, %{status: 201, body: %{"id" => "run-1"}}} =
               HttpClient.post("http://localhost:#{port}/", "/v1/runs", %{prompt: "fix"}, headers: [{"x-runner-test", "true"}])

      stop_test_server(server_ref)
    end

    test "deletes and returns normalized response shape" do
      {port, server_ref} =
        start_test_server(fn request ->
          assert request.method == "DELETE"
          assert request.path == "/sessions/session-1"

          {204, %{}}
        end)

      assert {:ok, %{status: 204, body: ""}} =
               HttpClient.delete("http://localhost:#{port}", "/sessions/session-1")

      stop_test_server(server_ref)
    end

    test "maps request exceptions into request_failed tuples" do
      assert {:error, {:request_failed, message}} = HttpClient.get(nil, "/health")
      assert is_binary(message)
    end
  end

  defp start_test_server(handler) do
    port = Enum.random(50_000..59_999)

    plug = {SymphonyElixir.Runner.HttpClientTestPlug, handler: handler}

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

defmodule SymphonyElixir.Runner.HttpClientTestPlug do
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
      body: if(body != "", do: Jason.decode!(body), else: nil),
      headers: conn.req_headers
    }

    {status, response_body} = handler.(request)

    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.resp(status, Jason.encode!(response_body))
  end
end
