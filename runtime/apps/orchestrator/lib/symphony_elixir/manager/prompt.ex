defmodule SymphonyElixir.Manager.Prompt do
  @moduledoc """
  Versioned manager-agent system prompt loader.

  The prompt is embedded into the compiled module at build time so it
  is always present regardless of how the orchestrator is packaged
  (mix dev, escript, release). The previous implementation read the
  file at runtime via `:code.priv_dir/1`, which under our escript
  build resolves to a path *inside* the escript binary
  (`bin/symphony/symphony_elixir/priv/...`). That path is not a real
  directory, so `File.read!` failed with `:enotdir`. The failure broke
  `Manager.Scheduler` init at orchestrator boot and made the
  manager-on-local chat path racy — it only worked when an earlier
  call happened to populate a `:persistent_term` cache from a
  different code-loading context.

  Embedding the file content as a module attribute eliminates the
  runtime file I/O entirely and removes the cache. `@external_resource`
  ensures the module recompiles when the prompt text changes.
  """

  @version "v1"

  @prompt_path Path.expand(Path.join([__DIR__, "..", "..", "..", "priv", "prompts", "manager-system-#{@version}.md"]))

  @external_resource @prompt_path

  @prompt @prompt_path
          |> File.read!()
          |> String.replace(
            "{{INTENT_VOCABULARY}}",
            SymphonyElixir.Orchestrator.IntentVocabulary.markdown_list()
          )
          |> String.trim()

  @spec version() :: String.t()
  def version, do: @version

  @spec load!() :: String.t()
  def load!, do: @prompt
end
