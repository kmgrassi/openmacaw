defmodule Mix.Tasks.LocalModel.Smoke do
  use Mix.Task

  alias SymphonyElixir.LocalModelSmoke

  @shortdoc "Run the manual Ollama/Qwen OpenAI-compatible smoke test"

  @moduledoc """
  Runs a manual local-model smoke test against an OpenAI-compatible endpoint.

  By default this targets Ollama's OpenAI-compatible API at
  `http://127.0.0.1:11434/v1` with `qwen2.5-coder:latest`.

      mix local_model.smoke
      mix local_model.smoke --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:latest

  Supported options:

    * `--base-url` - OpenAI-compatible base URL.
    * `--model` - model name to send in the chat completion request.
    * `--api-key` - bearer token value; Ollama accepts any non-empty value.
    * `--prompt` - prompt used for the smoke completion.
  """

  @switches [base_url: :string, model: :string, api_key: :string, prompt: :string, help: :boolean]

  @impl Mix.Task
  def run(args) do
    {opts, _argv, invalid} = OptionParser.parse(args, strict: @switches, aliases: [h: :help])

    cond do
      opts[:help] ->
        Mix.shell().info(@moduledoc)

      invalid != [] ->
        Mix.raise("Invalid option(s): #{inspect(invalid)}")

      true ->
        opts
        |> config_overrides()
        |> run_smoke()
    end
  end

  defp config_overrides(opts) do
    %{}
    |> put_if_present(:base_url, opts[:base_url])
    |> put_if_present(:model, opts[:model])
    |> put_if_present(:api_key, opts[:api_key])
    |> put_if_present(:prompt, opts[:prompt])
  end

  defp run_smoke(config) do
    case LocalModelSmoke.run(config: config) do
      {:ok, summary} ->
        Mix.shell().info("local_model.smoke: completion received from #{summary.provider}/#{summary.model}")
        Mix.shell().info("local_model.smoke: normalized events: #{Enum.join(summary.normalized_events, ", ")}")
        Mix.shell().info("local_model.smoke: output: #{summary.output_text}")
        :ok

      {:error, reason} ->
        Mix.raise("local_model.smoke failed: #{inspect(reason)}")
    end
  end

  defp put_if_present(map, _key, nil), do: map
  defp put_if_present(map, key, value), do: Map.put(map, key, value)
end
