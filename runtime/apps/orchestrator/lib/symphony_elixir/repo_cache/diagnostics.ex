defmodule SymphonyElixir.RepoCache.Diagnostics do
  @moduledoc """
  Observable snapshot of warm repository caches and isolated workspaces.
  """

  alias SymphonyElixir.RepoCache.Registry
  alias SymphonyElixir.WorkerBridge.RepositoryManager

  @spec snapshot(GenServer.server()) :: map()
  def snapshot(registry \\ Registry) do
    %{
      repositories: repositories(registry),
      active_workspaces: RepositoryManager.active_workspaces()
    }
  end

  defp repositories(registry) do
    if registry_available?(registry) do
      registry
      |> Registry.list_repositories()
      |> Enum.map(&repository_payload/1)
    else
      []
    end
  catch
    :exit, _reason -> []
  end

  defp registry_available?(registry) when is_atom(registry), do: not is_nil(Process.whereis(registry))
  defp registry_available?(registry) when is_pid(registry), do: Process.alive?(registry)
  defp registry_available?(_registry), do: true

  defp repository_payload(repository) do
    %{
      repo_id: repository.repo_id,
      repo_url: RepositoryManager.sanitize_url(repository.repo_url),
      cache_path: repository.cache_path,
      cache_kind: repository.cache_kind,
      last_fetched_at: repository.last_fetched_at,
      last_used_at: repository.last_used_at,
      cache_size_bytes: repository.cache_size_bytes,
      active_session_count: repository.active_session_count,
      refresh_state: repository.refresh_state,
      inserted_at: repository.inserted_at,
      updated_at: repository.updated_at,
      metadata: sanitize_map(repository.metadata)
    }
  end

  defp sanitize_map(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {key, sanitize_value(key, value)} end)
  end

  defp sanitize_map(value), do: value

  defp sanitize_value(key, value) when is_binary(key) and is_binary(value) do
    if key in ["repo_url", "url", "locator"] or String.ends_with?(key, "_url") do
      RepositoryManager.sanitize_url(value)
    else
      value
    end
  end

  defp sanitize_value(_key, value) when is_map(value), do: sanitize_map(value)
  defp sanitize_value(key, value) when is_list(value), do: Enum.map(value, &sanitize_value(key, &1))
  defp sanitize_value(_key, value), do: value
end
