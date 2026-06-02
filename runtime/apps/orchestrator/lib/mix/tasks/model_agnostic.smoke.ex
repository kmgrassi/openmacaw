defmodule Mix.Tasks.ModelAgnostic.Smoke do
  @moduledoc """
  Replays the local model-agnostic planning-to-coding smoke fixture.

      mix model_agnostic.smoke
      mix model_agnostic.smoke path/to/fixture.json

  The fixture is API-shaped and deterministic. It does not call live model
  providers or require provider credentials.
  """

  use Mix.Task

  alias SymphonyElixir.Smoke.ModelAgnosticHarness

  @shortdoc "Replay the model-agnostic agent handoff smoke fixture"
  @default_fixture "priv/fixtures/model_agnostic_smoke/planning_to_coding_handoff.json"

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.config")

    path =
      args
      |> List.first()
      |> case do
        nil -> Path.expand(@default_fixture, File.cwd!())
        path -> Path.expand(path, File.cwd!())
      end

    case ModelAgnosticHarness.run_fixture(path) do
      {:ok, summary} ->
        Mix.shell().info("Model-agnostic smoke fixture passed")
        Mix.shell().info(Jason.encode!(summary, pretty: true))

      {:error, reason} ->
        Mix.raise("Model-agnostic smoke fixture failed: #{inspect(reason)}")
    end
  end
end
