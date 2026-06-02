defmodule SymphonyElixir.BrokerLogAdapter do
  @moduledoc """
  Narrow adapter between `AgentRunner` and optional BrokerLog persistence.

  Broker logging is intentionally best-effort. Missing configuration, failed
  starts, or disabled runs collapse to `:disabled` so runner control flow can
  stay focused on executing turns.
  """

  alias SymphonyElixir.BrokerLog
  alias SymphonyElixir.UsageExtraction.Accumulator

  @type run_ref :: String.t() | :disabled

  @spec begin_run(map(), keyword(), keyword()) :: run_ref()
  def begin_run(issue, opts, extra \\ []) do
    attrs =
      [
        issue: issue,
        attempt: Keyword.get(opts, :attempt)
      ] ++ extra

    case BrokerLog.start_run(attrs) do
      {:ok, run_id} -> run_id
      _ -> :disabled
    end
  end

  @spec update_workspace(run_ref(), String.t() | nil) :: :ok
  def update_workspace(:disabled, _workspace), do: :ok

  def update_workspace(run_id, workspace) when is_binary(run_id) and is_binary(workspace) do
    BrokerLog.update_run(run_id, %{"workspace_path" => workspace})
    :ok
  end

  def update_workspace(_run_id, _workspace), do: :ok

  @spec finalize(run_ref(), :ok | {:error, term()} | term()) :: :ok
  def finalize(:disabled, _result), do: :ok

  def finalize(run_id, :ok) when is_binary(run_id) do
    BrokerLog.finish_run(run_id, status: "completed")
    :ok
  end

  def finalize(run_id, {:error, reason}) when is_binary(run_id) do
    BrokerLog.finish_run(run_id,
      status: "failed",
      error: inspect(reason),
      terminal_reason: terminal_reason_for(reason)
    )

    :ok
  end

  def finalize(_run_id, _result), do: :ok

  @spec record_turn(run_ref(), Accumulator.t(), pos_integer()) :: :ok
  def record_turn(:disabled, _accumulator, _turn_number), do: :ok

  def record_turn(run_id, accumulator, turn_number) when is_binary(run_id) do
    snapshot = Accumulator.snapshot_turn(accumulator)

    BrokerLog.record_turn(run_id,
      input_tokens: snapshot.input_delta,
      output_tokens: snapshot.output_delta,
      total_tokens: snapshot.total_delta,
      last_event: snapshot.last_event,
      attempt: turn_number
    )

    :ok
  end

  def record_turn(_run_id, _accumulator, _turn_number), do: :ok

  defp terminal_reason_for({:issue_state_refresh_failed, _}), do: "tracker_refresh_failed"
  defp terminal_reason_for(:turn_timeout), do: "turn_timeout"
  defp terminal_reason_for({:turn_failed, _}), do: "turn_failed"
  defp terminal_reason_for({:turn_cancelled, _}), do: "turn_cancelled"
  defp terminal_reason_for({:turn_input_required, _}), do: "turn_input_required"
  defp terminal_reason_for({:approval_required, _}), do: "approval_required"
  defp terminal_reason_for(_), do: "error"
end
