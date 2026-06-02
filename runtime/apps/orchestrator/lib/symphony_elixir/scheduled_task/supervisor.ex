defmodule SymphonyElixir.ScheduledTask.Supervisor do
  @moduledoc false

  use Supervisor

  alias SymphonyElixir.ScheduledTask.{Repository, Scheduler}

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    children =
      if enabled?(opts) do
        [{Scheduler, Keyword.get(opts, :scheduler_opts, [])}]
      else
        []
      end

    Supervisor.init(children, strategy: :one_for_one)
  end

  defp enabled?(opts) do
    Keyword.get(
      opts,
      :enabled,
      Application.get_env(
        :symphony_elixir,
        :scheduled_task_scheduler_enabled,
        Repository.configured?() and Repository.schema_ready?()
      )
    )
  end
end
