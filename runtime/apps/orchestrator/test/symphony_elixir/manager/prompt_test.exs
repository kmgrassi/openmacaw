defmodule SymphonyElixir.Manager.PromptTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Manager.Prompt
  alias SymphonyElixir.Orchestrator.IntentVocabulary

  test "version matches the manager system prompt filename" do
    assert Prompt.version() == "v1"

    prompt_path =
      :symphony_elixir
      |> :code.priv_dir()
      |> Path.join("prompts/manager-system-#{Prompt.version()}.md")

    assert File.exists?(prompt_path)
  end

  test "load! returns non-empty prompt content" do
    prompt = Prompt.load!()

    assert is_binary(prompt)
    assert String.length(prompt) > 0
    assert prompt =~ "You are a manager agent"
    assert prompt =~ "Always make exactly one tool call"
    assert prompt =~ "per task in `due_tasks`"
    assert prompt =~ "`git.run`"
  end

  test "load! injects shared dispatch intent vocabulary" do
    prompt = Prompt.load!()

    refute prompt =~ "{{INTENT_VOCABULARY}}"

    for %{name: name, description: description} <- IntentVocabulary.entries() do
      assert prompt =~ "- `#{name}` - #{description}."
    end
  end
end
