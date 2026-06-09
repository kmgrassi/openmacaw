defmodule SymphonyElixir.ContainerSmoke.Runner do
  @moduledoc """
  Runs the container-execution smoke catalog and emits one pass/fail metric per test.
  """

  alias SymphonyElixir.CloudExecution.Aws.CloudWatchClient
  alias SymphonyElixir.ContainerSmoke.Catalog

  @default_timeout_ms 120_000

  @type result :: %{
          required(:id) => String.t(),
          required(:status) => :passed | :failed,
          required(:message) => String.t(),
          required(:duration_ms) => non_neg_integer()
        }

  @type deps :: %{
          optional(:command_runner) => (String.t(), non_neg_integer() -> {Collectable.t(), non_neg_integer()}),
          optional(:metric_client) => module()
        }

  @spec run(keyword(), deps()) :: :ok | {:error, term()}
  def run(opts \\ [], deps \\ %{}) do
    results =
      Catalog.tests()
      |> Enum.map(&run_test(&1, opts, deps))

    :ok = write_jsonl(results)

    with :ok <- maybe_emit_metrics(results, opts, deps) do
      case Enum.filter(results, &(&1.status == :failed)) do
        [] -> :ok
        failures -> {:error, {:container_smoke_failed, Enum.map(failures, & &1.id)}}
      end
    end
  end

  defp run_test(test, opts, deps) do
    start = System.monotonic_time(:millisecond)
    forced_failure = forced_failure?(test.id, opts)

    {status, message} =
      cond do
        forced_failure ->
          {:failed, "forced failure for alarm verification"}

        Keyword.get(opts, :dry_run, false) ->
          {:passed, "dry-run catalog validation"}

        command = command_for(test) ->
          run_command(command, timeout_ms(opts), deps)

        true ->
          {:failed, "missing #{test.command_env}; configure the command that proves this smoke in the target environment"}
      end

    %{
      id: test.id,
      status: status,
      message: message,
      duration_ms: System.monotonic_time(:millisecond) - start
    }
  end

  defp run_command(command, timeout_ms, deps) do
    runner = Map.get(deps, :command_runner, &default_command_runner/2)

    case runner.(command, timeout_ms) do
      {_output, 0} -> {:passed, "command exited 0"}
      {output, status} -> {:failed, "command exited #{status}: #{trim_output(output)}"}
    end
  rescue
    error -> {:failed, Exception.message(error)}
  end

  defp default_command_runner(command, timeout_ms) do
    task =
      Task.async(fn ->
        System.cmd("/bin/sh", ["-lc", command], stderr_to_stdout: true)
      end)

    Task.await(task, timeout_ms)
  catch
    :exit, {:timeout, _} ->
      {"timed out after #{timeout_ms}ms", 124}
  end

  defp maybe_emit_metrics(results, opts, deps) do
    if Keyword.get(opts, :dry_run, false) do
      :ok
    else
      namespace = Keyword.get(opts, :metric_namespace) || System.get_env("CONTAINER_SMOKE_METRIC_NAMESPACE")

      if present?(namespace) do
        metric_client = Map.get(deps, :metric_client, CloudWatchClient)
        metric_client.put_metric_data(namespace, metrics(results), region: Keyword.get(opts, :region))
      else
        {:error, {:missing_container_smoke_metric_namespace, "CONTAINER_SMOKE_METRIC_NAMESPACE"}}
      end
    end
  end

  defp metrics(results) do
    Enum.flat_map(results, fn result ->
      failed = if result.status == :failed, do: 1, else: 0
      passed = if result.status == :passed, do: 1, else: 0

      [
        metric("SmokeTestFailed", failed, result),
        metric("SmokeTestPassed", passed, result),
        metric("SmokeTestDurationMs", result.duration_ms, result, "Milliseconds")
      ]
    end)
  end

  defp metric(name, value, result, unit \\ "Count") do
    %{
      name: name,
      value: value,
      unit: unit,
      dimensions: %{"TestName" => result.id}
    }
  end

  defp write_jsonl(results) do
    Enum.each(results, fn result ->
      IO.puts(Jason.encode!(Map.put(result, :type, "container_smoke_result")))
    end)
  end

  defp command_for(test) do
    case System.get_env(test.command_env) do
      command when is_binary(command) and command != "" -> command
      _ -> nil
    end
  end

  defp forced_failure?(test_id, opts) do
    forced =
      Keyword.get(opts, :force_fail) ||
        System.get_env("CONTAINER_SMOKE_FORCE_FAIL") ||
        ""

    forced
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.any?(&(&1 in [test_id, "all"]))
  end

  defp timeout_ms(opts), do: Keyword.get(opts, :timeout_ms) || parse_int(System.get_env("CONTAINER_SMOKE_TIMEOUT_MS"), @default_timeout_ms)

  defp parse_int(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> default
    end
  end

  defp parse_int(_value, default), do: default

  defp trim_output(output) when is_binary(output) do
    output
    |> String.replace(~r/\s+/, " ")
    |> String.slice(0, 500)
  end

  defp trim_output(output), do: inspect(output)

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false
end
