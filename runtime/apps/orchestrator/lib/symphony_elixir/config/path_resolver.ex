defmodule SymphonyElixir.Config.PathResolver do
  @moduledoc false

  alias SymphonyElixir.Config.SecretResolver
  alias SymphonyElixir.PathSafety

  @spec resolve_path_value(term(), Path.t()) :: Path.t()
  def resolve_path_value(value, default) when is_binary(value) do
    case normalize_path_token(value) do
      :missing -> default
      "" -> default
      path -> path
    end
  end

  def resolve_path_value(_value, default), do: default

  @spec resolve_storage_value(term(), Path.t()) :: Path.t() | String.t()
  def resolve_storage_value(value, default) when is_binary(value) do
    case SecretResolver.expand_env(value, default) do
      nil ->
        default

      "" ->
        default

      resolved when is_binary(resolved) ->
        if uri?(resolved), do: resolved, else: Path.expand(resolved)
    end
  end

  def resolve_storage_value(value, default), do: resolve_path_value(value, default)

  @spec resolve_path_value_with_fallback(String.t() | nil, term(), Path.t()) :: Path.t()
  def resolve_path_value_with_fallback(primary, fallback, default)
      when is_binary(primary) or is_nil(primary) do
    case normalize_path_token(primary || "") do
      :missing -> resolve_path_value(fallback, default)
      "" -> resolve_path_value(fallback, default)
      path -> path
    end
  end

  @spec normalize_path_token(String.t()) :: String.t() | :missing
  def normalize_path_token(value) when is_binary(value) do
    case SecretResolver.env_reference_name(value) do
      {:ok, env_name} -> SecretResolver.resolve_env_token(env_name)
      :error -> value
    end
  end

  @spec expand_local_workspace_root(term(), Path.t()) :: Path.t()
  def expand_local_workspace_root(workspace_root, _default)
      when is_binary(workspace_root) and workspace_root != "" do
    Path.expand(workspace_root)
  end

  def expand_local_workspace_root(_workspace_root, default), do: Path.expand(default)

  @spec canonicalize_local_workspace_root(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  def canonicalize_local_workspace_root(workspace_root) when is_binary(workspace_root) do
    workspace_root
    |> Path.expand()
    |> PathSafety.canonicalize()
  end

  defp uri?(value) when is_binary(value) do
    String.match?(value, ~r/^[A-Za-z][A-Za-z0-9+.-]*:\/\//)
  end
end
