defmodule SymphonyElixir.BrokerLog.Reconciler do
  @moduledoc """
  One-shot startup task that marks any `broker_run` rows for this
  orchestrator's agent still in `status='started'` as `failed` with
  `terminal_reason='orphaned'`.

  Starts as a `Task` child under the application supervisor so the boot
  sequence does not block on Supabase availability; a failure is logged and
  swallowed.
  """

  use Task, restart: :transient

  require Logger

  alias SymphonyElixir.BrokerLog

  @spec start_link(keyword()) :: {:ok, pid()}
  def start_link(opts \\ []) do
    Task.start_link(__MODULE__, :run, [opts])
  end

  @doc false
  @spec run(keyword()) :: :ok
  def run(_opts) do
    case BrokerLog.reconcile_orphans() do
      :ok ->
        Logger.debug("BrokerLog orphan reconcile complete")

      :disabled ->
        :ok

      {:error, reason} ->
        Logger.warning("BrokerLog orphan reconcile failed at boot: #{inspect(reason)}")
    end

    :ok
  end
end
