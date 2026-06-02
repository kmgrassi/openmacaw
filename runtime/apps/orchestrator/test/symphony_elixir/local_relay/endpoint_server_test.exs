defmodule SymphonyElixir.LocalRelay.EndpointServerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.LocalRelay.EndpointServer

  defmodule FailingServer do
    def start_link(_opts) do
      send(test_pid(), :start_attempt)
      {:error, :eaddrinuse}
    end

    defp test_pid do
      Application.fetch_env!(:symphony_elixir, :local_relay_endpoint_server_test_pid)
    end
  end

  setup do
    Application.put_env(:symphony_elixir, :local_relay_endpoint_server_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :local_relay_endpoint_server_test_pid)
    end)

    :ok
  end

  test "stays alive and retries when the endpoint fails to start" do
    {:ok, pid} =
      start_supervised({EndpointServer, port: 4200, host: "0.0.0.0", server: FailingServer})

    assert_receive :start_attempt
    assert Process.alive?(pid)

    state = :sys.get_state(pid)
    assert state.endpoint_pid == nil
    assert state.retry_ms >= 1_000
  end
end
