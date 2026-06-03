defmodule SymphonyElixir.WorkerBridge.RepositoryManager.Metadata do
  @moduledoc false

  @metadata_filename ".symphony-cache.json"
  @workspace_metadata_filename ".symphony-workspace.json"

  @spec write_cache_metadata(Path.t(), map()) :: :ok | {:error, term()}
  def write_cache_metadata(cache_path, metadata) when is_map(metadata) do
    write_json(cache_metadata_path(cache_path), metadata, :metadata_encode_failed)
  end

  @spec previous_cache_metadata(Path.t()) :: map()
  def previous_cache_metadata(cache_path) do
    read_json(cache_metadata_path(cache_path))
  end

  @spec write_workspace_metadata(Path.t(), map()) :: :ok | {:error, term()}
  def write_workspace_metadata(workspace_path, metadata) when is_map(metadata) do
    write_json(
      workspace_metadata_path(workspace_path),
      metadata,
      :workspace_metadata_encode_failed
    )
  end

  @spec workspace_metadata(Path.t()) :: map()
  def workspace_metadata(workspace_path) do
    read_json(workspace_metadata_path(workspace_path))
  end

  @spec workspace_snapshot(Path.t()) :: [map()]
  def workspace_snapshot(workspace_path) do
    case workspace_metadata(workspace_path) do
      metadata when map_size(metadata) > 0 ->
        [
          metadata
          |> sanitize_workspace_metadata()
          |> Map.put("workspace_path", workspace_path)
          |> Map.put("exists", File.dir?(workspace_path))
        ]

      _metadata ->
        []
    end
  end

  @doc """
  Removes any embedded basic-auth credentials from a URL so the resulting
  string is safe to expose in logs, status maps, or child-process env vars.

  Falls back to a regex-based stripper for inputs that `URI.parse/1` cannot
  faithfully round-trip (e.g. bare `git@` SSH URLs or non-URL strings).
  """
  @spec sanitize_url(any()) :: any()
  def sanitize_url(url) when is_binary(url) do
    case URI.new(url) do
      {:ok, %URI{userinfo: nil} = uri} ->
        URI.to_string(uri)

      {:ok, %URI{} = uri} ->
        uri
        |> Map.put(:userinfo, nil)
        |> URI.to_string()

      {:error, _reason} ->
        safe_locator(url)
    end
  end

  def sanitize_url(other), do: other

  @spec safe_error(term(), String.t() | nil) :: String.t()
  def safe_error(reason, resource_url) do
    reason
    |> inspect(limit: 20)
    |> redact_value(resource_url, sanitize_url(resource_url))
  end

  @spec safe_locator(any()) :: any()
  def safe_locator(locator) when is_binary(locator) do
    String.replace(locator, ~r/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\/?#]+@/, "\\1")
  end

  def safe_locator(locator), do: locator

  defp cache_metadata_path(cache_path) do
    Path.join(cache_path, @metadata_filename)
  end

  defp workspace_metadata_path(workspace_path) do
    Path.join(workspace_path, @workspace_metadata_filename)
  end

  defp sanitize_workspace_metadata(metadata) when is_map(metadata) do
    Map.new(metadata, fn
      {"repo_url", value} ->
        {"repo_url", sanitize_url(value)}

      {"metadata", value} when is_map(value) ->
        {"metadata", sanitize_workspace_metadata(value)}

      {key, value} when is_binary(key) and is_binary(value) ->
        if key in ["url", "locator"] or String.ends_with?(key, "_url") do
          {key, sanitize_url(value)}
        else
          {key, value}
        end

      {key, value} when is_list(value) ->
        {key, Enum.map(value, &sanitize_workspace_metadata_value(key, &1))}

      entry ->
        entry
    end)
  end

  defp sanitize_workspace_metadata(value), do: value

  defp sanitize_workspace_metadata_value(_key, value) when is_map(value),
    do: sanitize_workspace_metadata(value)

  defp sanitize_workspace_metadata_value(key, value) when is_binary(value) do
    if key in ["url", "locator"] or String.ends_with?(key, "_url") do
      sanitize_url(value)
    else
      value
    end
  end

  defp sanitize_workspace_metadata_value(_key, value), do: value

  defp write_json(path, metadata, error_tag) do
    case Jason.encode(metadata, pretty: true) do
      {:ok, encoded} ->
        File.write!(path, encoded <> "\n")
        :ok

      {:error, reason} ->
        {:error, {error_tag, reason}}
    end
  end

  defp read_json(path) do
    with true <- File.exists?(path),
         {:ok, content} <- File.read(path),
         {:ok, metadata} when is_map(metadata) <- Jason.decode(content) do
      metadata
    else
      _ -> %{}
    end
  end

  defp redact_value(message, value, replacement)
       when is_binary(message) and is_binary(value) and value != "" and is_binary(replacement) do
    String.replace(message, value, replacement)
  end

  defp redact_value(message, _value, _replacement), do: message
end
