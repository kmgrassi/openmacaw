defmodule SymphonyElixir.Planner.DatabaseToolSpecs do
  @moduledoc false

  alias SymphonyElixir.Schema.ExecutionProfile

  @tools [
    "plan.create",
    "plan.update",
    "plan.delete",
    "task.create",
    "task.update",
    "task.schedule",
    "plan.read",
    "task.read"
  ]

  @spec tool_names() :: [String.t()]
  def tool_names, do: @tools

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "plan.create",
        "description" => "Create a plan row in the platform database.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["name"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "name" => string_schema("Plan name."),
            "description" => nullable_string_schema("Optional plan description."),
            "type" => nullable_string_schema("Optional plan type."),
            "is_ongoing" => %{"type" => ["boolean", "null"]},
            "metadata" => metadata_schema("Optional plan metadata. Use default_repository for the plan's primary repository instead of inventing ad hoc repository keys."),
            "intent" => nullable_string_schema("Optional plan intent."),
            "default_model" => nullable_string_schema("Optional default model."),
            "default_runner_kind" => nullable_string_schema("Optional default runner kind for work items in this plan."),
            "default_repository" =>
              nullable_string_schema(
                "Optional primary repository identifier. Until a plan column exists, this is stored in plan.metadata.default_repository and inherited by task.create metadata.repository when tasks omit a repository."
              )
          }
        }
      },
      %{
        "name" => "plan.update",
        "description" =>
          "Update allowed fields on a plan row scoped by plan id and workspace id. Only plan_id is required; omitted fields stay unchanged. Explicit null clears nullable fields and is rejected for non-nullable fields. Metadata is merged shallowly with existing metadata. Set status to deleted to soft-delete a plan. The result includes changed_fields and the resolved row. Pass if_updated_at from plan.read to reject the update if the row changed since it was read.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["plan_id"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "plan_id" => string_schema("Plan database UUID."),
            "if_updated_at" => nullable_date_time_schema("Optional optimistic concurrency guard. Use the updated_at value returned by plan.read; stale values reject the update."),
            "name" => nullable_string_schema("Optional updated plan name."),
            "description" => nullable_string_schema("Optional updated plan description."),
            "type" => nullable_string_schema("Optional updated plan type."),
            "is_ongoing" => %{"type" => ["boolean", "null"]},
            "status" => string_schema("Optional updated plan status. Use deleted to soft-delete a plan. Omit to leave unchanged; null is rejected."),
            "metadata" => required_object_schema("Optional plan metadata patch. Top-level keys are merged with existing metadata; omit to leave unchanged. Null is rejected."),
            "intent" => nullable_string_schema("Optional updated plan intent."),
            "default_model" => nullable_string_schema("Optional updated default model."),
            "default_runner_kind" => nullable_string_schema("Optional updated default runner kind.")
          }
        }
      },
      %{
        "name" => "plan.delete",
        "description" => "Soft-delete a plan row by setting its status to deleted, scoped by plan id and workspace id.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["plan_id"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "plan_id" => string_schema("Plan database UUID.")
          }
        }
      },
      %{
        "name" => "task.create",
        "description" =>
          "Create a work item row in the platform database, optionally linked to a plan. The returned id is the work item id used for plan review, coding handoff, and runtime routing. When the task should be handled by another agent, add a routing hint that explains what capability loop is needed, where it should run, how it should be reached, and any concrete runner preference. For manager-agent pickup, set state to running or awaiting_review and set next_poll_at to an absolute ISO timestamp; todo items are planned but not manager-runnable.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => [],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "plan_id" => nullable_string_schema("Optional plan database UUID in the same workspace."),
            "author_task_id" =>
              nullable_string_schema(
                "Optional planner-local task id for this task, such as A or implement-api. Stored in metadata.author_task_id and usable by later task.create calls in the same planner session."
              ),
            "depends_on_author_ids" => %{
              "type" => ["array", "null"],
              "items" => %{"type" => "string"},
              "description" =>
                "Optional planner-local dependency ids created earlier in this planner session. Runtime resolves them to canonical work_items ids before insert and merges them with depends_on."
            },
            "name" => nullable_string_schema("Task title. Stored as work_items.title. If omitted, the runtime derives a short title from title, description, or instructions when possible."),
            "title" => nullable_string_schema("Optional title alias used only as a smart default source for name."),
            "description" => nullable_string_schema("Optional task summary."),
            "instructions" => nullable_string_schema("Optional coding-agent instructions. Defaults to description, then name."),
            "priority" => nullable_string_schema("Optional task priority."),
            "labels" => %{"type" => ["array", "null"], "items" => %{"type" => "string"}},
            "runner_kind" => %{
              "type" => ["string", "null"],
              "enum" => ExecutionProfile.supported_runner_kinds() ++ [nil],
              "description" => "Optional canonical runtime runner kind for this work item. Stored in work_items.runner_kind and mirrored into metadata.runner_kind for routing context."
            },
            "repository" =>
              nullable_string_schema(
                "Optional repository identifier for this work item, using the same shape as repository tools and RepositoryIndex. Stored in work_items.repository and mirrored into metadata.repository for routing context."
              ),
            "routing" => routing_hint_schema(),
            "metadata" => metadata_schema("Optional task metadata. Use routing for dispatch guidance instead of inventing ad hoc routing keys here."),
            "depends_on" => %{"type" => ["array", "null"], "items" => %{"type" => "string"}},
            "completion_gates" => %{"type" => ["array", "null"], "items" => %{"type" => "string"}},
            "next_poll_at" =>
              nullable_date_time_schema("Optional ISO-8601 time when manager polling should first address this work item. Manager pickup also requires state running or awaiting_review."),
            "poll_cadence_seconds" =>
              positive_integer_schema("Optional recurring manager poll cadence in seconds. Omit for one-shot manager scheduling unless the user explicitly asks for recurring follow-up."),
            "state" => nullable_string_schema("Optional work item state. Defaults to todo. Use running or awaiting_review when next_poll_at should make the item available to the manager agent."),
            "manager_runner_id" => nullable_string_schema("Optional manager runner UUID that should own polling this item."),
            "not_before_at" => nullable_string_schema("Optional ISO timestamp before which this work item should not be considered."),
            "scheduled_reason" => nullable_string_schema("Optional reason the work item was scheduled."),
            "scheduled_by_user_id" => nullable_string_schema("Optional user UUID responsible for scheduling the work item.")
          }
        }
      },
      %{
        "name" => "task.update",
        "description" =>
          "Update allowed fields on a work item row scoped by work item id and workspace id. Only task_id is required; omit fields to leave them unchanged. Null clears nullable fields only. Null for name, metadata, status/state, labels, depends_on, or completion_gates is rejected. Pass if_updated_at from task.read to reject the update if the row changed since it was read.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["task_id"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "task_id" => string_schema("Work item database UUID."),
            "if_updated_at" => nullable_date_time_schema("Optional optimistic concurrency guard. Use the updated_at value returned by task.read; stale values reject the update."),
            "name" => string_schema("Optional updated task title. Stored as work_items.title. Omit to keep unchanged; null is rejected."),
            "description" => nullable_string_schema("Optional updated task description."),
            "instructions" => nullable_string_schema("Optional updated coding-agent instructions."),
            "priority" => nullable_string_schema("Optional updated priority."),
            "labels" => %{
              "type" => "array",
              "items" => %{"type" => "string"},
              "description" => "Optional replacement labels. Omit to keep unchanged; null is rejected."
            },
            "metadata" => %{
              "type" => "object",
              "description" => "Optional shallow merge into existing task metadata. Omit to keep unchanged; null is rejected.",
              "additionalProperties" => true
            },
            "status" => string_schema("Optional updated work item state. Omit to keep unchanged; null is rejected."),
            "state" => string_schema("Optional updated work item state. Omit to keep unchanged; null is rejected."),
            "depends_on" => %{
              "type" => "array",
              "items" => %{"type" => "string"},
              "description" => "Optional replacement dependency ids. Omit to keep unchanged; null is rejected."
            },
            "completion_gates" => %{
              "type" => "array",
              "items" => %{"type" => "string"},
              "description" => "Optional replacement completion gates. Omit to keep unchanged; null is rejected."
            }
          }
        }
      },
      %{
        "name" => "task.schedule",
        "description" =>
          "Set or clear when the manager should next address a work item. This updates work_items.next_poll_at and optionally poll_cadence_seconds. Scheduling alone does not make todo work manager-runnable; use task.update to set state to running or awaiting_review when the manager should act.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["task_id", "next_poll_at"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace database UUID."),
            "task_id" => string_schema("Work item database UUID."),
            "next_poll_at" => nullable_date_time_schema("ISO-8601 timestamp for the next manager poll, or null to remove the item from timed polling."),
            "poll_cadence_seconds" => positive_integer_schema("Optional recurring manager poll cadence in seconds. Omit instead of sending null."),
            "reason" => nullable_string_schema("Optional short reason for the audit log.")
          }
        }
      },
      read_tool_spec(
        "plan.read",
        "plan_id",
        "Read a plan row scoped by plan id and workspace id."
      ),
      read_tool_spec(
        "task.read",
        "task_id",
        "Read a work item row scoped by work item id and workspace id."
      )
    ]
  end

  @spec tool_spec(String.t()) :: map()
  def tool_spec(name) when is_binary(name) do
    Enum.find(tool_specs(), &(&1["name"] == name)) ||
      raise ArgumentError, "unknown planner database tool #{inspect(name)}"
  end

  defp read_tool_spec(name, id_key, description) do
    %{
      "name" => name,
      "description" => description,
      "inputSchema" => %{
        "type" => "object",
        "additionalProperties" => false,
        "required" => [id_key],
        "properties" => %{
          "workspace_id" => string_schema("Workspace database UUID."),
          id_key => string_schema("Database UUID.")
        }
      }
    }
  end

  defp string_schema(description), do: %{"type" => "string", "description" => description}

  defp nullable_string_schema(description),
    do: %{"type" => ["string", "null"], "description" => description}

  defp nullable_date_time_schema(description),
    do: %{"type" => ["string", "null"], "format" => "date-time", "description" => description}

  defp positive_integer_schema(description),
    do: %{"type" => "integer", "description" => description, "minimum" => 1}

  defp metadata_schema(description),
    do: %{
      "type" => ["object", "null"],
      "description" => description,
      "additionalProperties" => true
    }

  defp required_object_schema(description),
    do: %{
      "type" => "object",
      "description" => description,
      "additionalProperties" => true
    }

  defp routing_hint_schema do
    %{
      "type" => ["object", "null"],
      "description" =>
        "Optional routing guidance for the manager/router. Choose runner_family first from the work needed, then execution_location, then transport, then runner_kind only when a concrete backend is known.",
      "additionalProperties" => false,
      "properties" => %{
        "runner_family" => %{
          "type" => ["string", "null"],
          "enum" => [
            "workspace_coding",
            "tool_calling_llm",
            "model_chat",
            "computer_use",
            "custom_runtime",
            nil
          ],
          "description" =>
            "Who should handle it: workspace_coding for repo edits/tests, tool_calling_llm for planner/manager reasoning, model_chat for simple local model turns, computer_use for browser/desktop interaction, custom_runtime for an external/custom service."
        },
        "execution_location" => %{
          "type" => ["string", "null"],
          "enum" => ["cloud", "local", "external", nil],
          "description" => "Where it should run: cloud for hosted agents, local for the user's machine or local relay, external for an explicitly reachable outside runtime."
        },
        "transport" => %{
          "type" => ["string", "null"],
          "enum" => ["launcher", "local_direct", "local_relay", "websocket", "http_sse", nil],
          "description" =>
            "How to reach it: launcher for normal hosted runtime launch, local_relay for local model/tool execution through the relay, websocket or http_sse for custom external runtimes, local_direct for same-machine local runtime."
        },
        "runner_kind" => %{
          "type" => ["string", "null"],
          "enum" => [
            "codex",
            "openclaw",
            "computer_use",
            "manager",
            "planner",
            "local_relay",
            "local_model_coding",
            nil
          ],
          "description" =>
            "Concrete backend preference when known. Use codex/local_model_coding for coding work, manager/planner for orchestration, computer_use for browser/desktop tasks, openclaw for OpenClaw work, and local_relay for local relay dispatch."
        },
        "intent" => nullable_string_schema("Machine-readable dispatch intent, such as implement, review, test, plan, browse, or remediate."),
        "rationale" => nullable_string_schema("Brief reason this route is appropriate.")
      }
    }
  end
end
