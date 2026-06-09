defmodule SymphonyElixir.CloudExecutor.CLI do
  @moduledoc false

  alias SymphonyElixir.CloudExecutor.PublicRepository

  @switches [
    request_json: :string,
    workspace_root: :string
  ]
  @smoke_switches [
    dry_run: :boolean,
    metric_namespace: :string,
    region: :string,
    force_fail: :string,
    timeout_ms: :integer
  ]

  @spec evaluate([String.t()]) :: :ok | {:error, String.t()}
  def evaluate(["coding-executor" | args]) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        run_coding_executor(opts)

      _ ->
        {:error, usage()}
    end
  end

  def evaluate(["smoke-catalog" | args]) do
    case OptionParser.parse(args, strict: @smoke_switches) do
      {opts, [], []} ->
        run_smoke_catalog(opts)

      _ ->
        {:error, usage()}
    end
  end

  def evaluate(["public-repository" | args]) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        run_public_repository(opts)

      _ ->
        {:error, usage()}
    end
  end

  def evaluate(_args), do: {:error, usage()}

  defp run_smoke_catalog(opts) do
    with :ok <- ensure_smoke_dependencies(),
         :ok <- SymphonyElixir.ContainerSmoke.Runner.run(opts) do
      :ok
    else
      {:error, {:container_smoke_failed, failed_ids}} ->
        {:error, "container smoke failed: #{Enum.join(failed_ids, ", ")}"}

      {:error, reason} ->
        {:error, "container smoke failed: #{inspect(reason)}"}
    end
  end

  defp run_coding_executor(opts) do
    with {:ok, request} <- read_request(Keyword.get(opts, :request_json)),
         {:ok, prepared} <- SymphonyElixir.CloudExecutor.CodingExecutor.prepare(request, workspace_root: workspace_root(opts)) do
      SymphonyElixir.CloudExecutor.CodingExecutor.run_loop(prepared)
      :ok
    else
      {:error, %{} = error} ->
        IO.puts(
          Jason.encode!(%{
            "type" => "error",
            "schema_version" => "1",
            "code" => Map.get(error, "code", "coding_executor_failed"),
            "message" => Map.get(error, "detail", inspect(error))
          })
        )

        {:error, "coding executor failed: #{Map.get(error, "code", "unknown")}"}

      {:error, message} when is_binary(message) ->
        {:error, message}

      {:error, reason} ->
        {:error, "coding executor failed: #{inspect(reason)}"}
    end
  end

  defp run_public_repository(opts) do
    with {:ok, request} <- read_request(Keyword.get(opts, :request_json)),
         {:ok, result} <- PublicRepository.run(request, workspace_root: workspace_root(opts)) do
      IO.puts(Jason.encode!(%{"ok" => true, "result" => result}))
      :ok
    else
      {:error, %{} = error} ->
        IO.puts(Jason.encode!(%{"ok" => false, "error" => error}))
        {:error, "cloud executor failed: #{Map.get(error, "code", "unknown")}"}

      {:error, message} when is_binary(message) ->
        {:error, message}

      {:error, reason} ->
        {:error, "cloud executor failed: #{inspect(reason)}"}
    end
  end

  defp read_request(path) when is_binary(path) do
    with {:ok, body} <- File.read(path),
         {:ok, request} <- Jason.decode(body) do
      {:ok, request}
    else
      {:error, %Jason.DecodeError{} = error} -> {:error, "Invalid request JSON: #{Exception.message(error)}"}
      {:error, reason} -> {:error, "Unable to read request JSON: #{inspect(reason)}"}
    end
  end

  defp read_request(nil) do
    case System.get_env("SYMPHONY_EXECUTION_REQUEST_JSON") do
      value when is_binary(value) and value != "" ->
        case Jason.decode(value) do
          {:ok, request} -> {:ok, request}
          {:error, error} -> {:error, "Invalid SYMPHONY_EXECUTION_REQUEST_JSON: #{Exception.message(error)}"}
        end

      _ ->
        {:error, usage()}
    end
  end

  defp workspace_root(opts) do
    Keyword.get(opts, :workspace_root) || System.get_env("SYMPHONY_EXECUTOR_WORKSPACE_ROOT") || "/workspace"
  end

  defp ensure_smoke_dependencies do
    Enum.reduce_while([:jason, :req], :ok, fn app, _acc ->
      case Application.ensure_all_started(app) do
        {:ok, _started} -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp usage do
    "Usage: symphony cloud-executor <public-repository|coding-executor|smoke-catalog> [--request-json <path>] [--workspace-root <path>] [--dry-run] [--metric-namespace <namespace>] [--region <region>] [--force-fail <test-id|all>] [--timeout-ms <ms>]"
  end
end
