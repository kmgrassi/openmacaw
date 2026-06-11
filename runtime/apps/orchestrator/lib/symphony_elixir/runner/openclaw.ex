defmodule SymphonyElixir.Runner.OpenClaw do
  @moduledoc """
  Runner adapter for OpenClaw instances.

  Executes work items by making HTTP API calls to a remote OpenClaw service.
  The orchestrator sends a run request, polls for completion, and retrieves results.

  ## Configuration

      runners:
        openclaw:
          base_url: "https://openclaw.local:8080"
          api_key: $OPENCLAW_API_KEY
          model: "o4-mini"
          timeout_ms: 300000
          poll_interval_ms: 5000

  ## API contract

      POST /v1/runs          Start a run with prompt + work item context
      GET  /v1/runs/:id      Poll run status
      POST /v1/runs/:id/cancel  Cancel a running session
      GET  /v1/health        Health check

  ## Workspace requirement

  OpenClaw manages its own workspace. `requires_workspace?/0` returns `false`.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.Cutover
  alias SymphonyElixir.Runner.HttpClient
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.Runner.Poller

  @default_poll_interval_ms 5_000
  @default_timeout_ms 300_000

  @impl true
  def start_session(config, _workspace) do
    if probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "openclaw"}}
      end
    else
      base_url = Map.fetch!(config, "base_url")
      api_key = Map.get(config, "api_key")

      {:ok,
       %{
         base_url: base_url,
         api_key: api_key,
         model: Map.get(config, "model"),
         provider: Map.get(config, "provider") || "openclaw",
         credential_id: Map.get(config, "credential_id"),
         credential_scope: Map.get(config, "credential_scope"),
         workspace_id: Map.get(config, "workspace_id"),
         agent_id: Map.get(config, "agent_id"),
         trace_id: Map.get(config, "trace_id") || Process.get(:symphony_trace_id),
         fallbacks: Map.get(config, "fallbacks") || Map.get(config, :fallbacks) || [],
         poll_interval_ms: Map.get(config, "poll_interval_ms", @default_poll_interval_ms),
         timeout_ms: Map.get(config, "timeout_ms", @default_timeout_ms)
       }}
    end
  rescue
    e in KeyError ->
      {:error, {:missing_config, e.key}}
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    Cutover.walk_session(session, :openclaw, fn link_session, attempt ->
      run_turn_link(link_session, prompt, work_item, attempt)
    end)
  end

  defp run_turn_link(session, prompt, work_item, attempt) do
    body =
      %{
        prompt: prompt,
        context: %{
          id: work_item.id,
          identifier: work_item.identifier,
          title: work_item.title,
          description: work_item.description,
          labels: work_item.labels,
          metadata: work_item.metadata
        }
      }
      |> maybe_put(:model, session.model)

    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, Map.get(work_item, :id), attempt)
    Observability.log_model_call_started(context)

    {result, failure_logged?} =
      case post(session, "/v1/runs", body) do
        {:ok, %{status: status, body: %{"id" => run_id}}} when status in 200..299 ->
          session_with_run = Map.put(session, :run_id, run_id)
          classify_poll_result_for_cutover(poll_until_complete(session_with_run, run_id), context, started_at)

        {:ok, %{status: status, body: body}} ->
          failure =
            Observability.provider_status_failure(status, body, nil, context, elapsed_ms(started_at))
            |> Observability.log_provider_failure()

          {Cutover.classified_failure(failure, {:retryable, {:api_error, status, body}}), true}

        {:error, reason} ->
          failure =
            Observability.provider_request_failure(reason, context, elapsed_ms(started_at))
            |> Observability.log_provider_failure()

          {Cutover.classified_failure(failure, {:retryable, reason}), true}
      end

    case {result, failure_logged?} do
      {{:ok, %{"id" => provider_request_id}}, _failure_logged?} ->
        Observability.log_model_call_completed(context, elapsed_ms(started_at), provider_request_id: provider_request_id)

      {{:ok, _body}, _failure_logged?} ->
        Observability.log_model_call_completed(context, elapsed_ms(started_at))

      {{:error, _reason}, true} ->
        :ok

      {{:error, {_kind, reason}}, false} ->
        Observability.provider_error_failure(reason, context, elapsed_ms(started_at))
        |> Observability.log_provider_failure()
    end

    result
  end

  @impl true
  def stop_session(%{run_id: run_id} = session) do
    case post(session, "/v1/runs/#{run_id}/cancel", %{}) do
      {:ok, %{status: status}} when status in 200..299 -> :ok
      {:ok, %{status: 404}} -> :ok
      {:ok, %{status: status, body: body}} -> {:error, {:cancel_failed, status, body}}
      {:error, reason} -> {:error, reason}
    end
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    base_url = Map.get(config, "base_url", "")
    api_key = Map.get(config, "api_key")

    case HttpClient.get(base_url, "/v1/health", api_key) do
      {:ok, %{status: 200}} -> :ok
      {:ok, %{status: status}} -> {:error, {:unhealthy, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def requires_workspace?, do: false

  # --- Polling ---

  defp poll_until_complete(session, run_id) do
    deadline = System.monotonic_time(:millisecond) + session.timeout_ms

    Poller.poll_until(
      deadline,
      session.poll_interval_ms,
      fn -> get(session, "/v1/runs/#{run_id}") end,
      &classify_poll_result/1
    )
  end

  defp classify_poll_result({:ok, %{status: status, body: %{"status" => run_status} = body}}) when status in 200..299 do
    case run_status do
      "completed" -> {:ok, body}
      "failed" -> {:error, {:fatal, {:run_failed, Map.get(body, "error")}}}
      "cancelled" -> {:error, {:fatal, :run_cancelled}}
      _pending -> :continue
    end
  end

  defp classify_poll_result({:ok, %{status: status, body: body}}),
    do: {:error, {:retryable, {:api_error, status, body}}}

  defp classify_poll_result({:error, reason}), do: {:error, {:retryable, reason}}

  defp classify_poll_result_for_cutover({:error, {:retryable, {:api_error, status, body}}}, context, started_at) do
    failure =
      Observability.provider_status_failure(status, body, nil, context, elapsed_ms(started_at))
      |> Observability.log_provider_failure()

    {Cutover.classified_failure(failure, {:retryable, {:api_error, status, body}}), true}
  end

  defp classify_poll_result_for_cutover({:error, {:retryable, reason}}, context, started_at) do
    failure =
      Observability.provider_request_failure(reason, context, elapsed_ms(started_at))
      |> Observability.log_provider_failure()

    {Cutover.classified_failure(failure, {:retryable, reason}), true}
  end

  defp classify_poll_result_for_cutover(result, _context, _started_at), do: {result, false}

  # --- HTTP helpers ---

  defp get(session, path) do
    HttpClient.get(session.base_url, path, session.api_key)
  end

  defp post(session, path, body) do
    HttpClient.post(session.base_url, path, body, session.api_key)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp provider_context(session, run_id, attempt) do
    %{
      provider: Map.get(session, :provider) || "openclaw",
      model: Map.get(session, :model),
      runner_kind: "openclaw",
      credential_scope: Map.get(session, :credential_scope),
      credential_id: Map.get(session, :credential_id),
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      trace_id: Map.get(session, :trace_id),
      run_id: run_id,
      attempt: attempt
    }
  end

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
