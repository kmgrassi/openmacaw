defmodule SymphonyElixir.Manager.Workspaces.Database do
  @moduledoc """
  PostgREST-backed workspace source for manager scheduler bootstrap.

  The manager is enabled from workspace-scoped `gateway_config` rows whose
  `config_json.runners.manager` entry is present and not disabled.
  """

  @behaviour SymphonyElixir.Manager.Workspaces

  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Supabase

  @impl true
  def list_active_workspace_ids do
    case config() do
      {:ok, config} -> do_list_active_workspace_ids(config)
      {:error, :not_configured} -> {:ok, []}
    end
  end

  @doc false
  def req_options,
    do: Application.get_env(:symphony_elixir, :manager_workspaces_req_options, [])

  defp do_list_active_workspace_ids(config) do
    query = %{
      "select" => "scope_id,config_json",
      "scope_type" => "eq.workspace",
      "order" => "updated_at.desc.nullslast"
    }

    case PostgRESTClient.get(PostgRESTClient.new(config, req_options()), config.table, query,
           log_metadata: %{
             caller: "manager.workspaces.list_active_workspace_ids",
             action: "manager.workspaces.list_active_workspace_ids",
             table: config.table
           }
         ) do
      {:ok, rows} when is_list(rows) ->
        {:ok, rows |> Enum.flat_map(&workspace_id/1) |> Enum.uniq()}

      {:ok, _body} ->
        {:error, :invalid_response}

      {:error, _reason} = error ->
        error
    end
  end

  defp workspace_id(%{"scope_id" => workspace_id, "config_json" => config_json})
       when is_binary(workspace_id) and workspace_id != "" do
    if manager_configured?(config_json), do: [workspace_id], else: []
  end

  defp workspace_id(_row), do: []

  defp manager_configured?(%{"runners" => %{"manager" => false}}), do: false
  defp manager_configured?(%{"runners" => %{"manager" => nil}}), do: false
  defp manager_configured?(%{"runners" => %{"manager" => manager}}), do: manager != %{}
  defp manager_configured?(_config_json), do: false

  defp config do
    raw =
      Application.get_env(:symphony_elixir, :manager_workspaces, [])
      |> Enum.into(%{})
      |> Map.put_new(:table, "gateway_config")

    try do
      {:ok, Supabase.merge_connection!(raw)}
    rescue
      ArgumentError -> {:error, :not_configured}
    end
  end
end
