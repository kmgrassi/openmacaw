defmodule SymphonyElixir.Gateway.ConfigSnapshot do
  @moduledoc """
  Read/write adapter for exposing the current WORKFLOW.md config over the websocket gateway.
  """

  alias SymphonyElixir.Workflow

  @spec get() :: {:ok, map()} | {:error, term()}
  def get do
    with {:ok, workflow} <- Workflow.current(),
         {:ok, raw} <- File.read(Workflow.workflow_file_path()) do
      {:ok,
       %{
         exists: true,
         raw: raw,
         hash: content_hash(raw),
         config: workflow.config,
         valid: true,
         issues: [],
         source: Workflow.workflow_file_path()
       }}
    end
  end

  @spec set(String.t(), String.t() | nil) :: {:ok, map()} | {:error, term()}
  def set(raw, base_hash \\ nil) when is_binary(raw) do
    current_raw = File.read!(Workflow.workflow_file_path())

    cond do
      is_binary(base_hash) and base_hash != content_hash(current_raw) ->
        {:error, :config_conflict}

      true ->
        with {:ok, workflow} <- Workflow.current(),
             {:ok, config} <- decode_config(raw),
             :ok <- write_workflow(config, workflow.prompt_template) do
          get()
        end
    end
  rescue
    error in [ArgumentError, File.Error] -> {:error, error}
  end

  defp decode_config(raw) do
    case Jason.decode(raw) do
      {:ok, %{} = config} -> {:ok, config}
      {:ok, _other} -> {:error, :config_must_be_json_object}
      {:error, reason} -> {:error, {:invalid_json, reason}}
    end
  end

  defp write_workflow(config, prompt) do
    yaml = yaml_document(config)
    content = ["---", yaml, "---", "", String.trim(prompt)] |> Enum.join("\n")
    File.write(Workflow.workflow_file_path(), content)
    SymphonyElixir.WorkflowStore.force_reload()
  end

  defp yaml_document(map) when is_map(map) do
    map
    |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
    |> Enum.map_join("\n", fn {key, value} -> yaml_line(to_string(key), value, 0) end)
  end

  defp yaml_line(key, value, indent) do
    prefix = String.duplicate("  ", indent)

    case value do
      %{} = nested ->
        nested_lines =
          nested
          |> Enum.sort_by(fn {nested_key, _nested_value} -> to_string(nested_key) end)
          |> Enum.map_join("\n", fn {nested_key, nested_value} ->
            yaml_line(to_string(nested_key), nested_value, indent + 1)
          end)

        "#{prefix}#{key}:\n#{nested_lines}"

      list when is_list(list) ->
        items =
          Enum.map_join(list, "\n", fn item ->
            item_prefix = String.duplicate("  ", indent + 1)

            case item do
              %{} = nested_item ->
                nested_body =
                  nested_item
                  |> Enum.sort_by(fn {nested_key, _nested_value} -> to_string(nested_key) end)
                  |> Enum.map_join("\n", fn {nested_key, nested_value} ->
                    yaml_line(to_string(nested_key), nested_value, indent + 2)
                  end)

                "#{item_prefix}-\n#{nested_body}"

              _ ->
                "#{item_prefix}- #{scalar(item)}"
            end
          end)

        "#{prefix}#{key}:\n#{items}"

      _ ->
        "#{prefix}#{key}: #{scalar(value)}"
    end
  end

  defp scalar(nil), do: "null"
  defp scalar(true), do: "true"
  defp scalar(false), do: "false"
  defp scalar(value) when is_integer(value) or is_float(value), do: to_string(value)
  defp scalar(value) when is_binary(value), do: Jason.encode!(value)
  defp scalar(value), do: Jason.encode!(value)

  defp content_hash(content), do: :crypto.hash(:sha256, content) |> Base.encode16(case: :lower)
end
