defmodule SymphonyElixir.Runner.Mock do
  @moduledoc """
  Mock runner for tests.

  Returns preconfigured responses without making any external calls.
  Configure via application env:

      Application.put_env(:symphony_elixir, :mock_runner_responses, %{
        start_session: {:ok, %{session_id: "mock-123"}},
        run_turn: {:ok, %{status: "completed"}},
        stop_session: :ok,
        ping: :ok
      })

      Application.put_env(:symphony_elixir, :mock_runner_recipient, self())

  Events are sent to the recipient process for test assertions.
  """

  @behaviour SymphonyElixir.Runner

  @impl true
  def start_session(config, workspace) do
    send_event({:mock_runner_start_session, config, workspace})
    response(:start_session, {:ok, %{session_id: "mock-session-#{System.unique_integer([:positive])}"}})
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    send_event({:mock_runner_run_turn, session, prompt, work_item})
    response(:run_turn, {:ok, %{status: "completed", output: "mock output"}})
  end

  @impl true
  def stop_session(session) do
    send_event({:mock_runner_stop_session, session})
    response(:stop_session, :ok)
  end

  @impl true
  def ping(config) do
    send_event({:mock_runner_ping, config})
    response(:ping, :ok)
  end

  @impl true
  def requires_workspace?, do: false

  defp response(callback, default) do
    case Application.get_env(:symphony_elixir, :mock_runner_responses) do
      %{^callback => response} -> response
      _ -> default
    end
  end

  defp send_event(message) do
    case Application.get_env(:symphony_elixir, :mock_runner_recipient) do
      pid when is_pid(pid) -> send(pid, message)
      _ -> :ok
    end
  end
end
