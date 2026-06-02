defmodule SymphonyElixir.BrokerLog do
  @moduledoc """
  Writes orchestrator execution history to Supabase `broker_run` and `broker_task`.

  Mapping (see OR-6 in `docs/launcher-integration-pr-plan.md`):

    - Work item claim → `INSERT broker_run` with `status='started'`, tracker metadata,
      workspace path, prompt input.
    - Each completed Codex turn → `INSERT broker_task` with token usage and
      `last_event`.
    - Run end → `UPDATE broker_run SET status=<completed|failed|cancelled>,
      completed_at, output, error, terminal_reason`.

  Gating: requires Supabase endpoint + service key (env vars or application
  config) AND a `stored_agent` injected into WORKFLOW.md by the Launcher. Any
  missing piece makes every function no-op with `:disabled`, so local-dev runs
  without Supabase credentials are safe.

  ## Configuration

      config :symphony_elixir, :broker_log,
        endpoint: System.get_env("LAUNCHER_SUPABASE_URL") ||
                    System.get_env("SUPABASE_URL"),
        api_key: System.get_env("LAUNCHER_SUPABASE_SERVICE_KEY") ||
                   System.get_env("SUPABASE_SERVICE_ROLE_KEY")

  Env var precedence matches the launcher-side writers introduced in OR-4/OR-5
  so operators set `LAUNCHER_SUPABASE_*` once and every subsystem picks it up.
  """

  alias SymphonyElixir.Config
  alias SymphonyElixir.MapUtils
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.Time
  alias SymphonyElixir.WorkItem

  @run_table "broker_run"
  @task_table "broker_task"

  @type run_id :: String.t()
  @type result :: {:ok, term()} | :disabled | {:error, term()}

  @spec enabled?() :: boolean()
  def enabled? do
    case resolve_config() do
      {:ok, _config} -> true
      _ -> false
    end
  end

  @doc """
  Inserts a `broker_run` row representing the claim of a work item.

  Returns `{:ok, run_id}` on success, `:disabled` when Supabase credentials or
  the `stored_agent` identity are missing, or `{:error, reason}` when the HTTP
  write fails.
  """
  @spec start_run(keyword()) :: {:ok, run_id()} | :disabled | {:error, term()}
  def start_run(attrs) when is_list(attrs) do
    with {:ok, config} <- resolve_config(),
         {:ok, identity} <- stored_agent_identity() do
      issue = Keyword.fetch!(attrs, :issue)

      payload =
        %{
          "agent_id" => identity.agent_id,
          "workspace_id" => identity.workspace_id,
          "status" => "started",
          "mode" => "orchestrator",
          "attempt" => normalize_attempt(Keyword.get(attrs, :attempt)),
          "tracker_kind" => tracker_kind(),
          "tracker_issue_key" => tracker_issue_key(issue),
          "issue_identifier" => work_item_field(issue, :identifier),
          "issue_state" => work_item_field(issue, :state),
          "workspace_path" => Keyword.get(attrs, :workspace_path),
          "input" => build_input_payload(issue, attrs),
          "queued_at" => Time.now_iso8601(),
          "started_at" => Time.now_iso8601()
        }
        |> MapUtils.drop_nil_values()

      case PostgRESTClient.post(client(config), @run_table, payload,
             prefer: "return=representation",
             query: %{"select" => "run_id"},
             log_metadata:
               log_metadata("broker_log.start_run", @run_table,
                 agent_id: identity.agent_id,
                 workspace_id: identity.workspace_id
               )
           ) do
        {:ok, [%{"run_id" => run_id} | _]} when is_binary(run_id) ->
          {:ok, run_id}

        {:ok, body} ->
          log_broker_persistence_failed(:start_run, {:invalid_response, body}, %{
            table: @run_table,
            agent_id: identity.agent_id,
            workspace_id: identity.workspace_id,
            issue_id: work_item_field(issue, :id),
            issue_identifier: work_item_field(issue, :identifier)
          })

          {:error, {:invalid_response, body}}

        {:error, reason} = err ->
          log_broker_persistence_failed(:start_run, reason, %{
            table: @run_table,
            agent_id: identity.agent_id,
            workspace_id: identity.workspace_id,
            issue_id: work_item_field(issue, :id),
            issue_identifier: work_item_field(issue, :identifier)
          })

          err
      end
    end
  end

  @doc """
  Inserts a `broker_task` row for a single Codex turn.

  `attrs` may include `:input_tokens`, `:output_tokens`, `:total_tokens`,
  `:last_event`, and `:attempt`.
  """
  @spec record_turn(run_id(), keyword()) :: result()
  def record_turn(run_id, attrs) when is_binary(run_id) and is_list(attrs) do
    with {:ok, config} <- resolve_config() do
      payload =
        %{
          "run_id" => run_id,
          "type" => "turn",
          "status" => Keyword.get(attrs, :status, "succeeded"),
          "attempt" => normalize_attempt(Keyword.get(attrs, :attempt)),
          "input_tokens" => non_negative_integer(Keyword.get(attrs, :input_tokens)),
          "output_tokens" => non_negative_integer(Keyword.get(attrs, :output_tokens)),
          "total_tokens" => non_negative_integer(Keyword.get(attrs, :total_tokens)),
          "last_event" => MapUtils.stringify(Keyword.get(attrs, :last_event)),
          "last_event_at" => Time.now_iso8601()
        }
        |> MapUtils.drop_nil_values()

      case PostgRESTClient.post(client(config), @task_table, payload,
             prefer: "return=minimal",
             log_metadata: log_metadata("broker_log.record_turn", @task_table, run_id: run_id)
           ) do
        {:ok, _} ->
          :ok

        {:error, reason} = err ->
          log_broker_persistence_failed(:record_turn, reason, %{
            table: @task_table,
            run_id: run_id,
            turn_number: normalize_attempt(Keyword.get(attrs, :attempt))
          })

          err
      end
    end
  end

  def record_turn(_run_id, _attrs), do: :disabled

  @doc """
  Patches a `broker_run` row with an arbitrary set of attributes.

  Used mid-run to back-fill fields that become known after the row is
  created (e.g. `workspace_path` once `Workspace.create_for_issue/2`
  succeeds). Unknown or nil values are dropped.
  """
  @spec update_run(run_id(), map()) :: result()
  def update_run(run_id, attrs) when is_binary(run_id) and is_map(attrs) do
    with {:ok, config} <- resolve_config() do
      payload = MapUtils.drop_nil_values(attrs)

      if map_size(payload) == 0 do
        :ok
      else
        case PostgRESTClient.patch(
               client(config),
               @run_table,
               %{"run_id" => "eq.#{run_id}"},
               payload,
               prefer: "return=minimal",
               log_metadata: log_metadata("broker_log.update_run", @run_table, run_id: run_id)
             ) do
          {:ok, _} ->
            :ok

          {:error, reason} = err ->
            log_broker_persistence_failed(:update_run, reason, %{
              table: @run_table,
              run_id: run_id
            })

            err
        end
      end
    end
  end

  def update_run(_run_id, _attrs), do: :disabled

  @doc """
  Patches a `broker_run` row to mark the run finished.

  `attrs` may include `:status`, `:terminal_reason`, `:error`, and `:output`.
  Defaults `status` to `"completed"`.
  """
  @spec finish_run(run_id(), keyword()) :: result()
  def finish_run(run_id, attrs) when is_binary(run_id) and is_list(attrs) do
    with {:ok, config} <- resolve_config() do
      payload =
        %{
          "status" => Keyword.get(attrs, :status, "completed"),
          "terminal_reason" => MapUtils.stringify(Keyword.get(attrs, :terminal_reason)),
          "error" => MapUtils.stringify(Keyword.get(attrs, :error)),
          "output" => Keyword.get(attrs, :output),
          "completed_at" => Time.now_iso8601()
        }
        |> MapUtils.drop_nil_values()

      case PostgRESTClient.patch(
             client(config),
             @run_table,
             %{"run_id" => "eq.#{run_id}"},
             payload,
             prefer: "return=minimal",
             log_metadata: log_metadata("broker_log.finish_run", @run_table, run_id: run_id)
           ) do
        {:ok, _} ->
          :ok

        {:error, reason} = err ->
          log_broker_persistence_failed(:finish_run, reason, %{
            table: @run_table,
            run_id: run_id,
            status: Map.get(payload, "status")
          })

          err
      end
    end
  end

  def finish_run(_run_id, _attrs), do: :disabled

  @doc """
  Marks any `broker_run` rows for this agent still in `status='started'` as
  `failed` with `terminal_reason='orphaned'`.

  Called once at orchestrator boot by `SymphonyElixir.BrokerLog.Reconciler`
  so that crashes or hard restarts don't leave dangling "running" rows.
  """
  @spec reconcile_orphans() :: result()
  def reconcile_orphans do
    with {:ok, config} <- resolve_config(),
         {:ok, identity} <- stored_agent_identity() do
      payload = %{
        "status" => "failed",
        "terminal_reason" => "orphaned",
        "completed_at" => Time.now_iso8601(),
        "error" => "orchestrator boot detected orphaned run"
      }

      case PostgRESTClient.patch(
             client(config),
             @run_table,
             %{"agent_id" => "eq.#{identity.agent_id}", "status" => "eq.started"},
             payload,
             prefer: "return=minimal",
             log_metadata:
               log_metadata("broker_log.reconcile_orphans", @run_table,
                 agent_id: identity.agent_id,
                 workspace_id: identity.workspace_id
               )
           ) do
        {:ok, _} ->
          :ok

        {:error, reason} = err ->
          log_broker_persistence_failed(:reconcile_orphans, reason, %{
            table: @run_table,
            agent_id: identity.agent_id,
            workspace_id: identity.workspace_id
          })

          err
      end
    end
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :broker_log_req_options, [])

  # --- config resolution ---

  defp resolve_config do
    config =
      :symphony_elixir
      |> Application.get_env(:broker_log, [])
      |> Enum.into(%{})

    endpoint =
      Map.get(config, :endpoint) ||
        system_env("LAUNCHER_SUPABASE_URL") ||
        system_env("SUPABASE_URL")

    api_key =
      Map.get(config, :api_key) ||
        system_env("LAUNCHER_SUPABASE_SERVICE_KEY") ||
        system_env("SUPABASE_SERVICE_ROLE_KEY")

    cond do
      not is_binary(endpoint) or endpoint == "" ->
        :disabled

      not is_binary(api_key) or api_key == "" ->
        :disabled

      true ->
        {:ok,
         config
         |> Map.put(:endpoint, String.trim_trailing(endpoint, "/"))
         |> Map.put(:api_key, api_key)}
    end
  end

  defp stored_agent_identity do
    case safe_settings() do
      {:ok, %{stored_agent: %{id: agent_id, workspace_id: workspace_id}}}
      when is_binary(agent_id) and agent_id != "" and is_binary(workspace_id) and workspace_id != "" ->
        {:ok, %{agent_id: agent_id, workspace_id: workspace_id}}

      _ ->
        :disabled
    end
  end

  defp safe_settings do
    Config.settings()
  rescue
    _ -> :error
  end

  # --- payload helpers ---

  defp tracker_kind do
    case safe_settings() do
      {:ok, %{tracker: %{kind: kind}}} when is_binary(kind) and kind != "" -> kind
      _ -> nil
    end
  end

  defp tracker_issue_key(%WorkItem{metadata: metadata, id: id}) when is_map(metadata) do
    Map.get(metadata, :remote_key) || Map.get(metadata, "remote_key") ||
      Map.get(metadata, :external_id) || Map.get(metadata, "external_id") || id
  end

  defp tracker_issue_key(%WorkItem{id: id}), do: id
  defp tracker_issue_key(%{id: id}), do: id
  defp tracker_issue_key(_), do: nil

  defp work_item_field(%WorkItem{} = issue, :identifier), do: issue.identifier
  defp work_item_field(%WorkItem{} = issue, :state), do: issue.state
  defp work_item_field(%WorkItem{} = issue, :id), do: issue.id
  defp work_item_field(%{identifier: id}, :identifier), do: id
  defp work_item_field(%{state: state}, :state), do: state
  defp work_item_field(%{id: id}, :id), do: id
  defp work_item_field(_, _), do: nil

  defp log_broker_persistence_failed(operation, reason, fields) do
    RuntimeLog.log(
      :warning,
      :broker_persistence_failed,
      fields
      |> Map.merge(%{
        operation: Atom.to_string(operation),
        error_code: "broker_persistence_failed",
        non_fatal: true,
        retryable: retryable_persistence_failure?(reason),
        reason: inspect(reason)
      })
    )
  end

  defp retryable_persistence_failure?({:http_error, 429, _body}), do: true
  defp retryable_persistence_failure?({:http_error, status, _body}) when status >= 500, do: true
  defp retryable_persistence_failure?({:request_failed, _reason}), do: true
  defp retryable_persistence_failure?(_reason), do: false

  defp build_input_payload(issue, attrs) do
    extra = Keyword.get(attrs, :input, %{}) |> to_map()

    %{
      "identifier" => work_item_field(issue, :identifier),
      "title" => map_get(issue, :title),
      "source" => map_get(issue, :source),
      "state" => work_item_field(issue, :state),
      "worker_host" => Keyword.get(attrs, :worker_host)
    }
    |> Map.merge(extra)
    |> MapUtils.drop_nil_values()
  end

  defp map_get(%WorkItem{} = item, key), do: Map.get(item, key)
  defp map_get(map, key) when is_map(map), do: MapUtils.atom_or_string_get(map, key)
  defp map_get(_, _), do: nil

  defp to_map(value) when is_map(value), do: value
  defp to_map(_), do: %{}

  defp normalize_attempt(value) when is_integer(value) and value >= 0, do: value
  defp normalize_attempt(_), do: nil

  defp non_negative_integer(value) when is_integer(value) and value >= 0, do: value
  defp non_negative_integer(_), do: nil

  defp system_env(name) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp log_metadata(caller, table, extra) do
    extra
    |> Map.new()
    |> Map.merge(%{caller: caller, action: caller, table: table})
    |> MapUtils.drop_nil_values()
  end
end
