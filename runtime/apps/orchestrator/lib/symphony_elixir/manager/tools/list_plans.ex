defmodule SymphonyElixir.Manager.Tools.ListPlans do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Manager.ToolSupport

  @impl true
  def name, do: "list_plans"

  @impl true
  def description,
    do: "List plans for the current manager workspace. Results are always scoped to the bound session workspace."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => [],
      "properties" => %{
        "status" => ToolSupport.nullable_string_schema("Optional plan status filter when the column is present."),
        "limit" => ToolSupport.integer_schema("Maximum rows to return.", 1, 100)
      }
    }
  end

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.list_plans(arguments, context)
end
