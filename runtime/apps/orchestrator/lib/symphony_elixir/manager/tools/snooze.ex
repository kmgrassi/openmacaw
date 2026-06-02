defmodule SymphonyElixir.Manager.Tools.Snooze do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.{Manager.ToolSupport, WorkItemSnooze}

  @impl true
  def name, do: "snooze"

  @impl true
  def description, do: Map.get(WorkItemSnooze.manager_alias_spec(), "description")

  @impl true
  def parameters_schema, do: Map.fetch!(WorkItemSnooze.manager_alias_spec(), "inputSchema")

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.snooze(arguments, context)
end
