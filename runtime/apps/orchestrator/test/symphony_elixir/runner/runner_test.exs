defmodule SymphonyElixir.RunnerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner
  alias SymphonyElixir.WorkItem

  describe "resolve/2" do
    test "defaults to Codex when no label or config" do
      work_item = build_work_item()
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.Codex
    end

    test "respects default config" do
      work_item = build_work_item()

      assert Runner.resolve(work_item, %{"default" => "openclaw"}) ==
               SymphonyElixir.Runner.OpenClaw
    end

    test "label overrides config default" do
      work_item = build_work_item(labels: ["runner:computer_use", "priority:high"])

      assert Runner.resolve(work_item, %{"default" => "codex"}) ==
               SymphonyElixir.Runner.ComputerUse
    end

    test "work item runner_type overrides config default" do
      work_item = build_work_item(runner_type: "codex")
      assert Runner.resolve(work_item, %{"default" => "openclaw"}) == SymphonyElixir.Runner.Codex
    end

    test "label overrides work item runner_type" do
      work_item = build_work_item(runner_type: "codex", labels: ["runner:openclaw"])

      assert Runner.resolve(work_item, %{"default" => "computer_use"}) ==
               SymphonyElixir.Runner.OpenClaw
    end

    test "resolves codex from label" do
      work_item = build_work_item(labels: ["runner:codex"])
      assert Runner.resolve(work_item, %{"default" => "openclaw"}) == SymphonyElixir.Runner.Codex
    end

    test "resolves planner from label and default config" do
      work_item = build_work_item(labels: ["runner:planner"])
      assert Runner.resolve(work_item, %{"default" => "codex"}) == SymphonyElixir.Runner.Planner

      work_item = build_work_item()
      assert Runner.resolve(work_item, %{"default" => "planner"}) == SymphonyElixir.Runner.Planner
    end

    test "resolves manager from label and default config" do
      work_item = build_work_item(labels: ["runner:manager"])
      assert Runner.resolve(work_item, %{"default" => "codex"}) == SymphonyElixir.Runner.LlmToolRunner

      work_item = build_work_item()
      assert Runner.resolve(work_item, %{"default" => "manager"}) == SymphonyElixir.Runner.LlmToolRunner
    end

    test "resolves router and llm_tool_runner through the tool-calling runner" do
      work_item = build_work_item(labels: ["runner:router"])
      assert Runner.resolve(work_item, %{"default" => "codex"}) == SymphonyElixir.Runner.LlmToolRunner

      work_item = build_work_item()
      assert Runner.resolve(work_item, %{"default" => "llm_tool_runner"}) == SymphonyElixir.Runner.LlmToolRunner
    end

    test "resolves openclaw from label" do
      work_item = build_work_item(labels: ["runner:openclaw"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.OpenClaw
    end

    test "resolves openclaw_ws from label and default config" do
      work_item = build_work_item(labels: ["runner:openclaw_ws"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.OpenClawWS

      work_item = build_work_item()

      assert Runner.resolve(work_item, %{"default" => "openclaw_ws"}) ==
               SymphonyElixir.Runner.OpenClawWS
    end

    test "resolves local_relay from label and default config" do
      work_item = build_work_item(labels: ["runner:local_relay"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.LocalRelay

      work_item = build_work_item()

      assert Runner.resolve(work_item, %{"default" => "local_relay"}) ==
               SymphonyElixir.Runner.LocalRelay
    end

    test "resolves local_model_coding from label and default config" do
      work_item = build_work_item(labels: ["runner:local_model_coding"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.LocalModelCoding

      work_item = build_work_item()

      assert Runner.resolve(work_item, %{"default" => "local_model_coding"}) ==
               SymphonyElixir.Runner.LocalModelCoding
    end

    test "resolves claude_code from label and default config" do
      work_item = build_work_item(labels: ["runner:claude_code"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.ClaudeCode

      work_item = build_work_item()
      assert Runner.resolve(work_item, %{"default" => "claude_code"}) == SymphonyElixir.Runner.ClaudeCode
    end

    test "falls back to Codex for unknown runner type" do
      work_item = build_work_item(labels: ["runner:unknown"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.Codex
    end

    test "ignores non-runner labels" do
      work_item = build_work_item(labels: ["priority:high", "area:backend"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.Codex
    end

    test "uses first runner label when multiple present" do
      work_item = build_work_item(labels: ["runner:openclaw", "runner:computer_use"])
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.OpenClaw
    end

    test "handles nil labels" do
      work_item = %WorkItem{
        id: "1",
        identifier: "T-1",
        title: "test",
        state: "Todo",
        source: "test",
        labels: nil,
        metadata: %{}
      }

      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.Codex
    end
  end

  describe "Mock runner" do
    test "returns preconfigured responses" do
      Application.put_env(:symphony_elixir, :mock_runner_responses, %{
        start_session: {:ok, %{session_id: "test-session"}},
        run_turn: {:ok, %{status: "completed", output: "test output"}},
        stop_session: :ok,
        ping: :ok
      })

      Application.put_env(:symphony_elixir, :mock_runner_recipient, self())

      on_exit(fn ->
        Application.delete_env(:symphony_elixir, :mock_runner_responses)
        Application.delete_env(:symphony_elixir, :mock_runner_recipient)
      end)

      mock = SymphonyElixir.Runner.Mock

      assert {:ok, %{session_id: "test-session"}} = mock.start_session(%{}, nil)
      assert_received {:mock_runner_start_session, %{}, nil}

      work_item = build_work_item()
      assert {:ok, %{status: "completed"}} = mock.run_turn(%{}, "prompt", work_item)
      assert_received {:mock_runner_run_turn, %{}, "prompt", ^work_item}

      assert :ok = mock.stop_session(%{})
      assert_received {:mock_runner_stop_session, %{}}

      assert :ok = mock.ping(%{})
      assert_received {:mock_runner_ping, %{}}

      assert mock.requires_workspace?() == false
    end

    test "work item with runner:mock label resolves to Mock" do
      work_item = build_work_item(labels: ["runner:mock"])
      # Mock isn't in the resolve map, so falls back to Codex
      assert Runner.resolve(work_item, %{}) == SymphonyElixir.Runner.Codex
    end
  end

  defp build_work_item(overrides \\ []) do
    %WorkItem{
      id: Keyword.get(overrides, :id, "wi-#{System.unique_integer([:positive])}"),
      identifier: Keyword.get(overrides, :identifier, "TEST-1"),
      title: Keyword.get(overrides, :title, "Test work item"),
      description: Keyword.get(overrides, :description, "A test work item"),
      state: Keyword.get(overrides, :state, "Todo"),
      source: Keyword.get(overrides, :source, "test"),
      runner_type: Keyword.get(overrides, :runner_type, nil),
      labels: Keyword.get(overrides, :labels, []),
      metadata: Keyword.get(overrides, :metadata, %{})
    }
  end
end
