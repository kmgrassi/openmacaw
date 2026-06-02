defmodule SymphonyElixir.Manager.WorkItems.Database do
  @moduledoc """
  PostgREST-backed read path for due work items polled by
  `SymphonyElixir.Manager.Scheduler`.

  Replaces the previous Ecto-based `Scheduler.due_query/4`. The manager
  scheduler runs in launcher escript mode in production, which does NOT
  start `SymphonyElixir.Repo` (Repo only starts when `SUPABASE_POOLER`
  is configured — see `Repo.configured?/0`). Using Ecto for this one
  query path caused every tick to crash with `"could not lookup Ecto
  repo SymphonyElixir.Repo"` once the prior `invalid_profile_resolver`
  bug was fixed.

  Every other runtime DB access in the launcher path uses PostgREST.
  This module brings the manager's due-work-item poll in line with that
  convention — see CLAUDE.md "Database Connection Conventions".
  """

  alias SymphonyElixir.{PostgRESTClient, Time, WorkItem}

  @table "work_items"
  @select Enum.join(
            ~w(
              id identifier title description priority state workspace_id
              plan_id task_id labels metadata next_poll_at last_polled_at
              poll_cadence_seconds manager_runner_id created_at updated_at
            ),
            ","
          )

  @default_limit 25

  @spec due_work_items(String.t(), String.t() | nil, DateTime.t(), keyword()) ::
          {:ok, [WorkItem.t()]} | {:error, term()}
  def due_work_items(workspace_id, agent_id, %DateTime{} = now, opts \\ [])
      when is_binary(workspace_id) do
    states = Keyword.get(opts, :states, [])
    plan_ids = Keyword.get(opts, :plan_ids)
    limit = Keyword.get(opts, :limit, @default_limit)

    # `next_poll_at <= now` in Postgres already excludes NULL rows
    # (NULL comparisons return NULL/false), so the Ecto code's separate
    # `not is_nil(next_poll_at)` filter is redundant here.
    base_query = %{
      "select" => @select,
      "workspace_id" => "eq.#{workspace_id}",
      "next_poll_at" => "lte.#{Time.to_iso8601(now)}",
      "order" => "next_poll_at.asc",
      "limit" => Integer.to_string(limit)
    }

    query =
      base_query
      |> maybe_filter_states(states)
      |> maybe_filter_plan_ids(plan_ids)
      |> maybe_filter_manager_runner(agent_id)

    with {:ok, client} <- client(opts),
         {:ok, rows} when is_list(rows) <-
           PostgRESTClient.get(client, table(opts), query, log_metadata: %{operation: "manager.due_work_items", table: @table}) do
      {:ok, Enum.map(rows, &to_work_item/1)}
    else
      {:ok, body} -> {:error, {:invalid_due_work_items_response, body}}
      {:error, _reason} = error -> error
    end
  end

  # PostgREST encodes "x IN (a, b)" as `field=in.(a,b)`. An empty list would
  # filter to nothing (excluding everything), so skip the filter entirely.
  defp maybe_filter_states(query, []), do: query

  defp maybe_filter_states(query, states) when is_list(states) do
    Map.put(query, "state", "in.(#{Enum.map_join(states, ",", &to_string/1)})")
  end

  defp maybe_filter_plan_ids(query, nil), do: query
  defp maybe_filter_plan_ids(query, []), do: query

  defp maybe_filter_plan_ids(query, plan_ids) when is_list(plan_ids) do
    Map.put(query, "plan_id", "in.(#{Enum.join(plan_ids, ",")})")
  end

  # PostgREST "or" syntax: `or=(cond1,cond2)` means cond1 OR cond2. This
  # mirrors the Ecto `is_nil(manager_runner_id) or manager_runner_id ==
  # ^agent_id` — the manager only picks up work items it owns or that are
  # unowned.
  defp maybe_filter_manager_runner(query, agent_id) when is_binary(agent_id) and agent_id != "" do
    Map.put(query, "or", "(manager_runner_id.is.null,manager_runner_id.eq.#{agent_id})")
  end

  defp maybe_filter_manager_runner(query, _agent_id), do: query

  defp client(opts) do
    config =
      Application.get_env(:symphony_elixir, __MODULE__, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Keyword.get(opts, :config, [])))

    {:ok, PostgRESTClient.new(config, Keyword.get(opts, :req_options, req_options()))}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp req_options, do: Application.get_env(:symphony_elixir, :manager_due_work_items_req_options, [])

  defp table(opts) do
    opts_config = normalize_config(Keyword.get(opts, :config, []))
    app_config = normalize_config(Application.get_env(:symphony_elixir, __MODULE__, []))
    Map.get(opts_config, :table) || Map.get(app_config, :table) || @table
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  @spec to_work_item(map()) :: WorkItem.t()
  def to_work_item(row) when is_map(row) do
    metadata = row["metadata"] || %{}

    %WorkItem{
      id: row["id"],
      identifier: row["identifier"],
      title: row["title"],
      description: row["description"],
      priority: row["priority"],
      state: row["state"],
      url: Map.get(metadata, "url") || Map.get(metadata, :url),
      source: "database",
      runner_type: Map.get(metadata, "runner_type") || Map.get(metadata, :runner_type),
      plan_id: row["plan_id"],
      task_id: row["task_id"],
      labels: row["labels"] || [],
      metadata: metadata,
      created_at: Time.parse_iso8601(row["created_at"]),
      updated_at: Time.parse_iso8601(row["updated_at"])
    }
  end
end
