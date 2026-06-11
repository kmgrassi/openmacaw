defmodule SymphonyElixir.Runner.ComputerUse do
  @moduledoc """
  Runner adapter for computer use agents.

  Executes work items by directing a computer use agent that controls a
  desktop or browser session. The agent navigates UIs, fills forms, runs
  applications, and reports results.

  ## Configuration

      runners:
        computer_use:
          endpoint: "https://cua.internal:9090"
          api_key: $CUA_API_KEY
          session_type: browser
          timeout_ms: 600000
          poll_interval_ms: 5000

  ## API contract

      POST /sessions              Start a new desktop/browser session
      POST /sessions/:id/action   Send an action (prompt)
      GET  /sessions/:id          Get session state
      DELETE /sessions/:id        End session
      GET  /health                Health check

  ## Workspace requirement

  Computer use agents operate on remote desktops/browsers, not local filesystems.
  `requires_workspace?/0` returns `false`.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.Cutover
  alias SymphonyElixir.Runner.HttpClient
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.Runner.Poller

  @default_timeout_ms 600_000
  @default_poll_interval_ms 5_000

  @impl true
  def start_session(config, _workspace) do
    if probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "computer_use"}}
      end
    else
      endpoint = Map.fetch!(config, "endpoint")
      api_key = Map.get(config, "api_key")
      session_type = Map.get(config, "session_type", "browser")
      timeout_ms = Map.get(config, "timeout_ms", @default_timeout_ms)
      poll_interval_ms = Map.get(config, "poll_interval_ms", @default_poll_interval_ms)

      body = %{session_type: session_type}

      case post(endpoint, "/sessions", body, api_key) do
        {:ok, %{status: status, body: %{"session_id" => session_id}}} when status in 200..299 ->
          {:ok,
           %{
             endpoint: endpoint,
             api_key: api_key,
             session_id: session_id,
             provider: Map.get(config, "provider") || "computer_use",
             model: Map.get(config, "model"),
             credential_id: Map.get(config, "credential_id"),
             credential_scope: Map.get(config, "credential_scope"),
             workspace_id: Map.get(config, "workspace_id"),
             agent_id: Map.get(config, "agent_id"),
             trace_id: Map.get(config, "trace_id") || Process.get(:symphony_trace_id),
             session_type: session_type,
             timeout_ms: timeout_ms,
             poll_interval_ms: poll_interval_ms,
             fallbacks: Map.get(config, "fallbacks") || Map.get(config, :fallbacks) || []
           }}

        {:ok, %{status: status, body: response_body}} ->
          {:error, {:session_create_failed, status, response_body}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  rescue
    e in KeyError ->
      {:error, {:missing_config, e.key}}
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    Cutover.walk_session(session, :computer_use, fn link_session, attempt ->
      run_turn_link(ensure_session(link_session), prompt, work_item, attempt)
    end)
  end

  defp run_turn_link(session, prompt, work_item, attempt) do
    body = %{
      prompt: prompt,
      context: %{
        id: work_item.id,
        identifier: work_item.identifier,
        title: work_item.title,
        description: work_item.description
      }
    }

    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, Map.get(work_item, :id), attempt)
    Observability.log_model_call_started(context)

    case post(session.endpoint, "/sessions/#{session.session_id}/action", body, session.api_key) do
      {:ok, %{status: status, body: %{"action_id" => _action_id}}} when status in 200..299 ->
        log_result(poll_session_until_complete(session), context, started_at)

      {:ok, %{status: status, body: %{"status" => "completed"} = result}} when status in 200..299 ->
        Observability.log_model_call_completed(context, elapsed_ms(started_at))
        {:ok, result}

      {:ok, %{status: status, body: resp_body}} ->
        failure =
          Observability.provider_status_failure(status, resp_body, nil, context, elapsed_ms(started_at))
          |> Observability.log_provider_failure()

        Cutover.classified_failure(failure, {:retryable, {:api_error, status, resp_body}})

      {:error, reason} ->
        failure =
          Observability.provider_request_failure(reason, context, elapsed_ms(started_at))
          |> Observability.log_provider_failure()

        Cutover.classified_failure(failure, {:retryable, reason})
    end
  end

  @impl true
  def stop_session(%{endpoint: endpoint, session_id: session_id, api_key: api_key}) do
    case delete(endpoint, "/sessions/#{session_id}", api_key) do
      {:ok, %{status: status}} when status in 200..299 -> :ok
      {:ok, %{status: 404}} -> :ok
      {:ok, %{status: status, body: body}} -> {:error, {:delete_failed, status, body}}
      {:error, reason} -> {:error, reason}
    end
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    endpoint = Map.get(config, "endpoint", "")
    api_key = Map.get(config, "api_key")

    case HttpClient.get(endpoint, "/health", api_key) do
      {:ok, %{status: 200}} -> :ok
      {:ok, %{status: status}} -> {:error, {:unhealthy, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def requires_workspace?, do: false

  # --- Polling ---

  defp poll_session_until_complete(session) do
    deadline = System.monotonic_time(:millisecond) + session.timeout_ms

    Poller.poll_until(
      deadline,
      session.poll_interval_ms,
      fn -> HttpClient.get(session.endpoint, "/sessions/#{session.session_id}", session.api_key) end,
      &classify_poll_result/1
    )
  end

  defp classify_poll_result({:ok, %{status: status, body: %{"status" => session_status} = body}})
       when status in 200..299 do
    case session_status do
      "completed" -> {:ok, body}
      "failed" -> {:error, {:fatal, {:session_failed, Map.get(body, "error")}}}
      "error" -> {:error, {:retryable, {:session_error, Map.get(body, "error")}}}
      _active -> :continue
    end
  end

  defp classify_poll_result({:ok, %{status: status, body: body}}),
    do: {:error, {:retryable, {:api_error, status, body}}}

  defp classify_poll_result({:error, reason}), do: {:error, {:retryable, reason}}

  defp ensure_session(%{session_id: session_id} = session) when is_binary(session_id), do: session

  defp ensure_session(%{endpoint: endpoint} = session) do
    body = %{session_type: Map.get(session, :session_type, "browser")}

    case post(endpoint, "/sessions", body, Map.get(session, :api_key)) do
      {:ok, %{status: status, body: %{"session_id" => session_id}}} when status in 200..299 ->
        Map.put(session, :session_id, session_id)

      _error ->
        session
    end
  end

  defp log_result({:ok, _body} = result, context, started_at) do
    Observability.log_model_call_completed(context, elapsed_ms(started_at))
    result
  end

  defp log_result({:error, {:retryable, reason}}, context, started_at) do
    failure =
      Observability.provider_error_failure(reason, context, elapsed_ms(started_at))
      |> Observability.log_provider_failure()

    Cutover.classified_failure(failure, {:retryable, reason})
  end

  defp log_result({:error, _reason} = result, _context, _started_at), do: result

  # --- HTTP helpers ---

  defp post(endpoint, path, body, api_key) do
    HttpClient.post(endpoint, path, body, api_key)
  end

  defp delete(endpoint, path, api_key) do
    HttpClient.delete(endpoint, path, api_key)
  end

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false

  defp provider_context(session, run_id, attempt) do
    %{
      provider: Map.get(session, :provider) || "computer_use",
      model: Map.get(session, :model),
      runner_kind: "computer_use",
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
end
