defmodule SymphonyElixirWeb.GatewaySocket.ConnectionMetadata do
  @moduledoc """
  Protocol-facing helpers for deriving gateway socket connection metadata.
  """

  alias SymphonyElixir.Gateway.SharedSessionKey
  alias SymphonyElixir.RuntimeLog

  @abnormal_close_error_code "gateway_ws_closed_abnormally"

  @spec scope_from_query(map()) :: map() | nil
  def scope_from_query(%{"agent_id" => agent_id, "workspace_id" => workspace_id, "user_id" => user_id})
      when is_binary(agent_id) and is_binary(workspace_id) and is_binary(user_id) do
    if blank?(agent_id) or blank?(workspace_id) or blank?(user_id) do
      nil
    else
      %{
        agent_id: agent_id,
        workspace_id: workspace_id,
        user_id: user_id,
        session_key: SharedSessionKey.for_agent(workspace_id, agent_id)
      }
    end
  end

  def scope_from_query(_params), do: nil

  @spec connection_id_from(map() | nil, map() | nil) :: String.t()
  def connection_id_from(query_params, request_headers) do
    from_query =
      Map.get(query_params || %{}, "connection_id") || Map.get(query_params || %{}, "conn_id")

    from_headers =
      request_headers
      |> Map.new(fn {key, value} -> {String.downcase(to_string(key)), value} end)
      |> Map.get("x-connection-id")

    case from_query || from_headers do
      value when is_binary(value) and value != "" -> value
      _ -> RuntimeLog.generate_connection_id()
    end
  end

  @spec close_fields(term(), non_neg_integer()) :: map()
  def close_fields(reason, protocol_version) do
    %{
      close_code: close_code(reason),
      close_reason: inspect(reason),
      error_code: close_error_code(reason),
      protocol_version: protocol_version
    }
  end

  defp blank?(value), do: String.trim(value) == ""

  defp close_code({:remote, code, _reason}), do: code
  defp close_code({:remote, code, _reason, _details}), do: code
  defp close_code({:local, code, _reason}), do: code
  defp close_code({:local, code, _reason, _details}), do: code
  defp close_code(:normal), do: 1000
  defp close_code(_reason), do: nil

  defp close_error_code(:normal), do: nil
  defp close_error_code({:remote, 1000, _reason}), do: nil
  defp close_error_code({:remote, 1000, _reason, _details}), do: nil
  defp close_error_code({:local, 1000, _reason}), do: nil
  defp close_error_code({:local, 1000, _reason, _details}), do: nil
  defp close_error_code({:remote, _code, _reason}), do: @abnormal_close_error_code
  defp close_error_code({:remote, _code, _reason, _details}), do: @abnormal_close_error_code
  defp close_error_code({:local, _code, _reason}), do: @abnormal_close_error_code
  defp close_error_code({:local, _code, _reason, _details}), do: @abnormal_close_error_code
  defp close_error_code(_reason), do: @abnormal_close_error_code
end
