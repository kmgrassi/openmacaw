defmodule SymphonyElixir.Orchestrator.SnapshotBuilder do
  @moduledoc false

  alias SymphonyElixir.Orchestrator.State
  alias SymphonyElixir.RepoCache.Diagnostics, as: RepoCacheDiagnostics

  @spec build(State.t()) :: map()
  def build(%State{} = state) do
    now = DateTime.utc_now()
    now_ms = System.monotonic_time(:millisecond)

    %{
      running: build_running(state.running, now),
      retrying: build_retrying(state.retry_attempts, now_ms),
      codex_totals: state.codex_totals,
      rate_limits: Map.get(state, :codex_rate_limits),
      capacity: %{
        workflow_max_concurrent_agents: state.max_concurrent_agents,
        workspace_id: Map.get(state, :workspace_id),
        workspace_max_concurrent_agents: Map.get(state, :workspace_max_concurrent_agents),
        workspace_active_agents_count: Map.get(state, :workspace_active_agents_count),
        workspace_cap_error: Map.get(state, :workspace_cap_error),
        effective_max_concurrent_agents: SymphonyElixir.Orchestrator.DispatchPolicy.effective_global_cap(state)
      },
      repo_cache: RepoCacheDiagnostics.snapshot(),
      polling: %{
        checking?: state.poll_check_in_progress == true,
        next_poll_in_ms: next_poll_in_ms(state.next_poll_due_at_ms, now_ms),
        poll_interval_ms: state.poll_interval_ms
      }
    }
  end

  defp build_running(running, now) when is_map(running) do
    Enum.map(running, fn {issue_id, metadata} ->
      %{
        issue_id: issue_id,
        identifier: metadata.identifier,
        state: metadata.issue.state,
        worker_host: Map.get(metadata, :worker_host),
        workspace_path: Map.get(metadata, :workspace_path),
        session_id: metadata.session_id,
        codex_app_server_pid: metadata.codex_app_server_pid,
        codex_input_tokens: metadata.codex_input_tokens,
        codex_output_tokens: metadata.codex_output_tokens,
        codex_total_tokens: metadata.codex_total_tokens,
        turn_count: Map.get(metadata, :turn_count, 0),
        started_at: metadata.started_at,
        last_codex_timestamp: metadata.last_codex_timestamp,
        last_codex_message: metadata.last_codex_message,
        last_codex_event: metadata.last_codex_event,
        runtime_seconds: running_seconds(metadata.started_at, now)
      }
    end)
  end

  defp build_retrying(retry_attempts, now_ms) when is_map(retry_attempts) do
    Enum.map(retry_attempts, fn {issue_id, %{attempt: attempt, due_at_ms: due_at_ms} = retry} ->
      %{
        issue_id: issue_id,
        attempt: attempt,
        due_in_ms: max(0, due_at_ms - now_ms),
        identifier: Map.get(retry, :identifier),
        error: Map.get(retry, :error),
        worker_host: Map.get(retry, :worker_host),
        workspace_path: Map.get(retry, :workspace_path)
      }
    end)
  end

  defp next_poll_in_ms(nil, _now_ms), do: nil

  defp next_poll_in_ms(next_poll_due_at_ms, now_ms) when is_integer(next_poll_due_at_ms) do
    max(0, next_poll_due_at_ms - now_ms)
  end

  defp running_seconds(%DateTime{} = started_at, %DateTime{} = now) do
    max(0, DateTime.diff(now, started_at, :second))
  end

  defp running_seconds(_started_at, _now), do: 0
end
