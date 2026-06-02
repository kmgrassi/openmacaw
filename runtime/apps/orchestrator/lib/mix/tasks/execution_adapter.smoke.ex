defmodule Mix.Tasks.ExecutionAdapter.Smoke do
  use Mix.Task

  alias SymphonyElixir.ExecutionAdapter
  alias SymphonyElixir.ExecutionAdapter.Error

  @shortdoc "Smoke the execution adapter contract"

  @moduledoc """
  Calls the execution adapter contract with a no-op request.

      mix execution_adapter.smoke
      mix execution_adapter.smoke --target aws

  AWS config can be passed through environment variables:

    * `SYMPHONY_AWS_EXECUTION_CLUSTER`
    * `SYMPHONY_AWS_EXECUTION_TASK_DEFINITION`
    * `SYMPHONY_AWS_EXECUTION_SUBNETS`
    * `SYMPHONY_AWS_EXECUTION_SECURITY_GROUPS`

  A missing AWS config response is considered a successful contract smoke
  because RT-PR1 only proves structured pre-launch behavior.
  """

  @switches [target: :string, mode: :string, help: :boolean]

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
        |> request()
        |> run_smoke()
    end
  end

  defp request(opts) do
    %{
      execution_target: opts[:target] || "aws",
      workspace_id: "smoke-workspace",
      agent_id: "smoke-agent",
      run_id: "execution-adapter-smoke",
      execution_mode: opts[:mode] || "planning_read_only",
      resources: []
    }
  end

  defp run_smoke(request) do
    case ExecutionAdapter.start_run(request) do
      {:ok, summary} ->
        Mix.shell().info("execution_adapter.smoke: #{Jason.encode!(summary)}")
        :ok

      {:error, %Error{code: :missing_adapter_config} = error} ->
        Mix.shell().info("execution_adapter.smoke: #{Jason.encode!(Error.to_map(error))}")
        :ok

      {:error, error} ->
        Mix.raise("execution_adapter.smoke failed: #{Jason.encode!(Error.to_map(error))}")
    end
  end
end
