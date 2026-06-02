defmodule SymphonyElixir.Manager.WorkItemRow do
  @moduledoc false

  use Ecto.Schema

  alias SymphonyElixir.WorkItem

  @primary_key {:id, :binary_id, autogenerate: false}

  schema "work_items" do
    field(:identifier, :string)
    field(:title, :string)
    field(:description, :string)
    field(:priority, :string)
    field(:state, :string)
    field(:workspace_id, :binary_id)
    field(:plan_id, :binary_id)
    field(:task_id, :binary_id)
    field(:labels, {:array, :string}, default: [])
    field(:metadata, :map, default: %{})
    field(:next_poll_at, :utc_datetime_usec)
    field(:last_polled_at, :utc_datetime_usec)
    field(:poll_cadence_seconds, :integer)
    field(:manager_runner_id, :binary_id)

    timestamps(inserted_at: :created_at, type: :utc_datetime_usec)
  end

  @type t :: %__MODULE__{}

  @spec to_work_item(t()) :: WorkItem.t()
  def to_work_item(%__MODULE__{} = row) do
    metadata = row.metadata || %{}

    %WorkItem{
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description,
      priority: row.priority,
      state: row.state,
      url: Map.get(metadata, "url") || Map.get(metadata, :url),
      source: "database",
      runner_type: Map.get(metadata, "runner_type") || Map.get(metadata, :runner_type),
      plan_id: row.plan_id,
      task_id: row.task_id,
      labels: row.labels || [],
      metadata: metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  end
end
