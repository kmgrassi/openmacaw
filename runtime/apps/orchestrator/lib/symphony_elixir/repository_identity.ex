defmodule SymphonyElixir.RepositoryIdentity do
  @moduledoc """
  Canonical repository identity helpers for runtime cache affinity.

  Repository cache locality needs a stable identifier that can be derived from
  either a repository resource map or a work item's repository metadata. Git
  locators use the same normalization/hash contract as the worker bridge
  repository manager so warm-cache inventory and dispatch decisions compare the
  same value.
  """

  alias SymphonyElixir.Orchestrator.RepositoryRouting
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkerBridge.RepositoryManager

  @url_keys ["url", :url, "repository_url", :repository_url, "clone_url", :clone_url]
  @id_keys ["repo_id", :repo_id, "repository_id", :repository_id, "id", :id]

  @type source :: WorkItem.t() | map() | String.t()

  @spec repo_id(source()) :: {:ok, String.t()} | {:error, term()}
  def repo_id(%WorkItem{} = work_item) do
    work_item
    |> work_item_repository_values()
    |> first_repo_id()
  end

  def repo_id(%{} = repository) do
    case first_present(repository, @url_keys) do
      nil ->
        repository
        |> first_present(@id_keys)
        |> repo_id_from_value()

      url ->
        repo_id_from_git_locator(url)
    end
  end

  def repo_id(value) when is_binary(value), do: repo_id_from_value(value)

  def repo_id(_value), do: {:error, :invalid_repository}

  @spec repo_id!(source()) :: String.t()
  def repo_id!(source) do
    case repo_id(source) do
      {:ok, repo_id} -> repo_id
      {:error, reason} -> raise ArgumentError, "invalid repository identity: #{inspect(reason)}"
    end
  end

  defp work_item_repository_values(%WorkItem{} = work_item) do
    [
      work_item.repository,
      get_in(work_item.metadata, ["repository_url"]),
      get_in(work_item.metadata, [:repository_url]),
      get_in(work_item.metadata, ["url"]),
      get_in(work_item.metadata, [:url])
    ] ++ RepositoryRouting.work_item_repositories(work_item)
  end

  defp first_repo_id(values) do
    values
    |> Enum.reduce_while({:error, :missing_repository}, fn value, {:error, _reason} ->
      case repo_id_from_value(value) do
        {:ok, repo_id} -> {:halt, {:ok, repo_id}}
        {:error, _reason} = error -> {:cont, error}
      end
    end)
  end

  defp repo_id_from_value(value) when is_binary(value) do
    case normalize_string(value) do
      nil ->
        {:error, :missing_repository}

      normalized ->
        if git_locator?(normalized) do
          repo_id_from_git_locator(normalized)
        else
          {:ok, normalized}
        end
    end
  end

  defp repo_id_from_value(_value), do: {:error, :missing_repository}

  defp repo_id_from_git_locator(locator) when is_binary(locator) do
    case normalize_string(locator) do
      nil -> {:error, :missing_repository}
      normalized -> {:ok, RepositoryManager.repo_id(%{"url" => normalized})}
    end
  rescue
    _error -> {:error, :invalid_repository}
  end

  defp first_present(repository, keys) do
    Enum.find_value(keys, fn key ->
      repository
      |> Map.get(key)
      |> normalize_string()
    end)
  end

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil

  defp git_locator?(value) when is_binary(value) do
    String.contains?(value, "://") or
      String.starts_with?(value, "git@") or
      String.starts_with?(value, "/") or
      String.starts_with?(value, ".")
  end
end
