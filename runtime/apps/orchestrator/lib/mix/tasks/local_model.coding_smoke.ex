defmodule Mix.Tasks.LocalModel.CodingSmoke do
  use Mix.Task

  alias SymphonyElixir.LocalModelCodingSmoke

  @shortdoc "Run the manual local-model coding tool smoke test"

  @moduledoc """
  Runs a manual local-model coding smoke test against an OpenAI-compatible endpoint.

  The task creates a disposable workspace containing `message.txt` and `test.sh`,
  asks the model to read `message.txt` through `shell.exec`, asks the model to
  call `apply_patch`, executes that patch in Runtime, asks the model to call
  `shell.exec` again, runs `./test.sh`, and then requires a final model response.

  By default this targets Ollama's OpenAI-compatible API at
  `http://127.0.0.1:11434/v1` with `qwen2.5-coder:latest`.

      mix local_model.coding_smoke
      mix local_model.coding_smoke --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:latest
      mix local_model.coding_smoke --workspace /tmp/local-model-coding-smoke

  Supported options:

    * `--base-url` - OpenAI-compatible base URL.
    * `--model` - model name to send in the chat completion request.
    * `--api-key` - bearer token value; Ollama accepts any non-empty value.
    * `--workspace` - optional disposable workspace path to recreate and use.
    * `--max-iterations` - maximum model/tool turns.
    * `--command-timeout-ms` - timeout for the `shell.exec` command.
  """

  @switches [
    base_url: :string,
    model: :string,
    api_key: :string,
    workspace: :string,
    max_iterations: :integer,
    command_timeout_ms: :integer,
    help: :boolean
  ]

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
    |> put_if_present(:workspace, opts[:workspace])
    |> put_if_present(:max_iterations, opts[:max_iterations])
    |> put_if_present(:command_timeout_ms, opts[:command_timeout_ms])
  end

  defp run_smoke(config) do
    case LocalModelCodingSmoke.run(config: config) do
      {:ok, summary} ->
        Mix.shell().info("local_model.coding_smoke: completion received from #{summary.provider}/#{summary.model}")
        Mix.shell().info("local_model.coding_smoke: workspace: #{summary.workspace}")
        Mix.shell().info("local_model.coding_smoke: tool calls: #{Enum.join(summary.tool_calls, ", ")}")
        Mix.shell().info("local_model.coding_smoke: events: #{Enum.join(summary.events, ", ")}")
        Mix.shell().info("local_model.coding_smoke: output: #{summary.output_text}")
        :ok

      {:error, reason} ->
        Mix.raise("local_model.coding_smoke failed: #{inspect(reason)}")
    end
  end

  defp put_if_present(map, _key, nil), do: map
  defp put_if_present(map, key, value), do: Map.put(map, key, value)
end
