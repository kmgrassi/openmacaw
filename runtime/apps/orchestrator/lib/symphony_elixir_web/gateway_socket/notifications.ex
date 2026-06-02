defmodule SymphonyElixirWeb.GatewaySocket.Notifications do
  @moduledoc """
  Translates runner notifications into gateway websocket events.
  """

  @type chat_delta :: %{
          runId: String.t(),
          sessionKey: String.t(),
          state: String.t(),
          message: String.t()
        }

  @spec chat_delta_event(String.t(), String.t(), map()) :: {:ok, chat_delta()} | :ignore
  def chat_delta_event(session_key, run_id, %{event: :notification, payload: payload}) do
    case extract_delta(payload) do
      delta when is_binary(delta) ->
        {:ok,
         %{
           runId: run_id,
           sessionKey: session_key,
           state: "delta",
           message: delta
         }}

      nil ->
        :ignore
    end
  end

  def chat_delta_event(_session_key, _run_id, _message), do: :ignore

  @spec extract_delta(term()) :: String.t() | nil
  def extract_delta(payload) when is_map(payload) do
    if canonical_delta_notification?(payload) do
      extract_delta_value(payload)
    end
  end

  def extract_delta(_payload), do: nil

  defp canonical_delta_notification?(payload) do
    case map_path(payload, ["method"]) do
      nil -> true
      "item/agentMessage/delta" -> true
      _ -> false
    end
  end

  defp extract_delta_value(payload) do
    delta_paths()
    |> Enum.find_value(fn path -> map_path(payload, path) end)
    |> case do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp delta_paths do
    [
      ["params", "delta"],
      ["params", "msg", "delta"],
      ["params", "textDelta"],
      ["params", "msg", "textDelta"],
      ["params", "outputDelta"],
      ["params", "msg", "outputDelta"],
      ["params", "text"],
      ["params", "msg", "text"],
      ["params", "msg", "payload", "delta"],
      ["params", "msg", "payload", "textDelta"],
      ["params", "msg", "payload", "outputDelta"],
      ["params", "msg", "payload", "text"]
    ]
  end

  defp map_path(value, []), do: value

  defp map_path(map, [segment | rest]) when is_map(map) do
    next =
      case Map.fetch(map, segment) do
        {:ok, found} -> found
        :error -> Map.get(map, String.to_atom(segment))
      end

    map_path(next, rest)
  rescue
    ArgumentError -> nil
  end

  defp map_path(_value, _path), do: nil
end
