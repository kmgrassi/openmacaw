defmodule SymphonyElixir.Workspace.RepositoryBootstrap do
  @moduledoc false

  require Logger

  alias SymphonyElixir.{Config, SSH}
  alias SymphonyElixir.WorkerBridge.RepositoryManager

  @type worker_host :: String.t() | nil

  @spec maybe_bootstrap(Path.t(), boolean(), worker_host()) :: :ok | {:error, term()}
  def maybe_bootstrap(workspace, created?, worker_host) when is_binary(workspace) do
    settings = Config.settings!()
    repository = settings.workspace.repository

    case {created?, repository} do
      {true, repo} when is_binary(repo) and repo != "" ->
        bootstrap(workspace, repo, worker_host)

      _ ->
        :ok
    end
  end

  defp bootstrap(workspace, repository, nil) do
    timeout_ms = Config.settings!().hooks.timeout_ms

    Logger.info("Bootstrapping repository repository=#{repository} workspace=#{workspace} worker_host=local")

    case run_local_bootstrap(repository, workspace, timeout_ms) do
      {:ok, metadata} ->
        log_local_bootstrap_success(repository, workspace, metadata)

        :ok

      {:error, reason} ->
        Logger.error("Repository bootstrap failed repository=#{repository} workspace=#{workspace} reason=#{inspect(reason)}")
        {:error, {:repository_bootstrap_failed, reason}}
    end
  end

  defp bootstrap(workspace, repository, worker_host) when is_binary(worker_host) do
    timeout_ms = Config.settings!().hooks.timeout_ms

    Logger.info("Bootstrapping repository repository=#{repository} workspace=#{workspace} worker_host=#{worker_host}")

    command = bootstrap_command(repository)
    script = "cd #{shell_escape(workspace)} && #{command}"

    case run_remote_command(worker_host, script, timeout_ms) do
      {:ok, {_output, 0}} ->
        :ok

      {:ok, {output, status}} ->
        {:error, {:repository_bootstrap_failed, status, output}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp bootstrap_command(repository) do
    cond do
      github_url?(repository) ->
        "git clone --depth 1 #{shell_escape(repository)} ."

      true ->
        source = Path.expand(repository)
        "cp -a #{shell_escape(source <> "/.")} ."
    end
  end

  defp github_url?(value) do
    String.starts_with?(value, "https://") or
      String.starts_with?(value, "git@") or
      String.starts_with?(value, "http://") or
      String.starts_with?(value, "ssh://")
  end

  defp materialization_method do
    Application.get_env(:symphony_elixir, :workspace_repository_materialization_method, :clone)
  end

  defp run_local_bootstrap(repository, workspace, timeout_ms) do
    task =
      Task.async(fn ->
        if use_cached_materialization?(repository) do
          RepositoryManager.materialize_workspace(repository, workspace,
            method: materialization_method(),
            repo_cache_root: Config.settings!().workspace.repo_cache_root
          )
        else
          copy_local_repository(repository, workspace)
        end
      end)

    case Task.yield(task, timeout_ms) do
      {:ok, result} ->
        result

      nil ->
        Task.shutdown(task, :brutal_kill)
        {:error, {:workspace_hook_timeout, "repository_bootstrap", timeout_ms}}
    end
  end

  defp copy_local_repository(repository, workspace) do
    source = Path.expand(repository)

    case System.cmd("cp", ["-a", source <> "/.", workspace], stderr_to_stdout: true) do
      {_output, 0} ->
        {:ok, %{materialization_method: "copy_local_directory"}}

      {output, status} ->
        {:error, {:repository_bootstrap_failed, status, output}}
    end
  end

  defp use_cached_materialization?(repository) do
    github_url?(repository) or clean_local_git_repository?(repository)
  end

  defp clean_local_git_repository?(repository) when is_binary(repository) do
    source = Path.expand(repository)

    case System.cmd("git", ["-C", source, "status", "--porcelain", "--untracked-files=all"],
           stderr_to_stdout: true
         ) do
      {"", 0} -> true
      _ -> false
    end
  end

  defp log_local_bootstrap_success(repository, workspace, metadata) do
    if is_map(metadata) and Map.has_key?(metadata, :repo_id) do
      Logger.info(
        "Repository bootstrapped from cache repository=#{repository} workspace=#{workspace} repo_id=#{metadata.repo_id} cache_hit=#{metadata.cache_hit} method=#{metadata.materialization_method} checkout_ms=#{metadata.checkout_ms}"
      )
    else
      Logger.info(
        "Repository bootstrapped locally repository=#{repository} workspace=#{workspace} method=#{Map.get(metadata, :materialization_method, "copy_local_directory")}"
      )
    end
  end

  defp run_remote_command(worker_host, script, timeout_ms)
       when is_binary(worker_host) and is_binary(script) and is_integer(timeout_ms) and timeout_ms > 0 do
    task =
      Task.async(fn ->
        SSH.run(worker_host, script, stderr_to_stdout: true)
      end)

    case Task.yield(task, timeout_ms) do
      {:ok, result} ->
        result

      nil ->
        Task.shutdown(task, :brutal_kill)
        {:error, {:workspace_hook_timeout, "remote_command", timeout_ms}}
    end
  end

  defp shell_escape(value) when is_binary(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end
end
