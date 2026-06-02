defmodule SymphonyElixir.Runner.Poller do
  @moduledoc """
  Shared deadline-based polling loop for remote runner adapters.
  """

  @type classification :: :continue | {:ok, term()} | {:error, term()}

  @spec poll_until(integer(), non_neg_integer(), (-> term()), (term() -> classification())) ::
          {:ok, term()} | {:error, term()}
  def poll_until(deadline_ms, interval_ms, fetch_fun, classify_fun)
      when is_integer(deadline_ms) and is_integer(interval_ms) and interval_ms >= 0 and
             is_function(fetch_fun, 0) and is_function(classify_fun, 1) do
    if System.monotonic_time(:millisecond) >= deadline_ms do
      {:error, {:retryable, :poll_timeout}}
    else
      fetch_fun.()
      |> classify_fun.()
      |> handle_classification(deadline_ms, interval_ms, fetch_fun, classify_fun)
    end
  end

  defp handle_classification(:continue, deadline_ms, interval_ms, fetch_fun, classify_fun) do
    if interval_ms > 0 do
      Process.sleep(interval_ms)
    end

    poll_until(deadline_ms, interval_ms, fetch_fun, classify_fun)
  end

  defp handle_classification({:ok, _result} = success, _deadline_ms, _interval_ms, _fetch_fun, _classify_fun),
    do: success

  defp handle_classification({:error, _reason} = error, _deadline_ms, _interval_ms, _fetch_fun, _classify_fun),
    do: error
end
