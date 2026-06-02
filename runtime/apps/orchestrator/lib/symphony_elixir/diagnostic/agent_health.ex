defmodule SymphonyElixir.Diagnostic.AgentHealth do
  @moduledoc """
  Batch diagnostic helpers for agent runtime readiness.
  """

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Diagnostic.AgentProbe

  @default_concurrency 5
  @default_per_agent_timeout_ms 10_000
  @default_aggregate_timeout_ms 30_000
  @poll_ms 50

  @type agent_result :: %{
          required(:agent_id) => String.t(),
          required(:runner_kind) => String.t(),
          required(:status) => String.t(),
          optional(:reason) => String.t(),
          optional(:details) => map()
        }

  @spec workspace_agents(String.t(), keyword()) ::
          {:ok, %{workspace_id: String.t(), agents: [agent_result()]}} | {:error, term()}
  def workspace_agents(workspace_id, opts \\ [])

  def workspace_agents(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    opts = Keyword.merge(default_options(), opts)
    inventory = Keyword.get(opts, :agent_inventory, AgentInventory)

    with {:ok, agents} <- inventory.list_agents() do
      scoped_agents =
        agents
        |> Enum.filter(&workspace_agent?(&1, workspace_id))
        |> Enum.filter(&valid_agent_id?/1)

      results = probe_agents(scoped_agents, workspace_id, opts)
      {:ok, %{workspace_id: workspace_id, agents: results}}
    end
  end

  def workspace_agents(_workspace_id, _opts), do: {:error, :invalid_workspace_id}

  @spec agent(String.t(), String.t(), keyword()) :: agent_result()
  def agent(workspace_id, agent_id, opts \\ []) do
    opts = Keyword.merge(default_options(), opts)
    probe = Keyword.get(opts, :probe, AgentProbe)
    format_probe_result(%Agent{id: agent_id, workspace_id: workspace_id}, probe.probe(workspace_id, agent_id))
  end

  defp default_options do
    Application.get_env(:symphony_elixir, :agent_diagnostic_options, [])
  end

  defp probe_agents([], _workspace_id, _opts), do: []

  defp probe_agents(agents, workspace_id, opts) do
    probe = Keyword.get(opts, :probe, AgentProbe)
    max_concurrency = Keyword.get(opts, :max_concurrency, @default_concurrency)
    per_agent_timeout_ms = Keyword.get(opts, :per_agent_timeout_ms, @default_per_agent_timeout_ms)
    aggregate_timeout_ms = Keyword.get(opts, :aggregate_timeout_ms, @default_aggregate_timeout_ms)
    deadline = now_ms() + aggregate_timeout_ms

    initial = %{
      workspace_id: workspace_id,
      probe: probe,
      per_agent_timeout_ms: per_agent_timeout_ms,
      deadline: deadline,
      max_concurrency: max(1, max_concurrency),
      queue: Enum.with_index(agents),
      running: [],
      results: %{}
    }

    final =
      initial
      |> launch_available()
      |> collect_results()

    agents
    |> Enum.with_index()
    |> Enum.map(fn {%Agent{id: agent_id} = agent, index} ->
      Map.get(final.results, index, %{
        agent_id: agent_id,
        runner_kind: runner_kind_for_agent(agent),
        status: "timeout"
      })
    end)
  end

  defp collect_results(%{queue: [], running: []} = state), do: state

  defp collect_results(%{deadline: deadline} = state) do
    now = now_ms()

    cond do
      now >= deadline ->
        timeout_all(state)

      true ->
        state
        |> collect_ready_tasks(min(@poll_ms, deadline - now))
        |> timeout_expired_tasks()
        |> launch_available()
        |> collect_results()
    end
  end

  defp launch_available(%{running: running, queue: queue, max_concurrency: max_concurrency} = state)
       when length(running) >= max_concurrency or queue == [] do
    state
  end

  defp launch_available(%{queue: [{%Agent{id: agent_id} = agent, index} | queue], running: running} = state) do
    task =
      Task.async(fn ->
        format_probe_result(agent, state.probe.probe(state.workspace_id, agent_id))
      end)

    launch_available(%{
      state
      | queue: queue,
        running: [%{task: task, agent: agent, index: index, started_at: now_ms()} | running]
    })
  end

  defp collect_ready_tasks(%{running: running} = state, timeout_ms) do
    timeout_ms = max(0, timeout_ms)
    task_info_by_ref = Map.new(running, fn %{task: task} = task_info -> {task.ref, task_info} end)

    {completed, still_running} =
      running
      |> Enum.map(& &1.task)
      |> Task.yield_many(timeout_ms)
      |> Enum.reduce({[], []}, fn
        {%Task{} = task, {:ok, result}}, {completed, still_running} ->
          %{index: index} = Map.fetch!(task_info_by_ref, task.ref)
          Task.shutdown(task, :brutal_kill)
          {[{index, result} | completed], still_running}

        {%Task{} = task, {:exit, reason}}, {completed, still_running} ->
          %{agent: %Agent{id: agent_id} = agent, index: index} = Map.fetch!(task_info_by_ref, task.ref)
          Task.shutdown(task, :brutal_kill)

          result = %{
            agent_id: agent_id,
            runner_kind: runner_kind_for_agent(agent),
            status: "not_ready",
            reason: "runner_spawn_failed",
            details: %{reason: inspect(reason)}
          }

          {[{index, result} | completed], still_running}

        {%Task{} = task, nil}, {completed, still_running} ->
          task_info = Map.fetch!(task_info_by_ref, task.ref)
          {completed, [task_info | still_running]}
      end)

    record_completed(%{state | running: still_running}, completed)
  end

  defp timeout_expired_tasks(%{running: running, per_agent_timeout_ms: per_agent_timeout_ms} = state) do
    now = now_ms()

    {expired, active} =
      Enum.split_with(running, fn %{started_at: started_at} ->
        now - started_at >= per_agent_timeout_ms
      end)

    completed =
      Enum.map(expired, fn %{task: task, agent: %Agent{id: agent_id} = agent, index: index} ->
        Task.shutdown(task, :brutal_kill)
        {index, %{agent_id: agent_id, runner_kind: runner_kind_for_agent(agent), status: "timeout"}}
      end)

    record_completed(%{state | running: active}, completed)
  end

  defp timeout_all(%{queue: queue, running: running} = state) do
    running_results =
      Enum.map(running, fn %{task: task, agent: %Agent{id: agent_id} = agent, index: index} ->
        Task.shutdown(task, :brutal_kill)
        {index, %{agent_id: agent_id, runner_kind: runner_kind_for_agent(agent), status: "timeout"}}
      end)

    queued_results =
      Enum.map(queue, fn {%Agent{id: agent_id} = agent, index} ->
        {index, %{agent_id: agent_id, runner_kind: runner_kind_for_agent(agent), status: "timeout"}}
      end)

    state
    |> record_completed(running_results ++ queued_results)
    |> Map.put(:running, [])
    |> Map.put(:queue, [])
  end

  defp record_completed(state, completed) do
    results =
      Enum.reduce(completed, state.results, fn {index, result}, results ->
        Map.put(results, index, result)
      end)

    %{state | results: results}
  end

  defp format_probe_result(%Agent{id: agent_id} = agent, {:ok, :ready}) do
    %{agent_id: agent_id, runner_kind: runner_kind_for_agent(agent), status: "ready"}
  end

  defp format_probe_result(%Agent{id: agent_id} = agent, {:error, reason, details}) do
    %{
      agent_id: agent_id,
      runner_kind: runner_kind_for_agent(agent),
      status: "not_ready",
      reason: Atom.to_string(reason),
      details: details || %{}
    }
  end

  defp format_probe_result(%Agent{id: agent_id} = agent, {:error, reason}) do
    %{
      agent_id: agent_id,
      runner_kind: runner_kind_for_agent(agent),
      status: "not_ready",
      reason: Atom.to_string(reason),
      details: %{}
    }
  end

  defp format_probe_result(%Agent{id: agent_id} = agent, other) do
    %{
      agent_id: agent_id,
      runner_kind: runner_kind_for_agent(agent),
      status: "not_ready",
      reason: "probe_failed",
      details: %{reason: inspect(other)}
    }
  end

  # Keep the launcher diagnostic response aligned with the platform
  # `RunnerKindSchema` contract. These are the default routing-rule values by
  # agent type; explicit per-agent routing can still be surfaced separately.
  defp runner_kind_for_agent(%Agent{} = agent) do
    case Agent.kind(agent) do
      "planning" -> "planner"
      "manager" -> "llm_tool_runner"
      "custom" -> "openclaw_ws"
      _ -> "codex"
    end
  end

  defp workspace_agent?(%Agent{workspace_id: workspace_id}, workspace_id), do: true
  defp workspace_agent?(_agent, _workspace_id), do: false

  defp valid_agent_id?(%Agent{id: agent_id}), do: is_binary(agent_id) and agent_id != ""

  defp now_ms, do: System.monotonic_time(:millisecond)
end
