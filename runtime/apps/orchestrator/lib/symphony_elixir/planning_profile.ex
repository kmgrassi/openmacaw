defmodule SymphonyElixir.PlanningProfile do
  @moduledoc """
  Resolved planning-profile state and planner-editable planning profile tools.

  The profile resolver loads scoped rows from `planning_profile` in priority
  order and always falls back to a hard-coded baseline so planning sessions
  remain usable while the database is missing or partially migrated.
  """

  alias SymphonyElixir.PostgRESTClient

  @table "planning_profile"
  @scope_types ~w(global workspace repository agent)
  @mutable_fields ~w(description instructions definition_of_done validation_commands environment_notes repo_boundaries security_constraints handoff_policy metadata is_active updated_by_user_id deleted_by_user_id deleted_reason)
  @json_array_fields ~w(definition_of_done validation_commands)
  @json_object_fields ~w(repo_boundaries security_constraints handoff_policy metadata)

  @default_profile %{
    "id" => nil,
    "workspace_id" => nil,
    "scope_type" => "global",
    "scope_id" => "global",
    "name" => "default",
    "description" => "Hard-coded planning fallback.",
    "instructions" =>
      "Clarify scope, identify repo-specific constraints, prefer small reviewable changes, preserve user work, and define verification before implementation.",
    "definition_of_done" => [
      "The requested behavior is implemented or a blocker is documented.",
      "Relevant automated checks have been run, or skipped checks are explicitly explained.",
      "User-owned or unrelated worktree changes are preserved.",
      "The final handoff states changed behavior, verification, and residual risks."
    ],
    "validation_commands" => [
      "Run the narrowest relevant tests first.",
      "Run broader typecheck/build checks when the change touches shared contracts or frontend/runtime boundaries."
    ],
    "environment_notes" =>
      "Prefer repository-local tooling and documented setup. Do not assume credentials or destructive operations are available unless explicitly provided.",
    "repo_boundaries" => %{
      "default" =>
        "Inspect repo instructions and existing patterns before editing. Keep changes within the requested repo unless cross-repo coordination is required."
    },
    "security_constraints" => %{
      "preserve_user_changes" => true,
      "require_approval_for_destructive_operations" => true,
      "avoid_secret_exposure" => true
    },
    "handoff_policy" => %{
      "include_summary" => true,
      "include_verification" => true,
      "include_blockers" => true
    },
    "metadata" => %{"source" => "runtime_fallback"},
    "is_active" => true,
    "version" => nil,
    "deleted_at" => nil
  }

  @spec fallback_profile() :: map()
  def fallback_profile, do: @default_profile

  @spec resolve(map(), keyword()) :: map()
  def resolve(agent \\ %{}, opts \\ []) when is_map(agent) do
    scopes = resolution_scopes(agent)

    case client(opts) do
      {:ok, client} ->
        scopes
        |> Enum.reduce(@default_profile, fn scope, acc ->
          case fetch_profile(client, scope) do
            {:ok, nil} -> acc
            {:ok, profile} -> merge_profile(acc, profile)
            {:error, _reason} -> acc
          end
        end)

      {:error, _reason} ->
        @default_profile
    end
  end

  @spec render_instructions(map()) :: String.t()
  def render_instructions(profile) when is_map(profile) do
    sections =
      [
        {"Instructions", Map.get(profile, "instructions")},
        {"Definition of Done", bullet_list(Map.get(profile, "definition_of_done", []))},
        {"Validation", bullet_list(Map.get(profile, "validation_commands", []))},
        {"Environment Notes", Map.get(profile, "environment_notes")},
        {"Repo Boundaries", render_map_section(Map.get(profile, "repo_boundaries", %{}))},
        {"Security Constraints",
         render_map_section(Map.get(profile, "security_constraints", %{}))},
        {"Handoff Policy", render_map_section(Map.get(profile, "handoff_policy", %{}))}
      ]
      |> Enum.flat_map(fn
        {_title, nil} -> []
        {_title, ""} -> []
        {_title, []} -> []
        {title, body} -> ["#{title}:\n#{body}"]
      end)

    Enum.join(
      [
        "You are a planning specialist for Symphony.",
        profile_context(profile)
      ] ++ sections ++ [agent_boundary_note()],
      "\n\n"
    )
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "planning_profile.create_update",
        "description" =>
          "Create or update a planning profile row. Use this when a user asks to adjust planning guidance, environment notes, definition of done, or handoff policy.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "properties" =>
            identity_properties(%{
              "patch" => %{
                "type" => "object",
                "additionalProperties" => false,
                "description" => "Fields to create or update on the planning profile.",
                "properties" => mutable_field_properties()
              }
            })
        }
      },
      %{
        "name" => "planning_profile.delete",
        "description" =>
          "Soft-delete a planning profile row by id or scoped identity. The deleted row is retained for auditability.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "properties" =>
            identity_properties(%{
              "reason" => %{"type" => "string", "description" => "Human-readable delete reason."},
              "deleted_by_user_id" => %{"type" => ["string", "null"]}
            })
        }
      }
    ]
  end

  @spec tool_names() :: [String.t()]
  def tool_names, do: Enum.map(tool_specs(), & &1["name"])

  @spec execute(String.t(), term(), keyword()) :: {:ok, map()} | {:error, map()}
  def execute(tool, arguments, opts \\ [])

  def execute("planning_profile.create_update", arguments, opts) do
    with {:ok, identity, patch} <- normalize_create_update(arguments),
         {:ok, client} <- client(opts) do
      create_or_update_profile(client, identity, patch)
    else
      {:error, reason} -> {:error, tool_error(reason)}
    end
  end

  def execute("planning_profile.delete", arguments, opts) do
    with {:ok, identity, patch} <- normalize_delete(arguments),
         {:ok, client} <- client(opts) do
      delete_profile(client, identity, patch)
    else
      {:error, reason} -> {:error, tool_error(reason)}
    end
  end

  def execute(tool, _arguments, _opts),
    do: {:error, %{"message" => "Unsupported planning profile tool.", "tool" => tool}}

  defp resolution_scopes(agent) do
    agent_id = field(agent, "id")
    workspace_id = field(agent, "workspace_id")

    [
      global_scope(),
      workspace_scope(workspace_id),
      agent_scope(agent_id, workspace_id)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp agent_scope(nil, _workspace_id), do: nil
  defp agent_scope(_agent_id, nil), do: nil

  defp agent_scope(agent_id, workspace_id),
    do: %{scope_type: "agent", scope_id: agent_id, workspace_id: workspace_id}

  defp workspace_scope(nil), do: nil

  defp workspace_scope(workspace_id),
    do: %{scope_type: "workspace", scope_id: workspace_id, workspace_id: workspace_id}

  defp global_scope, do: %{scope_type: "global", scope_id: "global", workspace_id: nil}

  defp fetch_profile(client, %{scope_type: "global"} = scope) do
    query =
      %{
        "scope_type" => "eq.#{scope.scope_type}",
        "scope_id" => "eq.#{scope.scope_id}",
        "workspace_id" => "is.null",
        "deleted_at" => "is.null",
        "is_active" => "eq.true",
        "select" => "*",
        "limit" => "1"
      }

    fetch_one(client, query)
  end

  defp fetch_profile(client, %{
         scope_type: scope_type,
         scope_id: scope_id,
         workspace_id: workspace_id
       }) do
    query =
      %{
        "scope_type" => "eq.#{scope_type}",
        "scope_id" => "eq.#{scope_id}",
        "workspace_id" => "eq.#{workspace_id}",
        "deleted_at" => "is.null",
        "is_active" => "eq.true",
        "select" => "*",
        "limit" => "1"
      }

    fetch_one(client, query)
  end

  defp fetch_one(client, query) do
    case PostgRESTClient.get(client, @table, query) do
      {:ok, [%{} = row | _]} -> {:ok, row}
      {:ok, []} -> {:ok, nil}
      {:ok, other} when is_list(other) -> {:ok, List.first(other)}
      {:error, _} = error -> error
    end
  end

  defp create_or_update_profile(client, identity, patch) do
    with {:ok, existing} <- fetch_existing(client, identity) do
      if is_map(existing) do
        update_profile(client, existing["id"], patch)
      else
        create_profile(client, Map.merge(identity, patch))
      end
    else
      {:error, reason} -> {:error, database_error(reason)}
    end
  end

  defp delete_profile(client, identity, patch) do
    with {:ok, existing} <- fetch_existing(client, identity) do
      if is_map(existing) do
        soft_delete_profile(client, existing["id"], patch)
      else
        {:error, not_found_error(identity)}
      end
    else
      {:error, reason} -> {:error, database_error(reason)}
    end
  end

  defp fetch_existing(client, %{"id" => id}) do
    query = %{"id" => "eq.#{id}", "select" => "*", "limit" => "1"}
    fetch_one(client, query)
  end

  defp fetch_existing(client, identity) do
    query =
      %{
        "scope_type" => "eq.#{Map.get(identity, "scope_type")}",
        "scope_id" => "eq.#{Map.get(identity, "scope_id")}",
        "workspace_id" => workspace_filter(Map.get(identity, "workspace_id")),
        "name" => "eq.#{Map.get(identity, "name")}",
        "deleted_at" => "is.null",
        "select" => "*",
        "limit" => "1"
      }

    fetch_one(client, query)
  end

  defp create_profile(client, payload) do
    case PostgRESTClient.post(client, @table, payload, prefer: "return=representation") do
      {:ok, rows} -> {:ok, success_payload("created", first_row(rows))}
      {:error, reason} -> {:error, database_error(reason)}
    end
  end

  defp update_profile(client, id, patch) do
    case PostgRESTClient.patch(client, @table, %{"id" => "eq.#{id}"}, patch,
           prefer: "return=representation"
         ) do
      {:ok, rows} -> {:ok, success_payload("updated", first_row(rows))}
      {:error, reason} -> {:error, database_error(reason)}
    end
  end

  defp soft_delete_profile(client, id, patch) do
    case PostgRESTClient.patch(client, @table, %{"id" => "eq.#{id}"}, patch,
           prefer: "return=representation"
         ) do
      {:ok, rows} -> {:ok, success_payload("deleted", first_row(rows))}
      {:error, reason} -> {:error, database_error(reason)}
    end
  end

  defp success_payload(operation, profile) when is_map(profile) do
    %{"operation" => operation, "profile" => profile, "fallbackProfile" => @default_profile}
  end

  defp normalize_create_update(arguments) when is_map(arguments) do
    patch = field(arguments, "patch") || %{}

    with {:ok, identity} <- normalize_identity(arguments),
         :ok <- validate_patch_object(patch),
         normalized_patch = normalize_patch(patch),
         :ok <- validate_patch_fields(normalized_patch),
         :ok <- validate_patch_values(normalized_patch) do
      {:ok, identity, normalized_patch}
    end
  end

  defp normalize_create_update(_arguments),
    do: {:error, argument_error("Expected a JSON object.", @mutable_fields)}

  defp normalize_delete(arguments) when is_map(arguments) do
    patch =
      %{}
      |> maybe_put("deleted_by_user_id", field(arguments, "deleted_by_user_id"))
      |> maybe_put(
        "deleted_reason",
        field(arguments, "reason") || field(arguments, "deleted_reason")
      )
      |> Map.put(
        "deleted_at",
        DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
      )
      |> Map.put("is_active", false)

    with {:ok, identity} <- normalize_identity(arguments) do
      {:ok, identity, patch}
    end
  end

  defp normalize_delete(_arguments),
    do: {:error, argument_error("Expected a JSON object.", @mutable_fields)}

  defp normalize_identity(arguments) do
    id = field(arguments, "id")
    scope_type = field(arguments, "scope_type") || "workspace"
    workspace_id = field(arguments, "workspace_id")
    scope_id = field(arguments, "scope_id")
    name = field(arguments, "name") || "default"

    cond do
      present?(id) ->
        {:ok, %{"id" => id}}

      scope_type not in @scope_types ->
        {:error,
         %{
           "message" => "Invalid planning profile scope_type.",
           "allowedScopeTypes" => @scope_types,
           "scopeType" => scope_type
         }}

      scope_type == "global" ->
        {:ok,
         %{
           "scope_type" => "global",
           "scope_id" => "global",
           "workspace_id" => nil,
           "name" => name
         }}

      !present?(workspace_id) ->
        {:error,
         %{
           "message" =>
             "workspace_id is required for workspace, repository, and agent planning profiles.",
           "requiredFields" => ["workspace_id", "scope_type", "scope_id"]
         }}

      !present?(scope_id) ->
        {:error,
         %{
           "message" => "scope_id is required unless id is provided.",
           "requiredFields" => ["scope_id"]
         }}

      true ->
        {:ok,
         %{
           "workspace_id" => workspace_id,
           "scope_type" => scope_type,
           "scope_id" => scope_id,
           "name" => name
         }}
    end
  end

  defp validate_patch_object(patch) when is_map(patch), do: :ok

  defp validate_patch_object(_patch),
    do: {:error, argument_error("patch must be a JSON object.", @mutable_fields)}

  defp validate_patch_fields(patch) do
    unknown =
      patch
      |> Map.keys()
      |> Enum.map(&to_string/1)
      |> Enum.reject(&(&1 in @mutable_fields))

    case unknown do
      [] ->
        :ok

      _ ->
        {:error,
         %{
           "message" => "Planning profile patch contains unsupported fields.",
           "allowedFields" => @mutable_fields,
           "unknownFields" => unknown,
           "identityFields" => ["id", "workspace_id", "scope_type", "scope_id", "name"]
         }}
    end
  end

  defp validate_patch_values(patch) do
    cond do
      field =
          Enum.find(@json_array_fields, fn field ->
            Map.has_key?(patch, field) and !is_list(patch[field])
          end) ->
        {:error, %{"message" => "#{field} must be a JSON array.", "field" => field}}

      field =
          Enum.find(@json_object_fields, fn field ->
            Map.has_key?(patch, field) and !is_map(patch[field])
          end) ->
        {:error, %{"message" => "#{field} must be a JSON object.", "field" => field}}

      Map.has_key?(patch, "is_active") and !is_boolean(patch["is_active"]) ->
        {:error, %{"message" => "is_active must be a boolean.", "field" => "is_active"}}

      true ->
        :ok
    end
  end

  defp normalize_patch(patch) do
    patch
    |> Enum.map(fn {key, value} -> {to_string(key), value} end)
    |> Map.new()
    |> Map.put_new("is_active", true)
  end

  defp merge_profile(base, override) when is_map(base) and is_map(override) do
    Map.merge(base, override, fn _key, left, right -> merge_value(left, right) end)
  end

  defp merge_value(left, nil), do: left
  defp merge_value(%{} = left, %{} = right), do: merge_profile(left, right)
  defp merge_value(_left, right), do: right

  defp database_error(%{} = reason), do: reason
  defp database_error({:http_error, status, body}), do: http_error_payload(status, body)

  defp database_error({:request_failed, reason}),
    do: %{"message" => "Planning profile database request failed.", "reason" => inspect(reason)}

  defp database_error(reason),
    do: %{"message" => "Planning profile operation failed.", "reason" => inspect(reason)}

  defp tool_error(:missing_supabase_config) do
    %{
      "message" => "Planning profile database access is not configured.",
      "requiredEnvironment" => ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
      "fallbackProfile" => @default_profile
    }
  end

  defp tool_error(:not_found) do
    %{
      "message" =>
        "Planning profile was not found. Provide a valid id or workspace_id/scope_type/scope_id/name.",
      "identityFields" => ["id", "workspace_id", "scope_type", "scope_id", "name"]
    }
  end

  defp tool_error(reason),
    do: %{"message" => "Planning profile operation failed.", "reason" => inspect(reason)}

  defp argument_error(message, allowed_fields) do
    %{"message" => message, "allowedFields" => allowed_fields}
  end

  defp http_error_payload(status, body) do
    %{
      "message" => database_http_message(status, body),
      "status" => status,
      "body" => body,
      "allowedFields" => @mutable_fields
    }
  end

  defp database_http_message(_status, %{"code" => code}) when code in ["PGRST204", "42703"] do
    "Planning profile database rejected a field because the column does not exist. Use allowedFields or apply the planning_profile migration."
  end

  defp database_http_message(_status, %{"message" => message}) when is_binary(message) do
    if String.contains?(message, @table) do
      "Planning profile table does not exist. Apply the planning_profile migration before using this tool."
    else
      "Planning profile database request failed with a message: #{message}"
    end
  end

  defp database_http_message(status, _body),
    do: "Planning profile database request failed with HTTP #{status}."

  defp not_found_error(identity) do
    %{
      "message" =>
        "Planning profile was not found. Provide a valid id or workspace_id/scope_type/scope_id/name.",
      "identityFields" => Map.keys(identity)
    }
  end

  defp identity_properties(extra_properties) do
    Map.merge(
      %{
        "id" => %{
          "type" => "string",
          "description" =>
            "Existing planning_profile id. When provided, scoped identity fields are not required."
        },
        "workspace_id" => %{
          "type" => "string",
          "description" => "Workspace id for workspace, repository, and agent-scoped profiles."
        },
        "scope_type" => %{
          "type" => "string",
          "enum" => @scope_types,
          "description" =>
            "Profile scope. Global profiles are usually read-only defaults; service-role agents may update them intentionally."
        },
        "scope_id" => %{
          "type" => "string",
          "description" =>
            "Workspace id, repository id/url hash, or agent id depending on scope_type."
        },
        "name" => %{
          "type" => "string",
          "description" => "Profile name. Defaults to `default`."
        }
      },
      extra_properties
    )
  end

  defp mutable_field_properties do
    %{
      "description" => %{"type" => ["string", "null"]},
      "instructions" => %{"type" => "string"},
      "definition_of_done" => %{"type" => "array", "items" => %{"type" => "string"}},
      "validation_commands" => %{
        "type" => "array",
        "items" => %{
          "oneOf" => [
            %{"type" => "string"},
            %{"type" => "object", "additionalProperties" => true}
          ]
        }
      },
      "environment_notes" => %{"type" => "string"},
      "repo_boundaries" => %{"type" => "object", "additionalProperties" => true},
      "security_constraints" => %{"type" => "object", "additionalProperties" => true},
      "handoff_policy" => %{"type" => "object", "additionalProperties" => true},
      "metadata" => %{"type" => "object", "additionalProperties" => true},
      "is_active" => %{"type" => "boolean"},
      "updated_by_user_id" => %{"type" => ["string", "null"]}
    }
  end

  defp client(_opts) do
    raw =
      Application.get_env(:symphony_elixir, :planner_database_tools, [])
      |> Enum.into(%{})

    try do
      req_options = Application.get_env(:symphony_elixir, :planner_database_tools_req_options, [])
      {:ok, PostgRESTClient.new(raw, req_options)}
    rescue
      ArgumentError -> {:error, :missing_supabase_config}
    end
  end

  defp first_row(rows) when is_list(rows), do: List.first(rows) || %{}
  defp first_row(row) when is_map(row), do: row
  defp first_row(_other), do: %{}

  defp field(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  rescue
    ArgumentError -> Map.get(map, key)
  end

  defp present?(value), do: is_binary(value) and String.trim(value) != ""
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp workspace_filter(nil), do: "is.null"
  defp workspace_filter(value), do: "eq.#{value}"

  defp profile_context(profile) do
    [
      "Planning profile scope: #{Map.get(profile, "scope_type")} / #{Map.get(profile, "scope_id")}",
      "Planning profile version: #{inspect(Map.get(profile, "version"))}",
      "Planning profile name: #{Map.get(profile, "name")}"
    ]
    |> Enum.join("\n")
  end

  defp agent_boundary_note do
    "When a user asks to update planning guidance, use the planning profile tools to edit the stored profile instead of inventing a new instruction set."
  end

  defp bullet_list(list) when is_list(list) do
    list
    |> Enum.flat_map(fn
      item when is_binary(item) ->
        case String.trim(item) do
          "" -> []
          trimmed -> ["- #{trimmed}"]
        end

      item when is_map(item) ->
        Enum.map(item, fn {k, v} -> "- #{k}: #{inspect(v)}" end)

      _ ->
        []
    end)
    |> case do
      [] -> nil
      items -> Enum.join(items, "\n")
    end
  end

  defp render_map_section(%{} = map) do
    map
    |> Enum.map(fn {key, value} -> "- #{key}: #{inspect(value)}" end)
    |> case do
      [] -> nil
      items -> Enum.join(items, "\n")
    end
  end
end
