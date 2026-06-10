defmodule SymphonyElixir.Orchestrator.IntentVocabulary do
  @moduledoc """
  Shared agent-facing dispatch intent vocabulary.

  This module is intentionally descriptive only. Dispatch routing remains in
  `SymphonyElixir.Orchestrator.DispatchPolicy`; tool schemas and prompts use
  this module so agent-facing guidance cannot drift across surfaces.
  """

  @intents [
    {"implement", "write or change repository code, docs, tests, or configuration"},
    {"review", "inspect a change or artifact and report findings without editing"},
    {"test", "run verification, diagnose failures, or add focused test coverage"},
    {"browse", "use browser or desktop interaction to inspect an external UI or site"},
    {"remediate", "repair a known failure, regression, flaky check, or operational issue"},
    {"address_review", "apply requested review feedback to an existing change"},
    {"prepare_merge", "perform final landing preparation after review and checks"},
    {"land_change", "merge or otherwise complete an already-approved change"},
    {"plan", "break ambiguous work into smaller work items before implementation"}
  ]

  @type intent_entry :: %{required(:name) => String.t(), required(:description) => String.t()}

  @spec entries() :: [intent_entry()]
  def entries do
    Enum.map(@intents, fn {name, description} ->
      %{name: name, description: description}
    end)
  end

  @spec names() :: [String.t()]
  def names, do: Enum.map(@intents, &elem(&1, 0))

  @spec inline_examples() :: String.t()
  def inline_examples, do: Enum.join(names(), ", ")

  @spec tool_description() :: String.t()
  def tool_description do
    "Use one of these dispatch intents when possible: " <>
      Enum.map_join(@intents, "; ", fn {name, description} -> "#{name}: #{description}" end) <>
      "."
  end

  @spec markdown_list() :: String.t()
  def markdown_list do
    Enum.map_join(@intents, "\n", fn {name, description} ->
      "- `#{name}` - #{description}."
    end)
  end
end
