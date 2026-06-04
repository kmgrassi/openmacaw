defmodule SymphonyElixirWeb.Plugs.RequireServiceRoleBearer do
  @moduledoc """
  Requires an internal bearer token for operational runtime HTTP APIs.
  """

  import Plug.Conn

  alias SymphonyElixir.Supabase

  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    with {:ok, expected} <- Supabase.service_role_key(),
         ["Bearer " <> provided] <- get_req_header(conn, "authorization"),
         true <- secure_compare(provided, expected) do
      conn
    else
      {:error, :missing} ->
        respond(conn, 503, "service_role_unconfigured", "Service-role authentication is not configured")

      _other ->
        respond(conn, 401, "auth_required", "Service-role bearer token is required")
    end
  end

  defp secure_compare(left, right)
       when is_binary(left) and is_binary(right) and byte_size(left) == byte_size(right) do
    Plug.Crypto.secure_compare(left, right)
  end

  defp secure_compare(_left, _right), do: false

  defp respond(conn, status, code, message) do
    body = Jason.encode!(%{error: %{code: code, message: message}})

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, body)
    |> halt()
  end
end
