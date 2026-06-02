defmodule SymphonyElixir.UsageExtraction do
  @moduledoc """
  Extracts token usage and rate-limit payloads from runner updates.
  """

  @type payload :: term()
  @type token_usage :: map()
  @type rate_limits :: map()

  @absolute_token_paths [
    ["params", "msg", "payload", "info", "total_token_usage"],
    [:params, :msg, :payload, :info, :total_token_usage],
    ["params", "msg", "info", "total_token_usage"],
    [:params, :msg, :info, :total_token_usage],
    ["params", "tokenUsage", "total"],
    [:params, :tokenUsage, :total],
    ["tokenUsage", "total"],
    [:tokenUsage, :total]
  ]

  @token_fields [
    :input_tokens,
    :output_tokens,
    :total_tokens,
    :prompt_tokens,
    :completion_tokens,
    :inputTokens,
    :outputTokens,
    :totalTokens,
    :promptTokens,
    :completionTokens,
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "promptTokens",
    "completionTokens"
  ]

  @doc """
  Returns the first cumulative token usage map found in an update.
  """
  @spec extract_tokens(payload()) :: token_usage()
  def extract_tokens(update) do
    payloads = token_payload_candidates(update)

    Enum.find_value(payloads, &absolute_token_usage_from_payload/1) ||
      Enum.find_value(payloads, &turn_completed_usage_from_payload/1) ||
      %{}
  end

  @doc """
  Returns candidate payloads in the same precedence order used by token extraction.
  """
  @spec token_payload_candidates(payload()) :: [payload()]
  def token_payload_candidates(update) when is_map(update) do
    [
      update[:usage],
      Map.get(update, "usage"),
      Map.get(update, :usage),
      update[:payload],
      Map.get(update, "payload"),
      update
    ]
  end

  def token_payload_candidates(update), do: [update]

  @doc """
  Returns the first rate-limit map found in an update.
  """
  @spec extract_rate_limits(payload()) :: rate_limits() | nil
  def extract_rate_limits(update) when is_map(update) do
    rate_limits_from_payload(update[:rate_limits]) ||
      rate_limits_from_payload(Map.get(update, "rate_limits")) ||
      rate_limits_from_payload(Map.get(update, :rate_limits)) ||
      rate_limits_from_payload(update[:payload]) ||
      rate_limits_from_payload(Map.get(update, "payload")) ||
      rate_limits_from_payload(update)
  end

  def extract_rate_limits(update), do: rate_limits_from_payload(update)

  @spec payload_get(payload(), atom() | String.t() | [atom() | String.t()]) :: non_neg_integer() | nil
  def payload_get(payload, fields) when is_list(fields) do
    Enum.find_value(fields, fn field -> map_integer_value(payload, field) end)
  end

  def payload_get(payload, field), do: map_integer_value(payload, field)

  defp absolute_token_usage_from_payload(payload) when is_map(payload) do
    explicit_map_at_paths(payload, @absolute_token_paths)
  end

  defp absolute_token_usage_from_payload(_payload), do: nil

  defp turn_completed_usage_from_payload(payload) when is_map(payload) do
    method = Map.get(payload, "method") || Map.get(payload, :method)

    if method in ["turn/completed", :turn_completed] do
      direct =
        Map.get(payload, "usage") ||
          Map.get(payload, :usage) ||
          map_at_path(payload, ["params", "usage"]) ||
          map_at_path(payload, [:params, :usage])

      if is_map(direct) and integer_token_map?(direct), do: direct
    end
  end

  defp turn_completed_usage_from_payload(_payload), do: nil

  defp rate_limits_from_payload(payload) when is_map(payload) do
    direct = Map.get(payload, "rate_limits") || Map.get(payload, :rate_limits)

    cond do
      rate_limits_map?(direct) ->
        direct

      rate_limits_map?(payload) ->
        payload

      true ->
        rate_limit_payloads(payload)
    end
  end

  defp rate_limits_from_payload(payload) when is_list(payload) do
    rate_limit_payloads(payload)
  end

  defp rate_limits_from_payload(_payload), do: nil

  defp rate_limit_payloads(payload) when is_map(payload) do
    Map.values(payload)
    |> Enum.reduce_while(nil, fn
      value, nil ->
        case rate_limits_from_payload(value) do
          nil -> {:cont, nil}
          rate_limits -> {:halt, rate_limits}
        end

      _value, result ->
        {:halt, result}
    end)
  end

  defp rate_limit_payloads(payload) when is_list(payload) do
    payload
    |> Enum.reduce_while(nil, fn
      value, nil ->
        case rate_limits_from_payload(value) do
          nil -> {:cont, nil}
          rate_limits -> {:halt, rate_limits}
        end

      _value, result ->
        {:halt, result}
    end)
  end

  defp rate_limits_map?(payload) when is_map(payload) do
    limit_id =
      Map.get(payload, "limit_id") ||
        Map.get(payload, :limit_id) ||
        Map.get(payload, "limit_name") ||
        Map.get(payload, :limit_name)

    has_buckets =
      Enum.any?(
        ["primary", :primary, "secondary", :secondary, "credits", :credits],
        &Map.has_key?(payload, &1)
      )

    !is_nil(limit_id) and has_buckets
  end

  defp rate_limits_map?(_payload), do: false

  defp explicit_map_at_paths(payload, paths) when is_map(payload) and is_list(paths) do
    Enum.find_value(paths, fn path ->
      value = map_at_path(payload, path)

      if is_map(value) and integer_token_map?(value), do: value
    end)
  end

  defp explicit_map_at_paths(_payload, _paths), do: nil

  defp map_at_path(payload, path) when is_map(payload) and is_list(path) do
    Enum.reduce_while(path, payload, fn key, acc ->
      if is_map(acc) and Map.has_key?(acc, key) do
        {:cont, Map.get(acc, key)}
      else
        {:halt, nil}
      end
    end)
  end

  defp map_at_path(_payload, _path), do: nil

  defp integer_token_map?(payload) do
    Enum.any?(@token_fields, fn field ->
      value = payload_get(payload, field)
      !is_nil(integer_like(value))
    end)
  end

  defp map_integer_value(payload, field) do
    if is_map(payload) do
      value = Map.get(payload, field)
      integer_like(value)
    else
      nil
    end
  end

  defp integer_like(value) when is_integer(value) and value >= 0, do: value

  defp integer_like(value) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {num, _} when num >= 0 -> num
      _ -> nil
    end
  end

  defp integer_like(_value), do: nil
end
