defmodule SymphonyElixir.UsageExtraction.Accumulator do
  @moduledoc """
  Tracks cumulative token usage emitted during a runner session.

  Runner events can report absolute cumulative token totals repeatedly. The
  accumulator keeps the highest absolute value seen and snapshots per-turn
  deltas by rebasing after each completed turn.
  """

  @type t :: pid() | nil
  @type snapshot :: %{
          input_delta: non_neg_integer(),
          output_delta: non_neg_integer(),
          total_delta: non_neg_integer(),
          last_event: String.t() | nil
        }

  @input_keys ~w(input_tokens prompt_tokens inputTokens promptTokens)
  @output_keys ~w(output_tokens completion_tokens outputTokens completionTokens)
  @total_keys ~w(total_tokens totalTokens total)
  @empty_snapshot %{input_delta: 0, output_delta: 0, total_delta: 0, last_event: nil}

  @spec start() :: t()
  def start do
    case Agent.start_link(fn ->
           %{
             input_abs: 0,
             output_abs: 0,
             total_abs: 0,
             input_baseline: 0,
             output_baseline: 0,
             total_baseline: 0,
             last_event: nil
           }
         end) do
      {:ok, pid} -> pid
      _ -> nil
    end
  end

  @spec stop(t()) :: :ok
  def stop(nil), do: :ok

  def stop(pid) when is_pid(pid) do
    if Process.alive?(pid), do: Agent.stop(pid), else: :ok
  end

  @spec record_snapshot(t(), map()) :: :ok
  def record_snapshot(nil, _message), do: :ok

  def record_snapshot(pid, message) when is_pid(pid) and is_map(message) do
    if Process.alive?(pid) do
      usage = extract_usage(message)
      event_name = message_event(message)

      Agent.update(pid, fn state ->
        %{
          state
          | input_abs: max(state.input_abs, usage.input || state.input_abs),
            output_abs: max(state.output_abs, usage.output || state.output_abs),
            total_abs: max(state.total_abs, usage.total || state.total_abs),
            last_event: event_name || state.last_event
        }
      end)
    end

    :ok
  end

  def record_snapshot(_pid, _message), do: :ok

  @spec snapshot_turn(t()) :: snapshot()
  def snapshot_turn(nil), do: @empty_snapshot

  def snapshot_turn(pid) when is_pid(pid) do
    if Process.alive?(pid) do
      Agent.get_and_update(pid, fn state ->
        result = %{
          input_delta: max(state.input_abs - state.input_baseline, 0),
          output_delta: max(state.output_abs - state.output_baseline, 0),
          total_delta: max(state.total_abs - state.total_baseline, 0),
          last_event: state.last_event
        }

        {result,
         %{
           state
           | input_baseline: state.input_abs,
             output_baseline: state.output_abs,
             total_baseline: state.total_abs
         }}
      end)
    else
      @empty_snapshot
    end
  end

  defp extract_usage(message) do
    %{
      input: find_token_field(message, :input),
      output: find_token_field(message, :output),
      total: find_token_field(message, :total)
    }
  end

  defp find_token_field(message, kind) do
    message
    |> token_payload_candidates()
    |> Enum.find_value(&first_integer(&1, keys_for(kind)))
  end

  defp keys_for(:input), do: @input_keys
  defp keys_for(:output), do: @output_keys
  defp keys_for(:total), do: @total_keys

  defp token_payload_candidates(message) when is_map(message) do
    [
      lookup(message, :usage),
      lookup(message, :payload),
      map_at(message, ["payload", "params", "msg", "payload", "info", "total_token_usage"]),
      map_at(message, ["payload", "params", "msg", "info", "total_token_usage"]),
      map_at(message, ["payload", "params", "tokenUsage", "total"]),
      map_at(message, ["payload", "tokenUsage", "total"]),
      map_at(message, ["payload", "params", "usage"]),
      map_at(message, ["payload", "usage"]),
      message
    ]
    |> Enum.filter(&is_map/1)
  end

  defp token_payload_candidates(_), do: []

  defp first_integer(payload, keys) when is_map(payload) do
    Enum.find_value(keys, fn key ->
      value = lookup(payload, key)

      cond do
        is_integer(value) and value >= 0 -> value
        true -> nil
      end
    end)
  end

  defp first_integer(_payload, _keys), do: nil

  defp lookup(map, key) when is_map(map) and is_atom(key) do
    Map.get(map, key) || Map.get(map, Atom.to_string(key))
  end

  defp lookup(map, key) when is_map(map) and is_binary(key) do
    Map.get(map, key) ||
      (function_exported?(:erlang, :binary_to_existing_atom, 1) &&
         safe_atom_lookup(map, key))
  end

  defp lookup(_map, _key), do: nil

  defp safe_atom_lookup(map, key) do
    try do
      Map.get(map, String.to_existing_atom(key))
    rescue
      ArgumentError -> nil
    end
  end

  defp map_at(payload, path) when is_map(payload) and is_list(path) do
    Enum.reduce_while(path, payload, fn key, acc ->
      cond do
        not is_map(acc) ->
          {:halt, nil}

        true ->
          value = lookup(acc, key)
          if is_nil(value), do: {:halt, nil}, else: {:cont, value}
      end
    end)
  end

  defp map_at(_, _), do: nil

  defp message_event(%{event: event}) when is_atom(event) and not is_nil(event),
    do: Atom.to_string(event)

  defp message_event(%{event: event}) when is_binary(event) and event != "", do: event
  defp message_event(%{"event" => event}) when is_binary(event) and event != "", do: event
  defp message_event(_), do: nil
end
