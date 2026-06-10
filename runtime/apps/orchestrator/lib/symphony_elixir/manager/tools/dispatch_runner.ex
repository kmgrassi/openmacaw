defmodule SymphonyElixir.Manager.Tools.DispatchRunner do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Orchestrator.IntentVocabulary
  alias SymphonyElixir.Manager.ToolSupport
  alias SymphonyElixir.Schema.ExecutionProfile

  @impl true
  def name, do: "dispatch_runner"

  @impl true
  def description do
    "Dispatch an author, reviewer, or other runner turn for an existing or inline work item and intent. #{IntentVocabulary.tool_description()}"
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["intent"],
      "properties" => %{
        "work_item_id" => ToolSupport.nullable_string_schema("Existing work item database UUID."),
        "work_item" => %{
          "type" => ["object", "null"],
          "description" => "Inline work to create before dispatch when no work_item_id exists.",
          "additionalProperties" => false,
          "required" => ["instructions"],
          "properties" => %{
            "workspace_id" => ToolSupport.nullable_string_schema("Must match the manager session workspace when present."),
            "title" => ToolSupport.nullable_string_schema("Optional short title. Defaults from instructions."),
            "instructions" => ToolSupport.string_schema("Work instructions for the dispatched runner."),
            "priority" => ToolSupport.nullable_string_schema("Optional priority."),
            "repository" => ToolSupport.nullable_string_schema("Optional repository identifier."),
            "depends_on" => %{"type" => ["array", "null"], "items" => %{"type" => "string"}},
            "metadata" => %{
              "type" => ["object", "null"],
              "description" => "Optional metadata to merge into the created work item.",
              "additionalProperties" => true
            }
          }
        },
        "runner_kind" =>
          ToolSupport.nullable_enum_schema(
            ExecutionProfile.supported_runner_kinds(),
            "Optional concrete runner override. Omit this unless an upstream route or human explicitly names a backend; dispatch normally chooses from intent."
          ),
        "intent" =>
          ToolSupport.enum_schema(
            IntentVocabulary.names(),
            "Machine-readable dispatch intent. #{IntentVocabulary.tool_description()}"
          ),
        "context" => %{
          "type" => ["object", "null"],
          "description" => "Structured context to pass to the dispatched runner.",
          "additionalProperties" => true
        }
      }
    }
  end

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.dispatch_runner(arguments, context)
end
