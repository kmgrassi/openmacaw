defmodule SymphonyElixir.Runner do
  @moduledoc """
  Behavior contract for execution backends.

  Every worker type (Codex, OpenClaw, Computer Use, etc.) implements this interface.
  The orchestrator dispatches work items through `AgentRunner`, which resolves the
  appropriate runner and calls these callbacks. The orchestrator's dispatch loop,
  retry logic, and state machine are runner-agnostic.

  ## Runner resolution

  Work items are routed to runners by:
    1. Work item label (e.g., `runner:openclaw`)
    2. Work item `runner_type`
    3. Workflow config (`runner.type`)
    4. Default fallback (`runner.default`, defaults to `codex`)

  ## Session lifecycle

      runner.start_session(config, workspace)
      runner.run_turn(session, prompt, work_item)
      ... more turns ...
      runner.stop_session(session)

  ## Implementing a runner

  Runners must normalize their results into standard outcome types so the orchestrator's
  retry logic works uniformly:
    - `{:ok, result}` — turn completed successfully
    - `{:error, {:retryable, reason}}` — transient failure, orchestrator will retry
    - `{:error, {:fatal, reason}}` — permanent failure, no retry

  `SymphonyElixir.Runner.Contract` defines the normalized session, result, and
  event semantics that runner consumers may depend on. Adapter-specific process
  handles, protocol payloads, remote IDs, and transport metadata must stay
  adapter-owned implementation details.
  """

  alias SymphonyElixir.WorkItem

  @type session :: map()
  @type config :: map()
  @type result :: map()
  @type normalized_session :: SymphonyElixir.Runner.Contract.session()
  @type normalized_result :: SymphonyElixir.Runner.Contract.result()
  @type normalized_event :: SymphonyElixir.Runner.Contract.event()

  @doc """
  Start an execution session for a work item.

  `config` contains runner-specific settings (command, base_url, api_key, etc.).
  `workspace` is the filesystem path for runners that need one (e.g., Codex), or nil.
  """
  @callback start_session(config(), workspace :: String.t() | nil) ::
              {:ok, session()} | {:error, term()}

  @doc """
  Execute a single turn within an active session.

  The runner sends the prompt to the execution backend, waits for completion,
  and returns the result. For streaming backends, the `on_message` option in
  the session config can be used for progress callbacks.
  """
  @callback run_turn(session(), prompt :: String.t(), work_item :: WorkItem.t()) ::
              {:ok, result()} | {:error, term()}

  @doc """
  Stop an active session and clean up resources.

  For subprocess runners (Codex): kills the process.
  For HTTP runners (OpenClaw, CUA): closes the session via API.
  """
  @callback stop_session(session()) :: :ok | {:error, term()}

  @doc """
  Health check for the runner backend.

  Returns `:ok` if the backend is reachable and ready to accept work.
  Used by the orchestrator to skip unhealthy runners during dispatch.
  """
  @callback ping(config()) :: :ok | {:error, term()}

  @doc """
  Whether this runner type requires a workspace directory.

  Codex needs a git workspace. OpenClaw may or may not. Computer Use does not.
  The orchestrator uses this to decide whether to call `Workspace.create_for_issue/2`.
  """
  @callback requires_workspace?() :: boolean()

  @doc """
  Resolve the runner module for a given work item based on labels and config.
  """
  @spec resolve(WorkItem.t(), map()) :: module()
  def resolve(%WorkItem{} = work_item, runner_config) do
    label_runner = extract_runner_from_labels(work_item.labels)

    runner_type =
      label_runner || normalize_runner_type(work_item.runner_type) ||
        Map.get(runner_config, "default", "codex")

    case runner_type do
      "codex" -> SymphonyElixir.Runner.Codex
      "claude_code" -> SymphonyElixir.Runner.ClaudeCode
      "manager" -> SymphonyElixir.Runner.LlmToolRunner
      "planner" -> SymphonyElixir.Runner.Planner
      "openclaw" -> SymphonyElixir.Runner.OpenClaw
      "openclaw_ws" -> SymphonyElixir.Runner.OpenClawWS
      "computer_use" -> SymphonyElixir.Runner.ComputerUse
      "local_relay" -> SymphonyElixir.Runner.LocalRelay
      "local_model_coding" -> SymphonyElixir.Runner.LocalModelCoding
      _other -> SymphonyElixir.Runner.Codex
    end
  end

  defp extract_runner_from_labels(labels) when is_list(labels) do
    Enum.find_value(labels, fn label ->
      case String.split(label, ":", parts: 2) do
        ["runner", runner_type] -> runner_type
        _ -> nil
      end
    end)
  end

  defp extract_runner_from_labels(_), do: nil

  defp normalize_runner_type(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_runner_type(_), do: nil
end
