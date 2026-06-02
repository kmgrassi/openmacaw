defmodule SymphonyElixir.WorkItem do
  @moduledoc """
  Normalized work item representation used by the orchestrator.

  Every input source (Linear, database, API push, GitHub) normalizes into this struct.
  The orchestrator, agent runner, prompt builder, and workspace manager only interact
  with this shape — they never see source-specific types.

  `plan_id` is first-class for planner review and handoff. `task_id` remains
  available for legacy rows projected from `task`, but new planner-created tasks
  are direct `work_items` rows whose `id` is the routing and handoff identifier.

  Source-specific fields (branch_name, assignee_id, blocked_by, etc.) go in the
  `metadata` map. Prompt templates can access them via `{{ item.metadata.branch_name }}`.
  """

  defstruct [
    :id,
    :identifier,
    :title,
    :description,
    :priority,
    :state,
    :url,
    :source,
    :runner_type,
    :repository_id,
    :repository,
    :plan_id,
    :task_id,
    labels: [],
    metadata: %{},
    assigned_to_worker: true,
    created_at: nil,
    updated_at: nil
  ]

  @type t :: %__MODULE__{
          id: String.t() | nil,
          identifier: String.t() | nil,
          title: String.t() | nil,
          description: String.t() | nil,
          priority: String.t() | nil,
          state: String.t() | nil,
          url: String.t() | nil,
          source: String.t() | nil,
          runner_type: String.t() | nil,
          repository_id: String.t() | nil,
          repository: String.t() | nil,
          plan_id: String.t() | nil,
          task_id: String.t() | nil,
          labels: [String.t()],
          metadata: map(),
          assigned_to_worker: boolean(),
          created_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @doc """
  Extract label names from the work item.
  """
  @spec label_names(t()) :: [String.t()]
  def label_names(%__MODULE__{labels: labels}), do: labels
end
