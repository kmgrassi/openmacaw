defmodule Mix.Tasks.WorkerCommon.CheckTaskTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureIO

  alias Mix.Tasks.WorkerCommon.Check

  setup do
    Mix.Task.reenable("worker_common.check")
    :ok
  end

  test "passes for the recorded worker common drift policy" do
    output =
      capture_io(fn ->
        assert :ok = Check.run([])
      end)

    assert output =~ "worker_common.check: copied worker modules match recorded drift policy"
  end
end
