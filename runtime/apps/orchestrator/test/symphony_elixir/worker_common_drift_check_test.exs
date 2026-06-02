defmodule SymphonyElixir.WorkerCommonDriftCheckTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.WorkerCommonDriftCheck

  test "accepts identical file pairs" do
    dir = create_tmp_dir()

    try do
      left = Path.join(dir, "left.ex")
      right = Path.join(dir, "right.ex")

      File.write!(left, "same\n")
      File.write!(right, "same\n")

      assert WorkerCommonDriftCheck.findings([
               %{left: left, right: right, status: :identical}
             ]) == []
    after
      File.rm_rf(dir)
    end
  end

  test "reports unexpected drift for identical file pairs" do
    dir = create_tmp_dir()

    try do
      left = Path.join(dir, "left.ex")
      right = Path.join(dir, "right.ex")

      File.write!(left, "left\n")
      File.write!(right, "right\n")

      assert [
               %{
                 left: ^left,
                 right: ^right,
                 status: :content_drift
               }
             ] =
               WorkerCommonDriftCheck.findings([
                 %{left: left, right: right, status: :identical}
               ])
    after
      File.rm_rf(dir)
    end
  end

  test "accepts intentional drift when both digests match" do
    dir = create_tmp_dir()

    try do
      left = Path.join(dir, "left.ex")
      right = Path.join(dir, "right.ex")

      File.write!(left, "orchestrator\n")
      File.write!(right, "worker\n")

      {:ok, left_sha256} = WorkerCommonDriftCheck.digest(left)
      {:ok, right_sha256} = WorkerCommonDriftCheck.digest(right)

      assert WorkerCommonDriftCheck.findings([
               %{
                 left: left,
                 right: right,
                 status: :intentional_drift,
                 left_sha256: left_sha256,
                 right_sha256: right_sha256
               }
             ]) == []
    after
      File.rm_rf(dir)
    end
  end

  test "reports changed intentional drift digests" do
    dir = create_tmp_dir()

    try do
      left = Path.join(dir, "left.ex")
      right = Path.join(dir, "right.ex")

      File.write!(left, "orchestrator changed\n")
      File.write!(right, "worker\n")

      {:ok, right_sha256} = WorkerCommonDriftCheck.digest(right)

      assert [
               %{
                 left: ^left,
                 right: ^right,
                 status: :intentional_drift_changed
               }
             ] =
               WorkerCommonDriftCheck.findings([
                 %{
                   left: left,
                   right: right,
                   status: :intentional_drift,
                   left_sha256: String.duplicate("0", 64),
                   right_sha256: right_sha256
                 }
               ])
    after
      File.rm_rf(dir)
    end
  end

  defp create_tmp_dir do
    dir =
      Path.join(
        System.tmp_dir!(),
        "worker-common-drift-check-test-#{System.unique_integer([:positive, :monotonic])}"
      )

    File.rm_rf!(dir)
    File.mkdir_p!(dir)
    dir
  end
end
