defmodule SymphonyElixir.WorkerBridge.RepositoryManager.MirrorLock do
  @moduledoc false

  @lock_poll_ms 50

  @spec with_lock(Path.t(), String.t(), non_neg_integer(), (-> result)) :: result | {:error, term()}
        when result: var
  def with_lock(lock_root, repo_id, timeout_ms, fun)
      when is_binary(lock_root) and is_binary(repo_id) and is_integer(timeout_ms) and timeout_ms >= 0 and
             is_function(fun, 0) do
    File.mkdir_p!(lock_root)
    path = Path.join(lock_root, "#{repo_id}.lock")
    owner = "#{System.os_time(:millisecond)}-#{inspect(self())}"

    with :ok <- acquire_lock(path, owner, System.monotonic_time(:millisecond) + timeout_ms) do
      try do
        fun.()
      after
        File.rm_rf!(path)
      end
    end
  end

  defp acquire_lock(path, owner, deadline_ms) do
    case File.mkdir(path) do
      :ok ->
        File.write!(Path.join(path, "owner"), owner)
        :ok

      {:error, :eexist} ->
        if System.monotonic_time(:millisecond) >= deadline_ms do
          {:error, {:mirror_lock_timeout, path}}
        else
          Process.sleep(@lock_poll_ms)
          acquire_lock(path, owner, deadline_ms)
        end

      {:error, reason} ->
        {:error, {:mirror_lock_failed, path, reason}}
    end
  end
end
