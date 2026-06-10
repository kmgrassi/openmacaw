defmodule SymphonyElixir.Routing.IntentVocabulary do
  @moduledoc false

  @intents [
    "implement",
    "address_review",
    "fix_tests",
    "review",
    "test",
    "plan",
    "follow_up",
    "browse",
    "remediate",
    "prepare_merge",
    "land_change"
  ]

  @manager_dispatch_runner_by_intent %{
    "implement" => "codex",
    "address_review" => "codex",
    "fix_tests" => "codex",
    "review" => "planner",
    "test" => "codex",
    "plan" => "planner",
    "follow_up" => "planner",
    "browse" => "computer_use",
    "remediate" => "codex",
    "prepare_merge" => "codex",
    "land_change" => "codex"
  }

  @manager_dispatch_runner_kinds ~w(codex claude_code openclaw computer_use planner local_model_coding)

  @spec intents() :: [String.t()]
  def intents, do: @intents

  @spec manager_dispatch_runner_kinds() :: [String.t()]
  def manager_dispatch_runner_kinds, do: @manager_dispatch_runner_kinds

  @spec manager_dispatch_runner_kind(String.t()) :: String.t() | nil
  def manager_dispatch_runner_kind(intent) when is_binary(intent),
    do: Map.get(@manager_dispatch_runner_by_intent, intent)

  def manager_dispatch_runner_kind(_intent), do: nil

  @spec tool_description() :: String.t()
  def tool_description do
    "Canonical dispatch intents: #{Enum.join(@intents, ", ")}. " <>
      "Choose the intent from the work to be done; runtime routing maps intent to the concrete runner."
  end
end
