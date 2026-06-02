defmodule SymphonyElixirWeb.LocalRuntimeController do
  @moduledoc """
  API hooks for local helper capability registration and probe snapshots.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.LocalRuntime.Registry

  @spec register(Conn.t(), map()) :: Conn.t()
  def register(conn, params) do
    write_snapshot(conn, params, &Registry.register/1)
  end

  @spec probe(Conn.t(), map()) :: Conn.t()
  def probe(conn, params) do
    write_snapshot(conn, params, &Registry.probe/1)
  end

  @spec capabilities(Conn.t(), map()) :: Conn.t()
  def capabilities(conn, params) do
    filters =
      [
        workspace_id: clean_param(params["workspace_id"]),
        machine_id: clean_param(params["machine_id"]),
        runner_kind: clean_param(params["runner_kind"]),
        provider: clean_param(params["provider"]),
        model: clean_param(params["model"])
      ]

    json(conn, %{capabilities: Registry.list(filters)})
  end

  defp write_snapshot(conn, params, fun) do
    case fun.(params) do
      {:ok, entries} ->
        json(conn, %{ok: true, capabilities: entries})

      {:error, reason} ->
        conn
        |> put_status(400)
        |> json(%{ok: false, error: error_payload(reason)})
    end
  end

  defp error_payload({:missing_required_field, field}) do
    %{code: "invalid_capability_frame", message: "Missing required field: #{field}"}
  end

  defp error_payload(:no_capabilities) do
    %{code: "invalid_capability_frame", message: "No runner/model capabilities were provided"}
  end

  defp error_payload(_reason) do
    %{code: "invalid_capability_frame", message: "Invalid local capability frame"}
  end

  defp clean_param(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp clean_param(_value), do: nil
end
