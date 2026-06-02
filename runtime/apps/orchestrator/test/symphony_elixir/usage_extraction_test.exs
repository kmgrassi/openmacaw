defmodule SymphonyElixir.UsageExtractionTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.UsageExtraction

  describe "extract_tokens/1" do
    test "extracts thread token usage totals from nested payloads" do
      update = %{
        payload: %{
          "method" => "thread/tokenUsage/updated",
          "params" => %{
            "tokenUsage" => %{
              "total" => %{"inputTokens" => 12, "outputTokens" => 4, "totalTokens" => 16}
            }
          }
        }
      }

      assert UsageExtraction.extract_tokens(update) == %{
               "inputTokens" => 12,
               "outputTokens" => 4,
               "totalTokens" => 16
             }
    end

    test "extracts total token usage from codex token count payloads" do
      update = %{
        payload: %{
          "method" => "codex/event/token_count",
          "params" => %{
            "msg" => %{
              "type" => "token_count",
              "info" => %{
                "total_token_usage" => %{
                  "prompt_tokens" => 10,
                  "completion_tokens" => 5,
                  "total_tokens" => 15
                }
              }
            }
          }
        }
      }

      assert UsageExtraction.extract_tokens(update) == %{
               "prompt_tokens" => 10,
               "completion_tokens" => 5,
               "total_tokens" => 15
             }
    end

    test "prefers absolute totals over turn completed usage" do
      update = %{
        payload: %{
          method: "turn/completed",
          params: %{
            tokenUsage: %{
              total: %{"input_tokens" => 1, "output_tokens" => 1, "total_tokens" => 2}
            }
          },
          usage: %{"input_tokens" => 12, "output_tokens" => 4, "total_tokens" => 16}
        }
      }

      assert UsageExtraction.extract_tokens(update) == %{
               "input_tokens" => 1,
               "output_tokens" => 1,
               "total_tokens" => 2
             }
    end

    test "falls back to turn completed usage when no absolute totals exist" do
      update = %{
        payload: %{
          method: "turn/completed",
          usage: %{"input_tokens" => "12", "output_tokens" => 4, "total_tokens" => 16}
        }
      }

      assert UsageExtraction.extract_tokens(update) == %{
               "input_tokens" => "12",
               "output_tokens" => 4,
               "total_tokens" => 16
             }
    end

    test "ignores last token usage without cumulative totals" do
      update = %{
        payload: %{
          "method" => "codex/event/token_count",
          "params" => %{
            "msg" => %{
              "type" => "event_msg",
              "payload" => %{
                "type" => "token_count",
                "info" => %{
                  "last_token_usage" => %{
                    "input_tokens" => 8,
                    "output_tokens" => 3,
                    "total_tokens" => 11
                  }
                }
              }
            }
          }
        }
      }

      assert UsageExtraction.extract_tokens(update) == %{}
    end
  end

  describe "extract_rate_limits/1" do
    test "finds nested codex rate-limit payloads" do
      rate_limits = %{
        "limit_id" => "codex",
        "primary" => %{"remaining" => 90, "limit" => 100},
        "secondary" => nil,
        "credits" => %{"has_credits" => false, "unlimited" => false, "balance" => nil}
      }

      update = %{
        payload: %{
          "method" => "codex/event/token_count",
          "params" => %{
            "msg" => %{
              "type" => "event_msg",
              "payload" => %{
                "type" => "token_count",
                "rate_limits" => rate_limits
              }
            }
          }
        }
      }

      assert UsageExtraction.extract_rate_limits(update) == rate_limits
    end

    test "returns direct rate-limit payloads" do
      rate_limits = %{limit_name: "primary", primary: %{remaining: 11}}

      assert UsageExtraction.extract_rate_limits(%{rate_limits: rate_limits}) == rate_limits
    end
  end

  test "token_payload_candidates/1 returns update payloads in precedence order" do
    update = %{
      "usage" => %{"total_tokens" => 2},
      "payload" => %{"total_tokens" => 4},
      usage: %{total_tokens: 1},
      payload: %{total_tokens: 3}
    }

    assert UsageExtraction.token_payload_candidates(update) == [
             %{total_tokens: 1},
             %{"total_tokens" => 2},
             %{total_tokens: 1},
             %{total_tokens: 3},
             %{"total_tokens" => 4},
             update
           ]
  end
end
