defmodule SymphonyElixir.CoreTestSupport do
  import ExUnit.Assertions

  def assert_due_at_window(due_at_ms, before_ms, after_ms, expected_delay_ms, slack_ms \\ 500) do
    assert due_at_ms >= before_ms + expected_delay_ms
    assert due_at_ms <= after_ms + expected_delay_ms + slack_ms
  end

  def restore_symphony_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  def restore_symphony_env(key, value), do: Application.put_env(:symphony_elixir, key, value)

  def decode_json_logs(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/(\{.*\})/, line) do
        [_, json] ->
          case Jason.decode(json) do
            {:ok, payload} -> [payload]
            {:error, _reason} -> []
          end

        _ ->
          []
      end
    end)
  end
end
