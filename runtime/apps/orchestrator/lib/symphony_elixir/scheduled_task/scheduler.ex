defmodule SymphonyElixir.ScheduledTask.Scheduler do
  @moduledoc """
  Clock loop for persisted scheduled tasks.

  This worker is intentionally separate from `SymphonyElixir.Manager.Scheduler`;
  manager scheduling remains a due-`work_items` poller.
  """

  use GenServer

  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.ScheduledTask.{Delivery, NextRun, Repository}
  alias SymphonyElixir.Time

  @default_poll_interval_ms 60_000
  @default_batch_limit 25
  @default_jitter_ms 5_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec tick(GenServer.server(), timeout()) :: map()
  def tick(server \\ __MODULE__, timeout \\ 60_000), do: GenServer.call(server, :tick, timeout)

  @impl true
  def init(opts) do
    state = %{
      repository: Keyword.get(opts, :repository, Repository),
      delivery: Keyword.get(opts, :delivery, Delivery),
      chat_gateway: Keyword.get(opts, :chat_gateway, SymphonyElixir.ChatGateway),
      clock: Keyword.get(opts, :clock, &DateTime.utc_now/0),
      timer: Keyword.get(opts, :timer, &Process.send_after/3),
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, @default_poll_interval_ms),
      batch_limit: Keyword.get(opts, :batch_limit, @default_batch_limit),
      trace_id: Keyword.get(opts, :trace_id)
    }

    if Keyword.get(opts, :schedule_first_tick, true) do
      state.timer.(self(), :tick, initial_delay(Keyword.get(opts, :jitter_ms, @default_jitter_ms)))
    end

    {:ok, state}
  end

  @impl true
  def handle_call(:tick, _from, state) do
    {reply, state} = run_tick(state)
    {:reply, reply, state}
  end

  @impl true
  def handle_info(:tick, state) do
    {_reply, state} = run_tick(state)
    state.timer.(self(), :tick, state.poll_interval_ms)
    {:noreply, state}
  end

  defp run_tick(state) do
    trace_id = RuntimeLog.ensure_trace_id(state.trace_id)

    RuntimeLog.with_operation_trace_id(trace_id, fn ->
      now = state.clock.()
      started_at = System.monotonic_time()

      RuntimeLog.log(:info, :scheduled_task_poll_started, %{trace_id: trace_id})

      result =
        case state.repository.due_tasks(now, state.batch_limit) do
          {:ok, tasks} ->
            results = Enum.map(tasks, &process_task(&1, state, now, trace_id))
            summarize(results)

          {:error, reason} ->
            %{total: 0, delivered: 0, failed: 1, skipped: 0, error: inspect(reason)}
        end

      RuntimeLog.log(
        :info,
        :scheduled_task_poll_finished,
        Map.merge(result, %{trace_id: trace_id, duration_ms: duration_ms(started_at)})
      )

      {result, %{state | trace_id: trace_id}}
    end)
  end

  defp process_task(task, state, now, trace_id) do
    scheduled_for = parse_datetime(task["next_run_at"])

    with {:ok, scheduled_for} <- scheduled_for,
         {:ok, run} when is_map(run) <- state.repository.claim_run(task, scheduled_for, now) do
      RuntimeLog.log(:info, :scheduled_task_run_claimed, log_fields(task, run, trace_id))
      deliver_claimed(task, run, scheduled_for, state, trace_id)
    else
      {:ok, :conflict} ->
        RuntimeLog.log(:info, :scheduled_task_run_skipped, log_fields(task, %{}, trace_id, %{skip_reason: :already_claimed}))
        %{status: :skipped, reason: :already_claimed}

      {:error, reason} ->
        RuntimeLog.log(:warning, :scheduled_task_run_skipped, log_fields(task, %{}, trace_id, %{skip_reason: reason}))
        %{status: :skipped, reason: reason}
    end
  end

  defp deliver_claimed(task, run, scheduled_for, state, trace_id) do
    case state.delivery.deliver(task, run,
           repository: state.repository,
           chat_gateway: state.chat_gateway,
           trace_id: trace_id
         ) do
      {:ok, run_id} ->
        finish_success(task, run, scheduled_for, run_id, state, trace_id)

      {:error, reason} ->
        finish_failure(task, run, scheduled_for, reason, state, trace_id)
    end
  end

  defp finish_success(task, run, scheduled_for, run_id, state, trace_id) do
    finished_at = state.clock.()
    next_run_at = next_run_at(task, scheduled_for)

    state.repository.finish_run(run["id"], %{
      "status" => "delivered",
      "finished_at" => Time.to_iso8601(finished_at),
      "run_id" => run_id
    })

    state.repository.update_task(task["id"], task_update_payload("delivered", nil, scheduled_for, next_run_at))

    RuntimeLog.log(:info, :scheduled_task_message_delivered, log_fields(task, run, trace_id, %{run_id: run_id}))
    %{status: :delivered, run_id: run_id}
  end

  defp finish_failure(task, run, scheduled_for, reason, state, trace_id) do
    finished_at = state.clock.()
    next_run_at = next_run_at(task, scheduled_for)
    error = error_string(reason)

    state.repository.finish_run(run["id"], %{
      "status" => "failed",
      "finished_at" => Time.to_iso8601(finished_at),
      "error" => error
    })

    state.repository.update_task(task["id"], task_update_payload("failed", error, scheduled_for, next_run_at))

    RuntimeLog.log(:warning, :scheduled_task_run_failed, log_fields(task, run, trace_id, %{error: error}))
    %{status: :failed, reason: reason}
  end

  defp task_update_payload(status, error, scheduled_for, next_run_at) do
    %{
      "last_run_status" => status,
      "last_run_at" => Time.to_iso8601(scheduled_for),
      "last_error" => error,
      "next_run_at" => Time.to_iso8601(next_run_at)
    }
  end

  defp next_run_at(task, scheduled_for) do
    case NextRun.next_after(task["schedule"] || %{}, scheduled_for, task["timezone"]) do
      {:ok, next_run_at} -> next_run_at
      {:error, _reason} -> nil
    end
  end

  defp parse_datetime(value) when is_binary(value) do
    case Time.parse_iso8601(value) do
      %DateTime{} = datetime -> {:ok, datetime}
      nil -> {:error, {:invalid_next_run_at, :invalid_format}}
    end
  end

  defp parse_datetime(_value), do: {:error, :missing_next_run_at}

  defp summarize(results) do
    %{
      total: length(results),
      delivered: Enum.count(results, &(&1.status == :delivered)),
      failed: Enum.count(results, &(&1.status == :failed)),
      skipped: Enum.count(results, &(&1.status == :skipped))
    }
  end

  defp log_fields(task, run, trace_id, extra \\ %{}) do
    %{
      trace_id: trace_id,
      workspace_id: task["workspace_id"],
      agent_id: task["agent_id"],
      scheduled_task_id: task["id"],
      scheduled_task_run_id: run["id"],
      scheduled_for: run["scheduled_for"] || task["next_run_at"],
      source_work_item_id: task["source_work_item_id"]
    }
    |> Map.merge(extra)
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp error_string(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp error_string(reason), do: inspect(reason)

  defp initial_delay(max_jitter_ms) when is_integer(max_jitter_ms) and max_jitter_ms > 0,
    do: :rand.uniform(max_jitter_ms)

  defp initial_delay(_max_jitter_ms), do: 0

  defp duration_ms(started_at) do
    System.monotonic_time()
    |> Kernel.-(started_at)
    |> System.convert_time_unit(:native, :millisecond)
  end
end
