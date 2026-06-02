defmodule Mix.Tasks.WorkerCommon.Check do
  use Mix.Task

  alias SymphonyElixir.WorkerCommonDriftCheck

  @moduledoc """
  Fails when worker/common copied modules drift without an explicit record.
  """
  @shortdoc "Checks worker/common copy drift"

  @impl Mix.Task
  def run(_args) do
    findings = WorkerCommonDriftCheck.findings()

    if findings == [] do
      Mix.shell().info("worker_common.check: copied worker modules match recorded drift policy")
      :ok
    else
      Enum.each(findings, fn finding ->
        Mix.shell().error("#{finding.left} <-> #{finding.right}: #{finding.message}")
      end)

      Mix.raise("worker_common.check failed with #{length(findings)} finding(s)")
    end
  end
end
