defmodule SymphonyElixir.Planning.LinearTools do
  @moduledoc """
  Linear-backed planner tool wrappers.
  """

  alias SymphonyElixir.Linear.Client
  alias SymphonyElixir.Planning.ToolPolicy

  @allowed_update_fields ~w(title name description priority state_id assignee_id label_ids project_id)

  @spec create_issue(map(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def create_issue(arguments, tool_policy, opts \\ [])
      when is_map(arguments) and is_map(tool_policy) and is_list(opts) do
    with {:ok, config} <- ToolPolicy.linear_config(tool_policy),
         {:ok, input} <- create_issue_input(arguments, config) do
      client = Keyword.get(opts, :linear_client, &Client.create_issue/2)
      client.(input, linear_client_opts(config, opts))
    end
  end

  @spec update_issue(map(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def update_issue(arguments, tool_policy, opts \\ [])
      when is_map(arguments) and is_map(tool_policy) and is_list(opts) do
    with {:ok, config} <- ToolPolicy.linear_config(tool_policy),
         {:ok, issue_id} <- required_string(arguments, "issue_id"),
         {:ok, input} <- update_issue_input(arguments) do
      client = Keyword.get(opts, :linear_client, &Client.update_issue/3)
      client.(issue_id, input, linear_client_opts(config, opts))
    end
  end

  defp create_issue_input(arguments, config) do
    with {:ok, title} <- required_title(arguments),
         {:ok, team_id} <- required_config_string(config, :team_id) do
      input =
        %{
          "teamId" => team_id,
          "title" => title,
          "description" => optional_string(arguments, "description"),
          "priority" => optional_integer(arguments, "priority"),
          "projectId" => config.project_id,
          "stateId" => config.state_id,
          "assigneeId" => config.assignee_id,
          "labelIds" => optional_labels(arguments, config)
        }
        |> reject_empty_values()

      {:ok, input}
    end
  end

  defp update_issue_input(arguments) do
    input =
      arguments
      |> Enum.reduce(%{}, fn {key, value}, acc ->
        normalized_key = normalize_key(key)

        if normalized_key in @allowed_update_fields do
          put_update_value(acc, normalized_key, value)
        else
          acc
        end
      end)
      |> reject_empty_values()

    case input do
      map when map_size(map) == 0 -> {:error, :missing_linear_issue_update_fields}
      map -> {:ok, map}
    end
  end

  defp put_update_value(acc, "name", value), do: put_update_value(acc, "title", value)

  defp put_update_value(acc, "label_ids", value) do
    labels = normalize_string_list(value)

    if labels == [] do
      acc
    else
      Map.put(acc, "labelIds", labels)
    end
  end

  defp put_update_value(acc, key, value) when key in ["priority"] do
    case normalize_integer(value) do
      nil -> acc
      normalized -> Map.put(acc, key, normalized)
    end
  end

  defp put_update_value(acc, key, value) do
    case optional_string(%{key => value}, key) do
      nil -> acc
      normalized -> Map.put(acc, camelize_key(key), normalized)
    end
  end

  defp required_title(arguments) do
    case optional_string(arguments, "name") || optional_string(arguments, "title") do
      nil -> {:error, :missing_linear_issue_title}
      title -> {:ok, title}
    end
  end

  defp required_string(arguments, key) do
    case optional_string(arguments, key) do
      nil -> {:error, :"missing_linear_#{key}"}
      value -> {:ok, value}
    end
  end

  defp required_config_string(config, key) do
    case Map.get(config, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :"missing_linear_#{key}"}
    end
  end

  defp optional_labels(arguments, %{label_ids: configured_labels}) do
    labels =
      case normalize_string_list(get_value(arguments, "label_ids")) do
        [] -> configured_labels
        values -> values
      end

    case labels do
      [] -> nil
      values -> values
    end
  end

  defp optional_string(arguments, key) do
    arguments
    |> get_value(key)
    |> normalize_string()
  end

  defp optional_integer(arguments, key) do
    arguments
    |> get_value(key)
    |> normalize_integer()
  end

  defp normalize_integer(value) when is_integer(value), do: value

  defp normalize_integer(value) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {integer, ""} -> integer
      _ -> nil
    end
  end

  defp normalize_integer(_value), do: nil

  defp normalize_string_list(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
  end

  defp normalize_string_list(_values), do: []

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil

  defp reject_empty_values(map) do
    Map.reject(map, fn {_key, value} ->
      is_nil(value) or value == [] or value == ""
    end)
  end

  defp linear_client_opts(config, opts) do
    opts
    |> Keyword.drop([:linear_client])
    |> Keyword.put(:api_key, config.api_key)
    |> Keyword.put(:endpoint, config.endpoint)
  end

  defp normalize_key(key) when is_atom(key), do: Atom.to_string(key)
  defp normalize_key(key) when is_binary(key), do: key
  defp normalize_key(key), do: to_string(key)

  defp camelize_key("state_id"), do: "stateId"
  defp camelize_key("assignee_id"), do: "assigneeId"
  defp camelize_key("project_id"), do: "projectId"
  defp camelize_key(key), do: key

  defp get_value(map, key) when is_map(map) and is_binary(key) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  rescue
    ArgumentError -> Map.get(map, key)
  end
end
