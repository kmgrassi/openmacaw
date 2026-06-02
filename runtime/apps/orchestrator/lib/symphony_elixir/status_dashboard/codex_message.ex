defmodule SymphonyElixir.StatusDashboard.CodexMessage do
  @moduledoc false

  alias SymphonyElixir.StatusDashboard.CodexMessage.{
    ItemAndToolEvents,
    OutputFormatting,
    PayloadExtraction,
    RateLimitAndTokenEvents,
    SessionAndTurnEvents
  }

  @event_families [
    SessionAndTurnEvents,
    ItemAndToolEvents,
    RateLimitAndTokenEvents
  ]

  @method_families [
    SessionAndTurnEvents,
    RateLimitAndTokenEvents,
    ItemAndToolEvents
  ]

  @doc false
  @spec humanize(term()) :: String.t()
  def humanize(nil), do: "no codex message yet"

  def humanize(%{event: event, message: message}) do
    payload = PayloadExtraction.unwrap_payload(message)

    (humanize_event(event, message, payload) || OutputFormatting.humanize_payload(payload))
    |> OutputFormatting.truncate(140)
  end

  def humanize(%{message: message}) do
    message
    |> PayloadExtraction.unwrap_payload()
    |> OutputFormatting.humanize_payload()
    |> OutputFormatting.truncate(140)
  end

  def humanize(message) do
    message
    |> PayloadExtraction.unwrap_payload()
    |> OutputFormatting.humanize_payload()
    |> OutputFormatting.truncate(140)
  end

  @doc false
  @spec humanize_method(String.t(), term()) :: String.t()
  def humanize_method(method, payload) do
    Enum.find_value(@method_families, fn family ->
      family.humanize_method(method, payload)
    end) || default_humanize_method(method, payload)
  end

  defp humanize_event(event, message, payload) do
    Enum.find_value(@event_families, fn family ->
      family.humanize_event(event, message, payload)
    end)
  end

  defp default_humanize_method(method, payload) do
    msg_type =
      PayloadExtraction.map_path(payload, ["params", "msg", "type"]) ||
        PayloadExtraction.map_path(payload, [:params, :msg, :type])

    if is_binary(msg_type) do
      "#{method} (#{msg_type})"
    else
      method
    end
  end
end
