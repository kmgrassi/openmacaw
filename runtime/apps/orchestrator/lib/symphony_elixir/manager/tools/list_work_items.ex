defmodule SymphonyElixir.Manager.Tools.ListWorkItems do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Manager.ToolSupport

  @impl true
  def name, do: "list_work_items"

  @impl true
  def description,
    do: "List outstanding work items for the current manager workspace. Results are always scoped to the bound session workspace."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => [],
      "properties" => %{
        "state" => ToolSupport.nullable_string_schema("Optional work item state filter."),
        "due_only" => %{
          "type" => ["boolean", "null"],
          "description" => "When true, only return rows with next_poll_at <= now."
        },
        "limit" => ToolSupport.integer_schema("Maximum rows to return.", 1, 100)
      }
    }
  end

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.list_work_items(arguments, context)
end
