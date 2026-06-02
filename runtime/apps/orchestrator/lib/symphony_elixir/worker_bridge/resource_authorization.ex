defmodule SymphonyElixir.WorkerBridge.ResourceAuthorization do
  @moduledoc """
  Validates resource grant metadata before worker materialization.

  This boundary is intentionally resource-scoped. Tool grants decide whether a
  tool action may be attempted; resource grants decide whether the target
  repository/resource may be materialized for this agent and execution mode.
  """

  alias SymphonyElixir.RuntimeLog

  @type context :: %{
          workspace_id: String.t() | nil,
          agent_id: String.t() | nil,
          execution_mode: String.t(),
          session_id: String.t() | nil,
          run_id: String.t() | nil
        }

  @type authorized_resource :: %{
          id: String.t(),
          type: String.t(),
          grant_id: String.t(),
          grant_version: String.t(),
          mode: String.t(),
          credential_ref: map(),
          required: boolean()
        }

  @callback validate_resource_grant(map(), context()) :: {:ok, map()} | {:error, term()}

  @default_mode "planning_readonly"

  @spec authorize(map()) :: {:ok, [authorized_resource()]} | {:error, term()}
  def authorize(params) when is_map(params) do
    context = context(params)

    with {:ok, resources} <- resource_descriptors(params) do
      resources
      |> Enum.reduce_while({:ok, []}, fn resource, {:ok, authorized} ->
        case authorize_resource(resource, context) do
          {:ok, safe_resource} ->
            {:cont, {:ok, [safe_resource | authorized]}}

          {:error, reason} ->
            log(:warning, :resource_authorization_denied, resource, context, reason)
            {:halt, {:error, reason}}
        end
      end)
      |> case do
        {:ok, authorized} -> {:ok, Enum.reverse(authorized)}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @spec revalidate([authorized_resource()], map()) ::
          {:ok, [authorized_resource()]} | {:error, term()}
  def revalidate(resources, session) when is_list(resources) and is_map(session) do
    context = context(session)

    resources
    |> Enum.reduce_while({:ok, []}, fn resource, {:ok, refreshed} ->
      case revalidate_resource(resource, context) do
        {:ok, safe_resource} ->
          {:cont, {:ok, [safe_resource | refreshed]}}

        {:error, reason} ->
          log(:warning, :resource_authorization_revoked, resource, context, reason)
          {:halt, {:error, {:resource_authorization_revoked, reason}}}
      end
    end)
    |> case do
      {:ok, refreshed} -> {:ok, Enum.reverse(refreshed)}
      {:error, reason} -> {:error, reason}
    end
  end

  def revalidate(_resources, _session), do: {:error, :invalid_resource_authorization_context}

  @spec context(map()) :: context()
  def context(params) when is_map(params) do
    %{
      workspace_id: string_value(params, "workspace_id"),
      agent_id: string_value(params, "agent_id"),
      execution_mode: string_value(params, "execution_mode") || @default_mode,
      session_id: string_value(params, "session_id"),
      run_id: string_value(params, "run_id")
    }
  end

  defp resource_descriptors(params) do
    case Map.get(params, "resources", []) do
      resources when is_list(resources) -> {:ok, resources}
      _resources -> {:error, :invalid_resources}
    end
  end

  defp authorize_resource(resource, context) when is_map(resource) do
    with {:ok, grant} <- resolver().validate_resource_grant(resource, context),
         {:ok, safe_resource} <- validate(resource, grant, context) do
      log(:info, :resource_authorization_allowed, safe_resource, context, nil)
      {:ok, safe_resource}
    end
  rescue
    error in [ArgumentError] -> {:error, {:resource_authorization_unavailable, Exception.message(error)}}
  end

  defp authorize_resource(_resource, _context), do: {:error, :invalid_resource}

  defp revalidate_resource(resource, context) when is_map(resource) do
    lookup_resource = %{
      "id" => resource.id,
      "type" => resource.type,
      "grant" => %{
        "id" => resource.grant_id,
        "version" => resource.grant_version,
        "workspace_id" => context.workspace_id,
        "agent_id" => context.agent_id,
        "enabled" => true,
        "mode" => resource.mode,
        "credential_ref" => resource.credential_ref
      }
    }

    with {:ok, grant} <- resolver().validate_resource_grant(lookup_resource, context),
         {:ok, safe_resource} <- validate(lookup_resource, grant, context) do
      {:ok, safe_resource}
    end
  rescue
    error in [ArgumentError] -> {:error, {:resource_authorization_unavailable, Exception.message(error)}}
  end

  defp validate(resource, grant, context) when is_map(resource) and is_map(grant) do
    resource_id = string_value(resource, "id")
    resource_type = string_value(resource, "type")
    grant_id = string_value(grant, "id")
    grant_version = string_value(grant, "version")
    grant_workspace_id = string_value(grant, "workspace_id")
    grant_agent_id = string_value(grant, "agent_id")
    credential_ref = map_value(grant, "credential_ref")
    required = Map.get(resource, "required", true)

    cond do
      blank?(resource_id) ->
        {:error, :missing_resource_id}

      blank?(resource_type) ->
        {:error, :missing_resource_type}

      blank?(grant_id) ->
        {:error, {:missing_resource_grant, resource_id}}

      blank?(grant_version) ->
        {:error, {:missing_resource_grant_version, resource_id, grant_id}}

      grant_workspace_id != context.workspace_id ->
        {:error, {:resource_grant_workspace_mismatch, resource_id, grant_id}}

      grant_agent_id != context.agent_id ->
        {:error, {:resource_grant_agent_mismatch, resource_id, grant_id}}

      Map.get(grant, "enabled") != true ->
        {:error, {:resource_grant_disabled, resource_id, grant_id}}

      not mode_allows?(grant, context.execution_mode) ->
        {:error, {:resource_grant_mode_denied, resource_id, grant_id, context.execution_mode}}

      credential_ref == %{} ->
        {:error, {:missing_resource_credential, resource_id, grant_id}}

      required not in [true, false] ->
        {:error, {:invalid_resource_required_flag, resource_id}}

      true ->
        {:ok,
         %{
           id: resource_id,
           type: resource_type,
           grant_id: grant_id,
           grant_version: grant_version,
           mode: context.execution_mode,
           credential_ref: credential_ref,
           required: required
         }}
    end
  end

  defp validate(_resource, _grant, _context), do: {:error, :invalid_resource_grant}

  defp mode_allows?(grant, execution_mode) do
    cond do
      string_value(grant, "mode") == execution_mode ->
        true

      is_list(Map.get(grant, "modes")) ->
        execution_mode in Map.get(grant, "modes")

      true ->
        false
    end
  end

  defp resolver do
    Application.get_env(
      :symphony_elixir,
      :worker_bridge_resource_authorization_resolver,
      __MODULE__.EmbeddedGrantResolver
    )
  end

  defp log(level, event, resource, context, reason) do
    RuntimeLog.log(level, event, %{
      workspace_id: context.workspace_id,
      agent_id: context.agent_id,
      session_id: context.session_id,
      run_id: context.run_id,
      execution_mode: context.execution_mode,
      resource_id: string_value(resource, "id"),
      resource_type: string_value(resource, "type"),
      resource_grant_id: string_value(resource, "grant_id") || get_in(resource, ["grant", "id"]),
      reason: reason
    })
  end

  defp string_value(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: nil, else: value

      _value ->
        nil
    end
  rescue
    ArgumentError -> nil
  end

  defp map_value(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, to_string(key)) do
      value when is_map(value) -> value
      _value -> %{}
    end
  end

  defp blank?(value), do: not (is_binary(value) and value != "")
end

defmodule SymphonyElixir.WorkerBridge.ResourceAuthorization.EmbeddedGrantResolver do
  @moduledoc false

  @behaviour SymphonyElixir.WorkerBridge.ResourceAuthorization

  @impl true
  def validate_resource_grant(%{"grant" => grant}, _context) when is_map(grant), do: {:ok, grant}
  def validate_resource_grant(_resource, _context), do: {:error, :missing_resource_grant_metadata}
end
