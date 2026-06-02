defmodule SymphonyElixir.LocalRelay.EndpointServer do
  @moduledoc """
  Starts and monitors the local relay socket endpoint without letting repeated
  endpoint failures bubble out as supervisor crashes.

  The launcher owns the always-on control plane, so a relay port bind failure
  must stay local to this wrapper process rather than burning through the
  launcher's restart budget.
  """

  use GenServer

  require Logger

  @initial_retry_ms 1_000
  @max_retry_ms 30_000

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]}
    }
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    state = %{
      host: Keyword.get(opts, :host, "0.0.0.0"),
      port: Keyword.fetch!(opts, :port),
      server: Keyword.get(opts, :server, SymphonyElixir.HttpServer),
      endpoint_pid: nil,
      endpoint_ref: nil,
      retry_ms: @initial_retry_ms
    }

    send(self(), :ensure_endpoint)
    {:ok, state}
  end

  @impl true
  def handle_info(:ensure_endpoint, state) do
    {:noreply, ensure_endpoint(state)}
  end

  def handle_info({:DOWN, ref, :process, pid, reason}, %{endpoint_ref: ref} = state) do
    Logger.warning("Local relay endpoint exited pid=#{inspect(pid)} port=#{state.port} reason=#{inspect(reason)}; scheduling retry")

    {:noreply, state |> clear_endpoint() |> schedule_retry(0)}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp ensure_endpoint(%{endpoint_pid: pid} = state) when is_pid(pid), do: state

  defp ensure_endpoint(state) do
    case state.server.start_link(port: state.port, host: state.host) do
      {:ok, pid} when is_pid(pid) ->
        Logger.info("Local relay endpoint started port=#{state.port} pid=#{inspect(pid)}")
        monitor_endpoint(state, pid)

      {:error, {:already_started, pid}} when is_pid(pid) ->
        Logger.info("Local relay endpoint already running port=#{state.port} pid=#{inspect(pid)}")
        monitor_endpoint(state, pid)

      {:error, reason} ->
        Logger.error("Local relay endpoint failed to start port=#{state.port} reason=#{inspect(reason)}")
        schedule_retry(state)
    end
  end

  defp monitor_endpoint(state, pid) do
    %{state | endpoint_pid: pid, endpoint_ref: Process.monitor(pid), retry_ms: @initial_retry_ms}
  end

  defp clear_endpoint(state) do
    %{state | endpoint_pid: nil, endpoint_ref: nil}
  end

  defp schedule_retry(state, delay_ms \\ nil) do
    delay_ms = delay_ms || state.retry_ms
    Process.send_after(self(), :ensure_endpoint, delay_ms)
    %{state | retry_ms: min(max(delay_ms * 2, @initial_retry_ms), @max_retry_ms)}
  end
end
