defmodule SymphonyElixirWeb.LocalRelayController do
  @moduledoc """
  Raw websocket upgrade endpoint for local runtime helper relay connections.
  """

  use Phoenix.Controller, formats: [:json]

  @spec upgrade(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def upgrade(conn, _params) do
    with :ok <- validate_tls_upgrade(conn),
         :ok <- validate_origin(conn) do
      state = %{
        query_params: conn.query_params,
        request_headers: Map.new(conn.req_headers),
        peer_data: conn.remote_ip
      }

      Plug.Conn.upgrade_adapter(conn, :websocket, {SymphonyElixirWeb.LocalRelaySocket, state, []})
    else
      {:error, reason} ->
        conn
        |> put_status(:forbidden)
        |> json(%{error: %{code: to_string(reason), message: safe_message(reason)}})
        |> halt()
    end
  end

  defp validate_tls_upgrade(conn) do
    cond do
      not relay_tls_required?() -> :ok
      forwarded_proto(conn) in ["https", "wss"] -> :ok
      conn.scheme == :https -> :ok
      true -> {:error, :tls_required}
    end
  end

  defp validate_origin(conn) do
    allowed_origins = relay_allowed_origins()

    case get_req_header(conn, "origin") do
      [] -> :ok
      [_origin | _rest] when allowed_origins == [] -> :ok
      [origin | _rest] -> if origin in allowed_origins, do: :ok, else: {:error, :origin_not_allowed}
    end
  end

  defp relay_tls_required? do
    Application.get_env(:symphony_elixir, :local_relay_require_tls, false) == true
  end

  defp relay_allowed_origins do
    configured_allowed_origins()
    |> List.wrap()
    |> Enum.flat_map(&split_origin_config/1)
    |> Enum.uniq()
  end

  defp configured_allowed_origins do
    case System.get_env("LOCAL_RELAY_ALLOWED_ORIGINS") do
      nil -> Application.get_env(:symphony_elixir, :local_relay_allowed_origins, [])
      value -> value
    end
  end

  defp split_origin_config(value) when is_binary(value) do
    value
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.filter(&(&1 != ""))
  end

  defp split_origin_config(value) do
    value
    |> List.wrap()
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
  end

  defp forwarded_proto(conn) do
    conn
    |> get_req_header("x-forwarded-proto")
    |> List.first()
    |> normalize_proto()
  end

  defp normalize_proto(nil), do: nil

  defp normalize_proto(value) when is_binary(value) do
    value
    |> String.split(",", parts: 2)
    |> List.first()
    |> String.trim()
    |> String.downcase()
  end

  defp safe_message(:tls_required), do: "local relay websocket requires TLS"
  defp safe_message(:origin_not_allowed), do: "local relay websocket origin is not allowed"
end
