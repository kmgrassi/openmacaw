defmodule SymphonyElixir.Manager.Tools.DispatchRunner do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Orchestrator.IntentVocabulary
  alias SymphonyElixir.Manager.ToolSupport
  alias SymphonyElixir.Schema.ExecutionProfile

  @impl true
  def name, do: "dispatch_runner"

  @impl true
  def description do
    "Dispatch an author, reviewer, or other runner turn for a work item and intent. #{IntentVocabulary.tool_description()}"
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["work_item_id", "runner_kind", "intent"],
      "properties" => %{
        "work_item_id" => ToolSupport.string_schema("Work item database UUID."),
        "runner_kind" =>
          ToolSupport.enum_schema(
            ExecutionProfile.supported_runner_kinds(),
            "Runner kind to dispatch."
          ),
        "intent" => ToolSupport.string_schema("Short machine-readable dispatch intent. #{IntentVocabulary.tool_description()}"),
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
