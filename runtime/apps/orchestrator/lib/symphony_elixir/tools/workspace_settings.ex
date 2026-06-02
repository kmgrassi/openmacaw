defmodule SymphonyElixir.Tools.WorkspaceSettings do
  @moduledoc false

  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.WorkspaceSettings.Repository

  @operations ~w(read create update upsert delete)

  @impl true
  def name, do: "workspace_settings.manage"

  @impl true
  def description do
    "Read, create, update, upsert, or delete workspace settings for the current workspace. Use this when a user asks to inspect or change workspace-level settings such as learning_enabled, tracker_kind, or max_concurrent_agents."
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["operation"],
      "properties" => %{
        "operation" => %{
          "type" => "string",
          "enum" => @operations,
          "description" => "CRUD operation to perform. Use upsert when the user asks to update settings and a settings row may not exist yet."
        },
        "workspace_id" => %{
          "type" => "string",
          "description" => "Optional workspace id. When provided, it must match the runtime workspace context."
        },
        "settings" => %{
          "type" => "object",
          "additionalProperties" => false,
          "description" => "Settings fields for create, update, or upsert.",
          "properties" => %{
            "learning_enabled" => %{
              "type" => "boolean",
              "description" => "Whether workspace learning/memory is enabled."
            },
            "tracker_kind" => %{
              "type" => "string",
              "enum" => ~w(linear memory database github api),
              "description" => "Tracker backend for this workspace."
            },
            "tracker_credential_id" => %{
              "type" => ["string", "null"],
              "description" => "Credential row id for tracker backends that require credentials."
            },
            "max_concurrent_agents" => %{
              "type" => "integer",
              "minimum" => 1,
              "maximum" => 50,
              "description" => "Maximum number of agents that may run concurrently in this workspace. Defaults to 10; hard max is 50."
            }
          }
        },
        "updated_by_user_id" => %{
          "type" => "string",
          "description" => "Optional user id to store in updated_by_user_id."
        }
      }
    }
  end

  @impl true
  def bundle, do: [:planner, :universal]

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    operation = Map.get(arguments, "operation") || Map.get(arguments, :operation)

    with {:ok, workspace_id} <- workspace_id(arguments, context) do
      opts = repository_opts(arguments, context, workspace_id)

      case operation do
        "read" -> with_operation("read", Repository.read(workspace_id, opts))
        "create" -> with_operation("create", Repository.create(workspace_id, settings(arguments), opts))
        "update" -> with_operation("update", Repository.update(workspace_id, settings(arguments), opts))
        "upsert" -> with_operation("upsert", Repository.upsert(workspace_id, settings(arguments), opts))
        "delete" -> with_operation("delete", Repository.delete(workspace_id, opts))
        _other -> {:error, {:unsupported_workspace_settings_operation, operation, @operations}}
      end
    end
  end

  def execute(_arguments, _context), do: {:error, :invalid_arguments}

  defp with_operation(operation, {:ok, result}) when is_map(result) do
    {:ok, Map.put(result, "operation", operation)}
  end

  defp with_operation(_operation, {:error, reason}), do: {:error, reason}

  defp workspace_id(arguments, context) do
    argument_workspace_id = Map.get(arguments, "workspace_id") || Map.get(arguments, :workspace_id)
    context_workspace_id = Map.get(context, "workspace_id") || Map.get(context, :workspace_id)

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

  defp settings(arguments) do
    case Map.get(arguments, "settings") || Map.get(arguments, :settings) do
      settings when is_map(settings) -> settings
      _other -> %{}
    end
  end

  defp repository_opts(arguments, context, workspace_id) do
    []
    |> maybe_put(:config, Map.get(context, :config) || Map.get(context, "config"))
    |> maybe_put(:req_options, Map.get(context, :req_options) || Map.get(context, "req_options"))
    |> maybe_put(:workspace_id, workspace_id)
    |> maybe_put(:updated_by_user_id, updated_by_user_id(arguments, context))
  end

  defp updated_by_user_id(arguments, context) do
    Map.get(arguments, "updated_by_user_id") ||
      Map.get(arguments, :updated_by_user_id) ||
      Map.get(context, "updated_by_user_id") ||
      Map.get(context, :updated_by_user_id) ||
      get_in(context, [:actor, :user_id]) ||
      get_in(context, ["actor", "user_id"])
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)
end
