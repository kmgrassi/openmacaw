defmodule SymphonyElixir.ScheduledTask.Tools.List do
  use SymphonyElixir.ScheduledTask.Tools.Generic, tool_name: "scheduled_task.list"

  @impl true
  def bundle, do: [:scheduled_task, :planner, :manager, :coding]
end
