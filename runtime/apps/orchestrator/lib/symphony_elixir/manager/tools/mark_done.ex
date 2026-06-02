defmodule SymphonyElixir.Manager.Tools.MarkDone do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Manager.ToolSupport

  @impl true
  def name, do: "mark_done"

  @impl true
  def description, do: "Mark a work item complete and remove it from manager polling."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["work_item_id"],
      "properties" => %{"work_item_id" => ToolSupport.string_schema("Work item database UUID.")}
    }
  end

  @impl true
  def bundle, do: :manager

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context), do: ToolSupport.mark_done(arguments, context)
end
