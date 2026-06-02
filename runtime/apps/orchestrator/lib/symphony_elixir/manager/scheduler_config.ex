defmodule SymphonyElixir.Manager.SchedulerConfig do
  @moduledoc """
  Reads scheduler-only settings for an agent.

  Until the platform writes a dedicated scheduler config row, these fields
  transitionally come from workspace `gateway_config.runners.manager`.
  """

  require Logger

  alias SymphonyElixir.Launcher.GatewayConfig

  @default_due_states ["running", "awaiting_review"]
  @allowed_states ~w(todo pending running awaiting_review blocked done failed)
  @default_due_task_query %{states: @default_due_states, plan_ids: nil}
  @default_min_cadence_ms 60_000

  @spec min_cadence_ms(String.t(), String.t()) :: pos_integer()
  def min_cadence_ms(workspace_id, agent_id) do
    case GatewayConfig.fetch("workspace", workspace_id) do
      {:ok, resolved} ->
        agent_value = get_in(resolved.config_json, ["runners", "manager", agent_id, "min_cadence_ms"])
        workspace_value = get_in(resolved.config_json, ["runners", "manager", "min_cadence_ms"])
        first_positive_integer([agent_value, workspace_value, @default_min_cadence_ms])

      _ ->
        @default_min_cadence_ms
    end
  end

  @spec due_task_query(String.t(), String.t()) :: %{states: [String.t()], plan_ids: [String.t()] | nil}
  def due_task_query(workspace_id, agent_id) do
    case GatewayConfig.fetch("workspace", workspace_id) do
      {:ok, %{config_json: config}} ->
        agent_value =
          if is_binary(agent_id) and agent_id != "" do
            get_in(config, ["runners", "manager", agent_id, "due_task_query"])
          end

        workspace_value = get_in(config, ["runners", "manager", "due_task_query"])
        merge_due_task_query(agent_value, workspace_value)

      _ ->
        @default_due_task_query
    end
  end

  def default_due_task_query, do: @default_due_task_query
  def allowed_states, do: @allowed_states
  def default_min_cadence_ms, do: @default_min_cadence_ms

  defp first_positive_integer([]), do: @default_min_cadence_ms

  defp first_positive_integer([value | rest]) do
    if is_integer(value) and value > 0, do: value, else: first_positive_integer(rest)
  end

  defp merge_due_task_query(nil, nil), do: @default_due_task_query
  defp merge_due_task_query(nil, workspace_value), do: normalize_due_task_query(workspace_value)
  defp merge_due_task_query(agent_value, _workspace_value), do: normalize_due_task_query(agent_value)

  defp normalize_due_task_query(value) when is_map(value) do
    %{states: normalize_due_states(value), plan_ids: normalize_plan_ids(value)}
  end

  defp normalize_due_task_query(_value), do: @default_due_task_query

  defp normalize_due_states(value) do
    case Map.get(value, "states") || Map.get(value, :states) do
      states when is_list(states) ->
        normalized_states = Enum.map(states, &to_string/1)
        valid_states = Enum.filter(normalized_states, &(&1 in @allowed_states))
        invalid_states = normalized_states -- valid_states

        if invalid_states != [] do
          Logger.warning("Ignoring invalid manager due_task_query states: #{inspect(invalid_states)}")
        end

        case valid_states do
          [] ->
            if normalized_states != [] do
              Logger.warning("Manager due_task_query states contained no valid values; using defaults")
            end

            @default_due_task_query.states

          states ->
            states
        end

      _ ->
        @default_due_task_query.states
    end
  end

  defp normalize_plan_ids(value) do
    case Map.get(value, "plan_ids") || Map.get(value, :plan_ids) do
      nil ->
        nil

      plan_ids when is_list(plan_ids) ->
        valid_ids = Enum.filter(plan_ids, &valid_uuid?/1)
        invalid_ids = plan_ids -- valid_ids

        if invalid_ids != [] do
          Logger.warning("Ignoring invalid manager due_task_query plan_ids: #{inspect(invalid_ids)}")
        end

        case valid_ids do
          [] -> nil
          ids -> ids
        end

      other ->
        Logger.warning("Ignoring invalid manager due_task_query plan_ids: #{inspect(other)}")
        nil
    end
  end

  defp valid_uuid?(value) when is_binary(value) do
    Regex.match?(
      ~r/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      value
    )
  end

  defp valid_uuid?(_value), do: false
end
