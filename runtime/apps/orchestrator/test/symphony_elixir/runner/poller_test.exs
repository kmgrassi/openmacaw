defmodule SymphonyElixir.Runner.PollerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.Poller

  describe "poll_until/4" do
    test "returns the first successful classification" do
      deadline = System.monotonic_time(:millisecond) + 1_000

      assert {:ok, :done} =
               Poller.poll_until(deadline, 0, fn -> {:status, "completed"} end, fn {:status, "completed"} ->
                 {:ok, :done}
               end)
    end

    test "continues until a terminal classification" do
      counter = :counters.new(1, [:atomics])
      deadline = System.monotonic_time(:millisecond) + 1_000

      result =
        Poller.poll_until(
          deadline,
          0,
          fn ->
            :counters.add(counter, 1, 1)
            :counters.get(counter, 1)
          end,
          fn
            count when count < 3 -> :continue
            count -> {:ok, count}
          end
        )

      assert result == {:ok, 3}
    end

    test "returns timeout without fetching after deadline" do
      deadline = System.monotonic_time(:millisecond) - 1

      assert {:error, {:retryable, :poll_timeout}} =
               Poller.poll_until(deadline, 0, fn -> flunk("fetch should not run") end, fn _ -> :continue end)
    end

    test "returns terminal errors without another attempt" do
      deadline = System.monotonic_time(:millisecond) + 1_000

      assert {:error, {:fatal, :failed}} =
               Poller.poll_until(deadline, 0, fn -> :failed end, fn :failed -> {:error, {:fatal, :failed}} end)
    end
  end
end
