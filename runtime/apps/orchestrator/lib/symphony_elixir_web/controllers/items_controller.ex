defmodule SymphonyElixirWeb.ItemsController do
  @moduledoc """
  Handles work item submission for the API push tracker.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Tracker.API, as: TrackerAPI

  @spec create(Conn.t(), map()) :: Conn.t()
  def create(conn, params) do
    case TrackerAPI.accept_item(params) do
      {:ok, work_item} ->
        conn
        |> put_status(201)
        |> json(%{
          id: work_item.id,
          identifier: work_item.identifier,
          title: work_item.title,
          state: work_item.state,
          source: work_item.source
        })

      {:error, {:missing_fields, fields}} ->
        conn
        |> put_status(422)
        |> json(%{error: "missing_fields", fields: fields})

      {:error, :invalid_payload} ->
        conn
        |> put_status(400)
        |> json(%{error: "invalid_payload"})

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{error: "internal_error", detail: inspect(reason)})
    end
  end
end
