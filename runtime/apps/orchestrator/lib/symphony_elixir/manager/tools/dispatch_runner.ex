defmodule SymphonyElixir.Manager.Tools.DispatchRunner do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Manager.ToolSupport
  alias SymphonyElixir.Routing.IntentVocabulary

  @impl true
  def name, do: "dispatch_runner"

  @impl true
  def description, do: "Dispatch an author, reviewer, or other runner turn for a work item and intent."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["work_item_id", "intent"],
      "properties" => %{
        "work_item_id" => ToolSupport.string_schema("Work item database UUID."),
        "runner_kind" =>
          ToolSupport.nullable_enum_schema(
            IntentVocabulary.manager_dispatch_runner_kinds(),
            "Optional concrete runner override. Omit this unless an upstream route or human explicitly names a backend; dispatch normally chooses from intent."
          ),
        "intent" =>
          ToolSupport.enum_schema(
            IntentVocabulary.intents(),
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
