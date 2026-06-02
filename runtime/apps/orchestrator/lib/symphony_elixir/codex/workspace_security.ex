defmodule SymphonyElixir.Codex.WorkspaceSecurity do
  @moduledoc """
  Validates Codex app-server workspace paths before they are used as a cwd.
  """

  alias SymphonyElixir.{Config, PathSafety}

  @spec validate_cwd(Path.t(), String.t() | nil) :: {:ok, Path.t()} | {:error, term()}
  def validate_cwd(workspace, nil) when is_binary(workspace) do
    PathSafety.validate_local_workspace_cwd(workspace, Config.settings!().workspace.root)
  end

  def validate_cwd(workspace, worker_host)
      when is_binary(workspace) and is_binary(worker_host) do
    cond do
      String.trim(workspace) == "" ->
        {:error, {:invalid_workspace_cwd, :empty_remote_workspace, worker_host}}

      String.contains?(workspace, ["\n", "\r", <<0>>]) ->
        {:error, {:invalid_workspace_cwd, :invalid_remote_workspace, worker_host, workspace}}

      true ->
        {:ok, workspace}
    end
  end
end
