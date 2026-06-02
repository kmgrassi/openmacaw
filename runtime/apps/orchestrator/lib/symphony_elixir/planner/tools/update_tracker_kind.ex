defmodule SymphonyElixir.Planner.Tools.UpdateTrackerKind do
  @moduledoc false

  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.{Tracker, WorkspaceSettings.Repository}

  @tracker_kinds ~w(linear memory database github api)

  @impl true
  def name, do: "workspace_settings.update_tracker_kind"

  @impl true
  def description do
    "Update the current workspace tracker kind. Use credential_id when selecting linear or github."
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["tracker_kind"],
      "properties" => %{
        "tracker_kind" => %{
          "type" => "string",
          "enum" => @tracker_kinds,
          "description" => "Tracker backend for this workspace."
        },
        "credential_id" => %{
          "type" => ["string", "null"],
          "description" => "Credential row id. Required for linear and github; omit or null for database, memory, and api."
        },
        "workspace_id" => %{
          "type" => "string",
          "description" => "Optional workspace id. When provided, it must match the runtime workspace context."
        },
        "updated_by_user_id" => %{
          "type" => "string",
          "description" => "Optional user id to store in updated_by_user_id."
        }
      }
    }
  end

  @impl true
  def bundle, do: :planner

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    with {:ok, workspace_id} <- workspace_id(arguments, context),
         {:ok, row} <-
           Repository.update_tracker_kind(
             workspace_id,
             value(arguments, "tracker_kind"),
             value(arguments, "credential_id"),
             repository_opts(arguments, context, workspace_id)
           ) do
      :ok = Tracker.invalidate_adapter_cache(workspace_id)
      {:ok, Map.put(row, "operation", "update_tracker_kind")}
    end
  end

  def execute(_arguments, _context), do: {:error, :invalid_arguments}

  defp workspace_id(arguments, context) do
    argument_workspace_id = value(arguments, "workspace_id")
    context_workspace_id = value(context, "workspace_id")

    case {context_workspace_id, argument_workspace_id} do
      {workspace_id, nil} when is_binary(workspace_id) and workspace_id != "" ->
        {:ok, workspace_id}

      {workspace_id, workspace_id} when is_binary(workspace_id) and workspace_id != "" ->
        {:ok, workspace_id}

      {workspace_id, other_workspace_id}
      when is_binary(workspace_id) and workspace_id != "" and is_binary(other_workspace_id) and
             other_workspace_id != "" ->
        {:error, {:workspace_id_mismatch, workspace_id, other_workspace_id}}

      _other ->
        {:error, :missing_workspace_id}
    end
  end

  defp repository_opts(arguments, context, workspace_id) do
    []
    |> maybe_put(:config, value(context, "config"))
    |> maybe_put(:req_options, value(context, "req_options"))
    |> maybe_put(:workspace_id, workspace_id)
    |> maybe_put(:updated_by_user_id, updated_by_user_id(arguments, context))
  end

  defp updated_by_user_id(arguments, context) do
    value(arguments, "updated_by_user_id") ||
      value(context, "updated_by_user_id") ||
      get_in(context, [:actor, :user_id]) ||
      get_in(context, ["actor", "user_id"])
  end

  defp value(map, key) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)
end
