defmodule SymphonyElixir.Planner.Tools.SnoozeWorkItem do
  @moduledoc false

  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Planner.Tools.Context
  alias SymphonyElixir.WorkItemSnooze

  @impl true
  def name, do: "snooze_work_item"

  @impl true
  def description, do: WorkItemSnooze.tool_spec()["description"]

  @impl true
  def parameters_schema, do: WorkItemSnooze.tool_spec()["inputSchema"]

  @impl true
  def bundle, do: [:planner, :universal]

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    WorkItemSnooze.snooze(arguments, Context.to_opts(context))
  end
end
