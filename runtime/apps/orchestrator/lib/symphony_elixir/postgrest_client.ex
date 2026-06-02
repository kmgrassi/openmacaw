defmodule SymphonyElixir.PostgRESTClient do
  @moduledoc """
  Small shared client for Supabase/PostgREST adapters.

  The client centralizes connection normalization, auth headers, optional
  `Prefer` handling, request-option injection for tests, and the common error
  shape used by Supabase-backed adapters.
  """

  alias SymphonyElixir.{RuntimeLog, Supabase}

  defstruct [:endpoint, :api_key, req_options: []]

  @type t :: %__MODULE__{
          endpoint: String.t(),
          api_key: String.t(),
          req_options: keyword()
        }

  @type query :: map() | keyword() | String.t() | nil
  @type request_result ::
          {:ok, term()}
          | {:error, {:http_error, integer(), term()}}
          | {:error, {:request_failed, term()}}

  @spec new(Supabase.opts(), keyword()) :: t()
  def new(config, req_options \\ []) do
    config =
      try do
        Supabase.merge_connection!(config)
      rescue
        error in ArgumentError ->
          RuntimeLog.log(:error, :postgrest_request_failed, %{
            error_code: "db_missing_config",
            retryable: false,
            reason: Exception.message(error)
          })

          reraise error, __STACKTRACE__
      end

    %__MODULE__{
      endpoint: config.endpoint,
      api_key: config.api_key,
      req_options: req_options
    }
  end

  @spec get(t(), String.t(), query(), keyword()) :: request_result()
  def get(%__MODULE__{} = client, table, query \\ nil, opts \\ []) when is_binary(table) do
    request(client, :get, table, query, nil, opts)
  end

  @spec post(t(), String.t(), term(), keyword()) :: request_result()
  def post(%__MODULE__{} = client, table, payload, opts \\ []) when is_binary(table) do
    request(client, :post, table, Keyword.get(opts, :query), payload, opts)
  end

  @spec patch(t(), String.t(), query(), term(), keyword()) :: request_result()
  def patch(%__MODULE__{} = client, table, query, payload, opts \\ []) when is_binary(table) do
    request(client, :patch, table, query, payload, opts)
  end

  @spec delete(t(), String.t(), query(), keyword()) :: request_result()
  def delete(%__MODULE__{} = client, table, query, opts \\ []) when is_binary(table) do
    request(client, :delete, table, query, nil, opts)
  end

  @spec upsert(t(), String.t(), term(), String.t() | [String.t()], keyword()) :: request_result()
  def upsert(%__MODULE__{} = client, table, payload, conflict, opts \\ []) when is_binary(table) do
    query = Map.put(query_from_opts(opts), "on_conflict", conflict_value(conflict))
    prefer = Keyword.get(opts, :prefer, "resolution=merge-duplicates,return=representation")

    request(client, :post, table, query, payload, Keyword.put(opts, :prefer, prefer))
  end

  defp request(client, method, table, query, payload, opts) do
    req = base_req(client, opts)
    url = url(client, table, query)
    log_fields = request_log_fields(method, table, query, opts)

    req_opts = [method: method, url: url]
    req_opts = if is_nil(payload), do: req_opts, else: Keyword.put(req_opts, :json, payload)

    started_at = System.monotonic_time()
    RuntimeLog.log(:info, :postgrest_request_started, log_fields)

    case Req.request(req, req_opts) do
      {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
        RuntimeLog.log(
          :info,
          :postgrest_request_completed,
          log_fields
          |> Map.merge(%{
            status_code: status,
            response_row_count: response_row_count(body),
            duration_ms: duration_ms(started_at),
            retryable: false
          })
        )

        {:ok, body}

      {:ok, %Req.Response{status: status, body: body}} ->
        RuntimeLog.log(
          :error,
          :postgrest_request_failed,
          log_fields
          |> Map.merge(%{
            status_code: status,
            error_code: "db_http_error",
            duration_ms: duration_ms(started_at),
            retryable: retryable_status?(status)
          })
        )

        {:error, {:http_error, status, body}}

      {:error, reason} ->
        RuntimeLog.log(
          :error,
          :postgrest_request_failed,
          log_fields
          |> Map.merge(%{
            error_code: request_error_code(reason),
            duration_ms: duration_ms(started_at),
            retryable: retryable_request_error?(reason),
            reason: inspect(reason)
          })
        )

        {:error, {:request_failed, reason}}
    end
  end

  defp base_req(client, opts) do
    [
      headers:
        [
          {"apikey", client.api_key},
          {"authorization", "Bearer #{client.api_key}"},
          {"accept", "application/json"}
        ] ++ prefer_headers(Keyword.get(opts, :prefer))
    ]
    |> Keyword.merge(client.req_options)
    |> Req.new()
  end

  defp prefer_headers(nil), do: []
  defp prefer_headers(value) when is_binary(value), do: [{"prefer", value}]
  defp prefer_headers(values) when is_list(values), do: [{"prefer", Enum.join(values, ",")}]

  defp url(client, table, query) do
    base = "#{client.endpoint}/#{table}"

    case encode_query(query) do
      "" -> base
      encoded -> "#{base}?#{encoded}"
    end
  end

  defp encode_query(nil), do: ""
  defp encode_query(query) when is_binary(query), do: query
  defp encode_query(query) when is_list(query) or is_map(query), do: URI.encode_query(query)

  defp query_from_opts(opts) do
    case Keyword.get(opts, :query, %{}) do
      nil -> %{}
      query when is_binary(query) -> URI.decode_query(query)
      query when is_map(query) -> query
      query when is_list(query) -> Map.new(query)
    end
  end

  defp conflict_value(conflict) when is_binary(conflict), do: conflict
  defp conflict_value(conflict) when is_list(conflict), do: Enum.join(conflict, ",")

  defp request_log_fields(method, table, query, opts) do
    opts
    |> Keyword.get(:log_metadata, %{})
    |> normalize_metadata()
    |> Map.merge(%{
      method: method |> Atom.to_string() |> String.upcase(),
      table: table,
      query_shape: query_shape(query)
    })
    |> with_process_trace_id()
  end

  defp with_process_trace_id(fields) do
    cond do
      not is_nil(Map.get(fields, :trace_id)) -> fields
      not is_nil(Map.get(fields, "trace_id")) -> fields
      trace_id = Process.get(:symphony_trace_id) -> Map.put(fields, :trace_id, trace_id)
      true -> fields
    end
  end

  defp normalize_metadata(metadata) when is_list(metadata), do: Map.new(metadata)
  defp normalize_metadata(metadata) when is_map(metadata), do: metadata
  defp normalize_metadata(_metadata), do: %{}

  defp query_shape(nil), do: []

  defp query_shape(query) when is_binary(query) do
    query
    |> URI.decode_query()
    |> query_shape()
  end

  defp query_shape(query) when is_list(query) or is_map(query) do
    query
    |> Enum.map(fn {key, value} -> query_field_shape(key, value) end)
    |> Enum.sort()
  end

  defp query_field_shape(key, value) when is_binary(value) do
    "#{key}:#{query_operator(value)}"
  end

  defp query_field_shape(key, _value), do: "#{key}"

  defp query_operator(value) do
    case String.split(value, ".", parts: 2) do
      [operator, _operand] when operator != "" -> operator
      _ -> "value"
    end
  end

  defp response_row_count(body) when is_list(body), do: length(body)
  defp response_row_count(_body), do: nil

  defp duration_ms(started_at) do
    System.monotonic_time()
    |> Kernel.-(started_at)
    |> System.convert_time_unit(:native, :millisecond)
  end

  defp retryable_status?(status), do: status in [408, 425, 429] or status >= 500

  defp request_error_code(reason) do
    if timeout_reason?(reason), do: "db_timeout", else: "db_request_failed"
  end

  defp retryable_request_error?(reason), do: timeout_reason?(reason)

  defp timeout_reason?(reason) do
    reason
    |> inspect()
    |> String.downcase()
    |> String.contains?("timeout")
  end
end
