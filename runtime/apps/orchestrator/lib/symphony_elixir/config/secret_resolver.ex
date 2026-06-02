defmodule SymphonyElixir.Config.SecretResolver do
  @moduledoc false

  @spec expand_env(term(), term()) :: term()
  def expand_env(value, fallback \\ nil)

  def expand_env(value, fallback) when is_binary(value) do
    case env_reference_name(value) do
      {:ok, env_name} ->
        case System.get_env(env_name) do
          nil -> fallback
          "" -> nil
          env_value -> env_value
        end

      :error ->
        value
    end
  end

  def expand_env(_value, fallback), do: fallback

  @spec env_reference_name(String.t()) :: {:ok, String.t()} | :error
  def env_reference_name("$" <> env_name) do
    if String.match?(env_name, ~r/^[A-Za-z_][A-Za-z0-9_]*$/) do
      {:ok, env_name}
    else
      :error
    end
  end

  def env_reference_name(_value), do: :error

  @spec resolve_env_token(String.t()) :: String.t() | :missing
  def resolve_env_token(env_name) do
    case System.get_env(env_name) do
      nil -> :missing
      env_value -> env_value
    end
  end

  @spec resolve_map(map() | term()) :: map() | term()
  def resolve_map(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_binary(value) -> {key, expand_env(value, nil) || value}
      {key, value} -> {key, value}
    end)
  end

  def resolve_map(other), do: other

  @spec resolve_setting(String.t() | nil, String.t() | nil) :: String.t() | nil
  def resolve_setting(nil, fallback), do: normalize_secret_value(fallback)

  def resolve_setting(value, fallback) when is_binary(value) do
    case expand_env(value, fallback) do
      resolved when is_binary(resolved) -> normalize_secret_value(resolved)
      resolved -> resolved
    end
  end

  @spec normalize_secret_value(term()) :: String.t() | nil
  def normalize_secret_value(value) when is_binary(value) do
    if value == "", do: nil, else: value
  end

  def normalize_secret_value(_value), do: nil
end
