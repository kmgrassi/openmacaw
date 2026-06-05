defmodule SymphonyElixir.TestSupport.OrchestratorStatus do
  import ExUnit.Assertions
  import ExUnit.Callbacks

  alias SymphonyElixir.{Orchestrator, WorkItem}

  def start_orchestrator!(owner_module, suffix) do
    orchestrator_name = Module.concat(owner_module, suffix)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    pid
  end

  def build_issue(issue_id, attrs \\ %{}) when is_binary(issue_id) and is_map(attrs) do
    identifier = Map.get(attrs, :identifier, "MT-TEST")

    defaults = %{
      id: issue_id,
      identifier: identifier,
      title: "Test issue",
      description: "Test description",
      state: "In Progress",
      url: "https://example.org/issues/#{identifier}"
    }

    struct!(WorkItem, Map.merge(defaults, attrs))
  end

  def attach_running_issue!(pid, %WorkItem{id: issue_id} = issue, attrs \\ %{})
      when is_pid(pid) and is_map(attrs) do
    running_entry = Map.merge(base_running_entry(issue), attrs)

    :sys.replace_state(pid, fn state ->
      %{
        state
        | running: Map.put(state.running, issue_id, running_entry),
          claimed: MapSet.put(state.claimed, issue_id)
      }
    end)

    running_entry
  end

  def wait_for_snapshot(pid, predicate, timeout_ms \\ 200) when is_function(predicate, 1) do
    deadline_ms = System.monotonic_time(:millisecond) + timeout_ms
    do_wait_for_snapshot(pid, predicate, deadline_ms)
  end

  def snapshot_data(overrides \\ %{}) when is_map(overrides) do
    Map.merge(
      %{
        running: [],
        retrying: [],
        codex_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
        rate_limits: nil
      },
      overrides
    )
  end

  def graph_samples_from_rates(rates_per_bucket) do
    bucket_ms = 25_000

    {timestamp, tokens, samples} =
      Enum.reduce(rates_per_bucket, {0, 0, []}, fn rate, {timestamp, tokens, acc} ->
        next_timestamp = timestamp + bucket_ms
        next_tokens = tokens + trunc(rate * bucket_ms / 1000)
        {next_timestamp, next_tokens, [{timestamp, tokens} | acc]}
      end)

    {tokens, [{timestamp, tokens} | samples]}
  end

  def graph_samples_for_stability_test(now_ms) do
    rates_per_bucket = Enum.map(1..24, &(&1 * 5))
    bucket_ms = 25_000

    rate_for_timestamp = fn timestamp ->
      bucket_idx = min(div(max(timestamp, 0), bucket_ms), 23)
      Enum.at(rates_per_bucket, bucket_idx, 0)
    end

    0..(now_ms - 1_000)//1_000
    |> Enum.reduce({0, []}, fn timestamp, {tokens, acc} ->
      next_tokens = tokens + rate_for_timestamp.(timestamp)
      {next_tokens, [{timestamp, next_tokens} | acc]}
    end)
    |> elem(1)
  end

  defp do_wait_for_snapshot(pid, predicate, deadline_ms) do
    snapshot = GenServer.call(pid, :snapshot)

    if predicate.(snapshot) do
      snapshot
    else
      if System.monotonic_time(:millisecond) >= deadline_ms do
        flunk("timed out waiting for orchestrator snapshot state: #{inspect(snapshot)}")
      else
        Process.sleep(5)
        do_wait_for_snapshot(pid, predicate, deadline_ms)
      end
    end
  end

  defp base_running_entry(issue) do
    %{
      pid: self(),
      ref: make_ref(),
      identifier: issue.identifier,
      issue: issue,
      session_id: nil,
      turn_count: 0,
      last_codex_message: nil,
      last_codex_timestamp: nil,
      last_codex_event: nil,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      codex_last_reported_input_tokens: 0,
      codex_last_reported_output_tokens: 0,
      codex_last_reported_total_tokens: 0,
      started_at: DateTime.utc_now()
    }
  end
end
