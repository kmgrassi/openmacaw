defmodule SymphonyElixir.Tools.RepositoryContext do
  @moduledoc false

  alias SymphonyElixir.PathSafety

  @spec repository_arguments(map(), Path.t()) :: {:ok, map(), keyword()} | {:error, term()}
  def repository_arguments(arguments, workspace_root) when is_map(arguments) and is_binary(workspace_root) do
    with {:ok, repo_context} <- repository_context(workspace_root) do
      repo_args =
        arguments
        |> reject_nil_values()
        |> Map.put("workspace_id", repo_context.workspace_id)

      {:ok, repo_args, [workspace_root: repo_context.workspace_root]}
    end
  end

  def repository_arguments(_arguments, _workspace_root), do: {:error, :invalid_local_model_coding_context}

  @spec repository_opts(keyword(), map()) :: keyword()
  def repository_opts(opts, context) when is_list(opts) and is_map(context) do
    metadata = Map.get(context, :metadata) || Map.get(context, "metadata") || %{}

    opts
    |> maybe_put_opt(:rg_path, context_value(metadata, "rg_path") || context_value(context, "rg_path"))
    |> maybe_put_opt(
      :search_timeout_ms,
      context_value(metadata, "search_timeout_ms") || context_value(context, "search_timeout_ms")
    )
  end

  @spec normalize_repository_result(String.t(), term()) :: term()
  def normalize_repository_result(tool_name, result) when is_map(result) do
    result
    |> Map.put("tool", tool_name)
    |> Map.put("output", repository_output(tool_name, result))
  end

  def normalize_repository_result(_tool_name, result), do: result

  defp repository_context(workspace_root) do
    with {:ok, canonical_workspace_root} <- PathSafety.canonicalize(workspace_root) do
      workspace_id = Path.basename(canonical_workspace_root)
      workspace_parent = Path.dirname(canonical_workspace_root)

      if workspace_id in ["", ".", ".."] do
        {:error, :invalid_local_model_coding_context}
      else
        {:ok, %{workspace_root: workspace_parent, workspace_id: workspace_id}}
      end
    end
  end

  defp repository_output("repo.read_file", result), do: Map.get(result, "content") || ""
  defp repository_output(_tool_name, result), do: Jason.encode!(Map.delete(result, "workspace_id"))

  defp maybe_put_opt(opts, _key, nil), do: opts
  defp maybe_put_opt(opts, key, value), do: Keyword.put(opts, key, value)

  defp reject_nil_values(map) when is_map(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp context_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, atom_key(key))
  defp context_value(_map, _key), do: nil

  defp atom_key("rg_path"), do: :rg_path
  defp atom_key("search_timeout_ms"), do: :search_timeout_ms
  defp atom_key(_key), do: nil
end
