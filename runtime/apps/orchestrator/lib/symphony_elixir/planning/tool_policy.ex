defmodule SymphonyElixir.Planning.ToolPolicy do
  @moduledoc """
  Resolves planner tool routing from an agent `tool_policy` map.
  """

  @valid_destinations ~w(database linear)

  @spec destination(map() | nil) :: String.t()
  def destination(tool_policy) do
    tool_policy
    |> planning_policy()
    |> get_value("destination")
    |> normalize_destination()
  end

  @spec linear_config(map() | nil) :: {:ok, map()} | {:error, term()}
  def linear_config(tool_policy) do
    planning = planning_policy(tool_policy)
    linear = get_value(planning, "linear") || %{}
    api_key = normalize_string(get_value(linear, "api_key"))

    cond do
      destination(tool_policy) != "linear" ->
        {:error, :linear_planning_disabled}

      not is_map(linear) ->
        {:error, :invalid_linear_planning_config}

      is_nil(api_key) ->
        {:error, :missing_linear_api_token}

      true ->
        {:ok,
         %{
           api_key: api_key,
           endpoint: normalize_string(get_value(linear, "endpoint")) || "https://api.linear.app/graphql",
           team_id: get_value(linear, "team_id"),
           project_id: get_value(linear, "project_id"),
           state_id: get_value(linear, "state_id"),
           assignee_id: get_value(linear, "assignee_id"),
           label_ids: normalize_string_list(get_value(linear, "label_ids"))
         }}
    end
  end

  defp planning_policy(tool_policy) when is_map(tool_policy) do
    case get_value(tool_policy, "planning") do
      value when is_map(value) -> value
      _ -> %{}
    end
  end

  defp planning_policy(_tool_policy), do: %{}

  defp normalize_destination(destination) when is_binary(destination) do
    normalized = destination |> String.trim() |> String.downcase()

    if normalized in @valid_destinations do
      normalized
    else
      "database"
    end
  end

  defp normalize_destination(_destination), do: "database"

  defp normalize_string_list(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
  end

  defp normalize_string_list(_values), do: []

  defp get_value(map, key) when is_map(map) and is_binary(key) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  rescue
    ArgumentError -> Map.get(map, key)
  end

  defp get_value(_map, _key), do: nil

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil
end
