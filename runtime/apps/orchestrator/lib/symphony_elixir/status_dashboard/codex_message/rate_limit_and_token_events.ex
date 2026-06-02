defmodule SymphonyElixir.StatusDashboard.CodexMessage.RateLimitAndTokenEvents do
  @moduledoc false

  alias SymphonyElixir.StatusDashboard.CodexMessage.{OutputFormatting, PayloadExtraction}

  import OutputFormatting, only: [format_rate_limits_summary: 1, format_usage_counts: 1, token_usage_paths: 0]
  import PayloadExtraction, only: [extract_first_path: 2, map_path: 2, map_value: 2]

  @spec humanize_event(atom(), term(), term()) :: nil
  def humanize_event(_event, _message, _payload), do: nil

  @spec humanize_method(String.t(), term()) :: String.t() | nil
  def humanize_method("thread/tokenUsage/updated", payload) do
    usage =
      map_path(payload, ["params", "tokenUsage", "total"]) ||
        map_path(payload, [:params, :tokenUsage, :total]) ||
        map_value(payload, ["usage", :usage])

    case format_usage_counts(usage) do
      nil -> "thread token usage updated"
      usage_text -> "thread token usage updated (#{usage_text})"
    end
  end

  def humanize_method("account/rateLimits/updated", payload) do
    rate_limits =
      map_path(payload, ["params", "rateLimits"]) ||
        map_path(payload, [:params, :rateLimits])

    "rate limits updated: #{format_rate_limits_summary(rate_limits)}"
  end

  def humanize_method("codex/event/token_count", payload), do: humanize_token_count(payload)
  def humanize_method(_method, _payload), do: nil

  @spec humanize_token_count(term()) :: String.t()
  def humanize_token_count(payload) do
    usage = extract_first_path(payload, token_usage_paths())

    case format_usage_counts(usage) do
      nil -> "token count update"
      usage_text -> "token count update (#{usage_text})"
    end
  end
end
