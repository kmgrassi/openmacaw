defmodule SymphonyElixir.UsageExtraction.AccumulatorTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.UsageExtraction.Accumulator

  test "snapshots cumulative token totals as per-turn deltas" do
    accumulator = Accumulator.start()

    try do
      Accumulator.record_snapshot(accumulator, %{
        event: :token_count,
        payload: %{
          "params" => %{
            "msg" => %{
              "payload" => %{
                "info" => %{
                  "total_token_usage" => %{
                    "input_tokens" => 100,
                    "output_tokens" => 40,
                    "total_tokens" => 140
                  }
                }
              }
            }
          }
        }
      })

      assert Accumulator.snapshot_turn(accumulator) == %{
               input_delta: 100,
               output_delta: 40,
               total_delta: 140,
               last_event: "token_count"
             }

      Accumulator.record_snapshot(accumulator, %{
        "event" => "thread/tokenUsage/updated",
        "payload" => %{
          "params" => %{
            "tokenUsage" => %{
              "total" => %{
                "inputTokens" => 130,
                "outputTokens" => 55,
                "totalTokens" => 185
              }
            }
          }
        }
      })

      assert Accumulator.snapshot_turn(accumulator) == %{
               input_delta: 30,
               output_delta: 15,
               total_delta: 45,
               last_event: "thread/tokenUsage/updated"
             }
    after
      Accumulator.stop(accumulator)
    end
  end

  test "keeps highest absolute total and ignores lower repeated reports" do
    accumulator = Accumulator.start()

    try do
      Accumulator.record_snapshot(accumulator, %{
        usage: %{prompt_tokens: 80, completion_tokens: 20, total_tokens: 100},
        event: "usage-high"
      })

      Accumulator.record_snapshot(accumulator, %{
        usage: %{prompt_tokens: 60, completion_tokens: 15, total_tokens: 75},
        event: "usage-low"
      })

      assert Accumulator.snapshot_turn(accumulator) == %{
               input_delta: 80,
               output_delta: 20,
               total_delta: 100,
               last_event: "usage-low"
             }
    after
      Accumulator.stop(accumulator)
    end
  end

  test "returns empty snapshots for disabled or stopped accumulators" do
    assert Accumulator.snapshot_turn(nil) == %{
             input_delta: 0,
             output_delta: 0,
             total_delta: 0,
             last_event: nil
           }

    accumulator = Accumulator.start()
    Accumulator.stop(accumulator)

    assert Accumulator.snapshot_turn(accumulator) == %{
             input_delta: 0,
             output_delta: 0,
             total_delta: 0,
             last_event: nil
           }
  end
end
