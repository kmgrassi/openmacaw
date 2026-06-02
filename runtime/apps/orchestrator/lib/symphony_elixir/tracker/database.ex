defmodule SymphonyElixir.Tracker.Database do
  @moduledoc """
  Tracker adapter that talks to the platform's Supabase/Postgres REST API.

  ## Work item queue

  The runtime reads executable work from `work_items`. Older planner and ingest
  paths may still leave `task_id` populated from the legacy `task` shim, but new
  planner task tools create `work_items` rows directly.

  This adapter:

    * **Reads** from `work_items` — the unified queue that already merges
      tracker-specific metadata.
    * **Writes state updates** back to the configured writeback target. Without
      a writeback override, it patches the read table (`work_items`). Comments
      go to `work_item_comments`.

  If `writeback` is omitted, state updates fall back to the read `table`
  (useful for local dev when the schema has no separate canonical table).

  ## Configuration

      tracker:
        kind: database
        endpoint: "https://xyz.supabase.co/rest/v1"
        api_key: $SUPABASE_SERVICE_KEY
        table: work_items                   # read from here
        workspace_id: "..."                 # optional; scopes tables with workspace_id
        plan_id: "..."                      # optional; scopes reads to one plan
        runner_type: codex                  # optional; filters work_items.runner_kind
        writeback:                          # optional legacy override
          table: task                       # update state here
          id_field: task_id                 # FK on work_items → task.id
        comments_table: work_item_comments
        comment_author: orchestrator        # optional; defaults to "orchestrator"
        active_states: [todo, in_progress]
        terminal_states: [done, cancelled]

  ## Expected `work_items` columns

  Matches `supabase/generated/types.ts`:
    - id (uuid)
    - identifier (text, non-null)
    - title (text)
    - description (text)
    - state (text)
    - priority (text)          -- string, not integer
    - runner_kind (text, nullable)
    - repository (text, nullable)
    - labels (text[])
    - source (text)
    - metadata (jsonb)
    - workspace_id (uuid, nullable)
    - plan_id (uuid, nullable)
    - task_id (uuid, nullable) -- legacy FK to task.id when populated by the shim
    - created_at (timestamptz)
    - updated_at (timestamptz)

  `url` is NOT a column on `work_items`; if the tracker exposes one it should be
  stored under `metadata.url`, which `WorkItem.Mapper.from_database_row/1`
  surfaces on `WorkItem.url`.

  ## Legacy `task` writeback

  The legacy `task` table uses `status` (not `state`) as its lifecycle column.
  `update_issue_state/2` translates `state` → `status` when the writeback target
  is `task`. If `WorkItem.task_id` is nil, the update errors loudly rather than
  silently writing to the wrong table.
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.Config
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.SupabaseSchema
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkItem.Mapper, as: WorkItemMapper

  @default_comments_table "work_item_comments"
  @default_comment_author "orchestrator"
  @comment_source "orchestrator"

  def fetch_candidate_issues do
    fetch_candidate_issues(nil)
  end

  @impl true
  def fetch_candidate_issues(workspace_id) do
    config = tracker_config(workspace_id)
    states = config.active_states

    query =
      config
      |> base_scope_query(config.table)
      |> Map.merge(%{"state" => "in.(#{Enum.join(states, ",")})", "order" => "priority.asc"})
      |> maybe_put_runner_type(config)

    case PostgRESTClient.get(client(config), config.table, query, log_metadata: log_metadata(config, "tracker.database.fetch_candidate_issues", config.table)) do
      {:ok, rows} -> {:ok, Enum.map(rows, &WorkItemMapper.from_database_row/1)}
      {:error, _} = err -> err
    end
  end

  def fetch_issues_by_states(state_names) do
    fetch_issues_by_states(nil, state_names)
  end

  @impl true
  def fetch_issues_by_states(workspace_id, state_names) do
    config = tracker_config(workspace_id)

    query =
      config
      |> base_scope_query(config.table)
      |> Map.merge(%{"state" => "in.(#{Enum.join(state_names, ",")})"})
      |> maybe_put_runner_type(config)

    case PostgRESTClient.get(client(config), config.table, query, log_metadata: log_metadata(config, "tracker.database.fetch_issues_by_states", config.table)) do
      {:ok, rows} -> {:ok, Enum.map(rows, &WorkItemMapper.from_database_row/1)}
      {:error, _} = err -> err
    end
  end

  def fetch_issue_states_by_ids(issue_ids) do
    fetch_issue_states_by_ids(nil, issue_ids)
  end

  @impl true
  def fetch_issue_states_by_ids(workspace_id, issue_ids) do
    config = tracker_config(workspace_id)

    query =
      config
      |> base_scope_query(config.table)
      |> Map.merge(%{"id" => "in.(#{Enum.join(issue_ids, ",")})", "select" => "id,state"})

    case PostgRESTClient.get(client(config), config.table, query, log_metadata: log_metadata(config, "tracker.database.fetch_issue_states_by_ids", config.table)) do
      {:ok, rows} -> {:ok, Enum.map(rows, &WorkItemMapper.from_database_row/1)}
      {:error, _} = err -> err
    end
  end

  def create_comment(issue_id, body) do
    create_comment(nil, issue_id, body)
  end

  @impl true
  def create_comment(workspace_id, issue_id, body) do
    config = tracker_config(workspace_id)
    comments_table = config.comments_table || @default_comments_table
    author = config.comment_author || @default_comment_author

    payload = %{
      "work_item_id" => issue_id,
      "body" => body,
      "author" => author,
      "source" => @comment_source
    }

    case PostgRESTClient.post(client(config), comments_table, payload,
           prefer: "return=minimal",
           log_metadata: log_metadata(config, "tracker.database.create_comment", comments_table, work_item_id: issue_id)
         ) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  @doc """
  Update the state of a work item.

  `issue_id_or_item` accepts either a bare id (legacy callers) or a `%WorkItem{}`
  — prefer passing the full struct so the writeback target id can be resolved
  from `task_id`/`plan_id`.
  """
  def update_issue_state(%WorkItem{} = item, state_name) do
    update_issue_state(nil, item, state_name)
  end

  def update_issue_state(issue_id, state_name) when is_binary(issue_id) do
    update_issue_state(nil, issue_id, state_name)
  end

  @impl true
  def update_issue_state(workspace_id, %WorkItem{} = item, state_name) do
    config = tracker_config(workspace_id)
    {target_table, target_id, status_column} = resolve_writeback_target(config, item)

    payload = %{status_column => state_name}

    query =
      config
      |> writeback_scope_query(target_table)
      |> Map.put("id", "eq.#{target_id}")

    case PostgRESTClient.patch(client(config), target_table, query, payload,
           prefer: "return=minimal",
           log_metadata:
             log_metadata(config, "tracker.database.update_issue_state", target_table,
               work_item_id: item.id,
               writeback_id: target_id
             )
         ) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  def update_issue_state(workspace_id, issue_id, state_name) when is_binary(issue_id) do
    config = tracker_config(workspace_id)

    case config.writeback do
      %{id_field: id_field, table: _} when is_binary(id_field) ->
        {:error,
         {:missing_writeback_id,
          "update_issue_state/2 needs a %WorkItem{} when writeback.id_field is configured " <>
            "(got bare id #{inspect(issue_id)})"}}

      _ ->
        # Route bare ids through the same resolver as %WorkItem{} callers so
        # that a configured `writeback.table` (without `id_field`) is honored.
        # Without this, legacy bare-id callers would silently keep patching the
        # read/projection table while %WorkItem{} callers patched the writeback
        # target — the exact inconsistency flagged in review.
        update_issue_state(workspace_id, %WorkItem{id: issue_id}, state_name)
    end
  end

  @spec resolve_writeback_target(map(), WorkItem.t()) ::
          {String.t(), String.t(), String.t()}
  defp resolve_writeback_target(config, %WorkItem{} = item) do
    case config.writeback do
      %{table: table, id_field: id_field} when is_binary(table) and is_binary(id_field) ->
        target_id = writeback_id!(item, id_field)
        {table, target_id, status_column_for(table)}

      %{table: table} when is_binary(table) ->
        target_id = item.id || raise ArgumentError, "WorkItem.id is required for writeback"
        {table, target_id, status_column_for(table)}

      _ ->
        target_id = item.id || raise ArgumentError, "WorkItem.id is required for writeback"
        {config.table, target_id, "state"}
    end
  end

  defp writeback_id!(%WorkItem{task_id: nil}, "task_id") do
    raise ArgumentError,
          "writeback target requires WorkItem.task_id but it is nil — " <>
            "the work_items row has no linked task and cannot be updated"
  end

  defp writeback_id!(%WorkItem{task_id: task_id}, "task_id") when is_binary(task_id), do: task_id

  defp writeback_id!(%WorkItem{plan_id: nil}, "plan_id") do
    raise ArgumentError, "writeback target requires WorkItem.plan_id but it is nil"
  end

  defp writeback_id!(%WorkItem{plan_id: plan_id}, "plan_id") when is_binary(plan_id), do: plan_id

  defp writeback_id!(%WorkItem{id: id}, "id") when is_binary(id), do: id

  defp writeback_id!(%WorkItem{} = item, other_field) do
    raise ArgumentError,
          "unsupported writeback.id_field #{inspect(other_field)} for " <>
            "WorkItem #{inspect(item.identifier || item.id)}"
  end

  # The legacy `task` table uses `status` as its lifecycle column; `work_items`
  # uses `state`. Map the field name to the write target.
  defp status_column_for("task"), do: "status"
  defp status_column_for(_table), do: "state"

  defp base_scope_query(config, table) do
    %{}
    |> maybe_put_workspace_id(table, Map.get(config, :workspace_id))
    |> maybe_put_eq("plan_id", Map.get(config, :plan_id))
  end

  defp writeback_scope_query(config, table) do
    %{}
    |> maybe_put_workspace_id(table, Map.get(config, :workspace_id))
  end

  defp maybe_put_workspace_id(query, table, workspace_id) do
    if SupabaseSchema.column?(table, "workspace_id") do
      maybe_put_eq(query, "workspace_id", workspace_id)
    else
      query
    end
  end

  defp maybe_put_runner_type(query, config) do
    case normalize_blank(Map.get(config, :runner_type)) do
      nil -> query
      runner_type -> Map.put(query, "runner_kind", "eq.#{runner_type}")
    end
  end

  defp maybe_put_eq(query, _field, nil), do: query

  defp maybe_put_eq(query, field, value) when is_binary(value),
    do: Map.put(query, field, "eq.#{value}")

  defp maybe_put_eq(query, field, value), do: Map.put(query, field, "eq.#{to_string(value)}")

  defp normalize_blank(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_blank(_), do: nil

  defp tracker_config(workspace_id) do
    config = Config.settings!().tracker

    case normalize_blank(workspace_id) do
      nil -> config
      workspace_id -> Map.put(config, :workspace_id, workspace_id)
    end
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :database_tracker_req_options, [])

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp log_metadata(config, caller, table, extra \\ []) do
    extra
    |> Map.new()
    |> Map.merge(%{
      caller: caller,
      action: caller,
      table: table,
      workspace_id: Map.get(config, :workspace_id),
      plan_id: Map.get(config, :plan_id)
    })
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end
end
