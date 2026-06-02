defmodule SymphonyElixir.LocalRuntime.Capabilities do
  @moduledoc """
  Normalizes local helper runner/model capability payloads.

  Helpers can refresh the same shape from either registration or probe frames.
  The normalized entries are intentionally JSON-serializable so they can be
  reported to platform state without leaking local endpoint credentials.
  """

  @default_capabilities %{
    "streaming" => false,
    "tool_calls" => false,
    "structured_output" => "unsupported",
    "json_mode" => false,
    "context_window" => nil,
    "runtime_managed_tools" => false
  }

  @sensitive_key_fragments ~w(
    api_key
    authorization
    bearer
    credential
    password
    secret
    token
  )

  @type entry :: map()

  @spec normalize_frame(map(), keyword()) :: {:ok, [entry()]} | {:error, term()}
  def normalize_frame(frame, opts \\ [])

  def normalize_frame(frame, opts) when is_map(frame) do
    observed_at = Keyword.get_lazy(opts, :observed_at, fn -> DateTime.utc_now() end)

    with {:ok, workspace_id} <- required_string(frame, ["workspace_id", :workspace_id]),
         {:ok, machine_id} <- required_string(frame, ["machine_id", :machine_id, "device_id", :device_id]),
         {:ok, entries} <- capability_entries(frame) do
      normalized =
        entries
        |> Enum.map(&normalize_entry(&1, frame, workspace_id, machine_id, observed_at))
        |> Enum.reject(&is_nil/1)

      if normalized == [] do
        {:error, :no_capabilities}
      else
        {:ok, normalized}
      end
    end
  end

  def normalize_frame(_frame, _opts), do: {:error, :invalid_frame}

  @spec normalize_capabilities(map() | nil) :: map()
  def normalize_capabilities(capabilities) when is_map(capabilities) do
    capabilities
    |> stringify_keys()
    |> Map.take(Map.keys(@default_capabilities))
    |> then(&Map.merge(@default_capabilities, &1))
    |> normalize_capability_values()
  end

  def normalize_capabilities(_capabilities), do: @default_capabilities

  @spec redacted_metadata(map() | nil) :: map()
  def redacted_metadata(metadata) when is_map(metadata) do
    metadata
    |> stringify_keys()
    |> redact()
  end

  def redacted_metadata(_metadata), do: %{}

  defp capability_entries(frame) do
    cond do
      is_list(Map.get(frame, "models")) ->
        {:ok, Map.get(frame, "models")}

      is_list(Map.get(frame, :models)) ->
        {:ok, Map.get(frame, :models)}

      is_list(Map.get(frame, "runners")) ->
        {:ok, expand_runners(Map.get(frame, "runners"))}

      is_list(Map.get(frame, :runners)) ->
        {:ok, expand_runners(Map.get(frame, :runners))}

      true ->
        {:ok, [frame]}
    end
  end

  defp expand_runners(runners) do
    Enum.flat_map(runners, fn
      %{} = runner ->
        models = Map.get(runner, "models") || Map.get(runner, :models) || [runner]

        runner_capabilities = Map.get(runner, "capabilities") || Map.get(runner, :capabilities) || %{}

        Enum.flat_map(models, fn
          %{} = model ->
            model_capabilities = Map.get(model, "capabilities") || Map.get(model, :capabilities) || %{}

            [
              model
              |> stringify_keys()
              |> Map.put_new("runner_kind", string_value(runner, ["runner_kind", :runner_kind]))
              |> Map.put_new("provider", string_value(runner, ["provider", :provider]))
              |> Map.put("capabilities", Map.merge(stringify_keys(runner_capabilities), stringify_keys(model_capabilities)))
            ]

          _other ->
            []
        end)

      _other ->
        []
    end)
  end

  defp normalize_entry(entry, frame, workspace_id, machine_id, observed_at) when is_map(entry) do
    entry = stringify_keys(entry)
    frame = stringify_keys(frame)

    with runner_kind when is_binary(runner_kind) <- first_present([entry, frame], "runner_kind"),
         model when is_binary(model) <- first_present([entry, frame], "model") do
      provider = first_present([entry, frame], "provider")
      capabilities = normalize_capabilities(Map.get(entry, "capabilities") || Map.get(frame, "capabilities"))
      metadata = Map.merge(redacted_metadata(Map.get(frame, "metadata")), redacted_metadata(Map.get(entry, "metadata")))

      %{
        "workspace_id" => workspace_id,
        "machine_id" => machine_id,
        "runner_kind" => runner_kind,
        "provider" => provider,
        "model" => model,
        "capabilities" => capabilities,
        "metadata" => metadata,
        "observed_at" => DateTime.to_iso8601(observed_at),
        "snapshot_id" => snapshot_id(workspace_id, machine_id, runner_kind, provider, model, observed_at)
      }
    else
      _missing -> nil
    end
  end

  defp normalize_entry(_entry, _frame, _workspace_id, _machine_id, _observed_at), do: nil

  defp required_string(frame, keys) do
    case string_value(frame, keys) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _missing -> {:error, {:missing_required_field, hd(keys)}}
    end
  end

  defp string_value(map, keys) do
    Enum.find_value(keys, fn key ->
      case Map.get(map, key) do
        value when is_binary(value) ->
          value = String.trim(value)
          if value == "", do: nil, else: value

        _other ->
          nil
      end
    end)
  end

  defp first_present(maps, key) do
    Enum.find_value(maps, fn map ->
      case Map.get(map, key) do
        value when is_binary(value) ->
          value = String.trim(value)
          if value == "", do: nil, else: value

        _other ->
          nil
      end
    end)
  end

  defp normalize_capability_values(capabilities) do
    capabilities
    |> normalize_boolean("streaming")
    |> normalize_boolean("tool_calls")
    |> normalize_boolean("json_mode")
    |> normalize_boolean("runtime_managed_tools")
    |> normalize_context_window()
    |> normalize_structured_output()
  end

  defp normalize_boolean(capabilities, key) do
    case Map.get(capabilities, key) do
      value when is_boolean(value) -> Map.put(capabilities, key, value)
      "true" -> Map.put(capabilities, key, true)
      "false" -> Map.put(capabilities, key, false)
      _other -> Map.put(capabilities, key, Map.get(@default_capabilities, key))
    end
  end

  defp normalize_context_window(%{"context_window" => value} = capabilities) when is_integer(value) and value > 0, do: capabilities

  defp normalize_context_window(%{"context_window" => value} = capabilities) when is_binary(value) do
    case Integer.parse(value) do
      {integer, ""} when integer > 0 -> Map.put(capabilities, "context_window", integer)
      _other -> Map.put(capabilities, "context_window", nil)
    end
  end

  defp normalize_context_window(capabilities), do: Map.put(capabilities, "context_window", nil)

  defp normalize_structured_output(%{"structured_output" => value} = capabilities) when value in ["unsupported", "best_effort", "strict"], do: capabilities
  defp normalize_structured_output(capabilities), do: Map.put(capabilities, "structured_output", "unsupported")

  defp snapshot_id(workspace_id, machine_id, runner_kind, provider, model, observed_at) do
    payload = Enum.join([workspace_id, machine_id, runner_kind, provider || "", model, DateTime.to_iso8601(observed_at)], ":")
    "lrcap_" <> Base.url_encode64(:crypto.hash(:sha256, payload), padding: false)
  end

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), stringify_keys(value)} end)
  end

  defp stringify_keys(values) when is_list(values), do: Enum.map(values, &stringify_keys/1)
  defp stringify_keys(value), do: value

  defp redact(%{} = map) do
    Map.new(map, fn {key, value} ->
      if sensitive_key?(key), do: {key, "[REDACTED]"}, else: {key, redact(value)}
    end)
  end

  defp redact(values) when is_list(values), do: Enum.map(values, &redact/1)
  defp redact(value) when is_binary(value), do: redact_value(value)
  defp redact(value), do: value

  defp sensitive_key?(key) do
    key = key |> to_string() |> String.downcase()
    Enum.any?(@sensitive_key_fragments, &String.contains?(key, &1))
  end

  defp redact_value(value) do
    cond do
      String.match?(value, ~r/^\s*(bearer|basic)\s+\S+/i) ->
        "[REDACTED]"

      uri_with_authority?(value) ->
        value
        |> URI.parse()
        |> scrub_uri()
        |> URI.to_string()

      true ->
        value
    end
  end

  defp uri_with_authority?(value) do
    uri = URI.parse(value)
    is_binary(uri.scheme) and is_binary(uri.host)
  rescue
    URI.Error -> false
  end

  defp scrub_uri(%URI{} = uri) do
    %{uri | userinfo: nil, query: scrub_query(uri.query)}
  end

  defp scrub_query(nil), do: nil

  defp scrub_query(query) do
    query
    |> URI.decode_query()
    |> Map.new(fn {key, value} ->
      if sensitive_key?(key), do: {key, "[REDACTED]"}, else: {key, value}
    end)
    |> URI.encode_query()
  end
end
