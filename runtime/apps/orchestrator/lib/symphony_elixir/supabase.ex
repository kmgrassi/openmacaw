defmodule SymphonyElixir.Supabase do
  @moduledoc """
  Connection helpers for Supabase PostgREST.

  Resolves the REST base URL and service-role key from caller-supplied overrides
  or the standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` environment
  variables.

  `SUPABASE_URL` is expected to be the bare project URL (e.g.
  `https://xyz.supabase.co`) per Supabase convention; this module appends
  `/rest/v1` so callers don't have to remember to do it themselves. If an
  override already ends in `/rest/v1` (trailing slash tolerated) the suffix is
  not re-appended.

  Every Supabase REST adapter in this repo should build request URLs off of
  `rest_endpoint!/1` rather than reading `SUPABASE_URL` directly, so this kind
  of path bug can't recur.
  """

  @rest_path "/rest/v1"
  @env_url "SUPABASE_URL"
  @env_key "SUPABASE_SERVICE_ROLE_KEY"

  @type opts :: keyword() | map() | nil

  @doc """
  Returns the PostgREST base URL. Resolution order:

    1. `:endpoint` in `opts`
    2. `SUPABASE_URL` environment variable

  The result has trailing slashes trimmed and `/rest/v1` appended when missing.
  Returns `{:error, :missing}` when neither source supplies a value.
  """
  @spec rest_endpoint(opts()) :: {:ok, String.t()} | {:error, :missing}
  def rest_endpoint(opts \\ nil) do
    case fetch(opts, :endpoint) || env(@env_url) do
      value when is_binary(value) and value != "" -> {:ok, normalize(value)}
      _ -> {:error, :missing}
    end
  end

  @doc """
  Same as `rest_endpoint/1` but raises `ArgumentError` when neither an override
  nor `SUPABASE_URL` supplies a value.
  """
  @spec rest_endpoint!(opts()) :: String.t()
  def rest_endpoint!(opts \\ nil) do
    case rest_endpoint(opts) do
      {:ok, url} ->
        url

      {:error, :missing} ->
        raise ArgumentError,
              "Supabase PostgREST endpoint is not configured. " <>
                "Set #{@env_url} or pass :endpoint."
    end
  end

  @doc """
  Returns the Supabase service-role key. Resolution order:

    1. `:api_key` in `opts`
    2. `SUPABASE_SERVICE_ROLE_KEY` environment variable

  Returns `{:error, :missing}` when no key is configured.
  """
  @spec service_role_key(opts()) :: {:ok, String.t()} | {:error, :missing}
  def service_role_key(opts \\ nil) do
    case fetch(opts, :api_key) || env(@env_key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :missing}
    end
  end

  @doc """
  Same as `service_role_key/1` but raises `ArgumentError` when no key is
  configured.
  """
  @spec service_role_key!(opts()) :: String.t()
  def service_role_key!(opts \\ nil) do
    case service_role_key(opts) do
      {:ok, key} ->
        key

      {:error, :missing} ->
        raise ArgumentError,
              "Supabase service role key is not configured. " <>
                "Set #{@env_key} or pass :api_key."
    end
  end

  @doc """
  Returns `opts` as a map with `:endpoint` and `:api_key` populated from the
  helper, raising if either is missing.

  Convenience for callers that want to merge connection info into a larger
  config map in one step.
  """
  @spec merge_connection!(opts()) :: map()
  def merge_connection!(opts \\ nil) do
    opts
    |> to_map()
    |> Map.put(:endpoint, rest_endpoint!(opts))
    |> Map.put(:api_key, service_role_key!(opts))
  end

  # --- internals ---

  defp fetch(nil, _), do: nil
  defp fetch(opts, key) when is_list(opts), do: Keyword.get(opts, key)
  defp fetch(opts, key) when is_map(opts), do: Map.get(opts, key)

  defp env(name) do
    case System.get_env(name) do
      nil -> nil
      "" -> nil
      value -> value
    end
  end

  defp normalize(url) do
    trimmed = String.trim_trailing(url, "/")

    if String.ends_with?(trimmed, @rest_path) do
      trimmed
    else
      trimmed <> @rest_path
    end
  end

  defp to_map(nil), do: %{}
  defp to_map(opts) when is_list(opts), do: Map.new(opts)
  defp to_map(opts) when is_map(opts), do: opts
end
