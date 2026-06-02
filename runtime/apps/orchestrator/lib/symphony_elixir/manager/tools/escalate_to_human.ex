defmodule SymphonyElixir.Manager.Tools.EscalateToHuman do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Manager.ToolSupport

  @impl true
  def name, do: "escalate_to_human"

  @impl true
  def description, do: "Create a human escalation for a work item when the manager cannot safely proceed."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["work_item_id", "trigger_kind", "question", "context_summary"],
      "properties" => %{
        "work_item_id" => ToolSupport.string_schema("Work item database UUID."),
        "trigger_kind" =>
          ToolSupport.enum_schema(
            ["structural", "self_flagged", "resource", "gate_failure"],
            "Top-level escalation trigger category."
          ),
        "reason_kind" =>
          ToolSupport.nullable_enum_schema(
            [
              "ambiguous_intent",
              "missing_context",
              "policy_uncertain",
              "destructive_action_unverified",
              "out_of_scope",
              "stuck_after_retries",
              "resource_cap_hit",
              "other"
            ],
            "Finer-grained escalation reason."
          ),
        "question" => ToolSupport.string_schema("Question or decision needed from a human."),
        "context_summary" => ToolSupport.string_schema("Brief summary of the observed state."),
        "candidate_options" => %{
          "type" => ["array", "null"],
          "description" => "Optional structured options a human can choose from.",
          "items" => %{
            "type" => "object",
            "additionalProperties" => false,
            "required" => ["id", "label"],
            "properties" => %{
              "id" => ToolSupport.string_schema("Stable option id."),
              "label" => ToolSupport.string_schema("Human-readable option label."),
              "description" => ToolSupport.nullable_string_schema("Optional option details.")
            }
          }
        },
        "preferred_option_id" => ToolSupport.nullable_string_schema("Optional id of the manager's preferred option."),
        "urgency" => ToolSupport.nullable_enum_schema(["low", "normal", "high"], "Optional urgency level.")
      }
    }
  end

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.escalate_to_human(arguments, context)
end
