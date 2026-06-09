defmodule SymphonyElixir.CloudExecution.Aws.CloudWatchClient do
  @moduledoc """
  Minimal CloudWatch metrics client for container execution smoke results.
  """

  alias SymphonyElixir.Aws.SignatureV4

  @service "monitoring"
  @ecs_credentials_host "http://169.254.170.2"

  @callback put_metric_data(String.t(), [map()], keyword()) :: :ok | {:error, term()}

  @spec put_metric_data(String.t(), [map()], keyword()) :: :ok | {:error, term()}
  def put_metric_data(namespace, metrics, opts \\ []) when is_binary(namespace) and is_list(metrics) do
    with {:ok, config} <- config(opts),
         {:ok, body} <- body(namespace, metrics),
         {:ok, headers} <- signed_headers(config, body) do
      case Req.post([url: endpoint(config), body: body, headers: headers] ++ req_options(opts)) do
        {:ok, %{status: status}} when status in 200..299 -> :ok
        {:ok, %{status: status, body: response_body}} -> {:error, {:cloudwatch_put_metric_failed, status, response_body}}
        {:error, reason} -> {:error, {:cloudwatch_put_metric_failed, reason}}
      end
    end
  end

  defp config(opts) do
    with {:ok, region} <- required_opt(opts, :region, env_first(["AWS_REGION", "AWS_DEFAULT_REGION"])),
         {:ok, access_key_id, secret_access_key, session_token} <- resolve_credentials(opts) do
      {:ok,
       %{
         region: region,
         access_key_id: access_key_id,
         secret_access_key: secret_access_key,
         session_token: session_token,
         endpoint: Keyword.get(opts, :endpoint)
       }}
    end
  end

  defp body(namespace, metrics) do
    params =
      [{"Action", "PutMetricData"}, {"Version", "2010-08-01"}, {"Namespace", namespace}] ++
        Enum.flat_map(Enum.with_index(metrics, 1), fn {metric, index} ->
          metric_params(index, metric)
        end)

    {:ok, URI.encode_query(params)}
  end

  defp metric_params(index, metric) do
    dimensions = Map.get(metric, :dimensions, %{})

    [
      {"MetricData.member.#{index}.MetricName", Map.fetch!(metric, :name)},
      {"MetricData.member.#{index}.Value", to_string(Map.fetch!(metric, :value))},
      {"MetricData.member.#{index}.Unit", Map.get(metric, :unit, "Count")},
      {"MetricData.member.#{index}.Timestamp", Map.get(metric, :timestamp, DateTime.utc_now() |> DateTime.to_iso8601())}
    ] ++
      Enum.flat_map(Enum.with_index(dimensions, 1), fn {{name, value}, dimension_index} ->
        [
          {"MetricData.member.#{index}.Dimensions.member.#{dimension_index}.Name", to_string(name)},
          {"MetricData.member.#{index}.Dimensions.member.#{dimension_index}.Value", to_string(value)}
        ]
      end)
  end

  defp signed_headers(config, body) do
    host = host(config)

    headers = %{
      "content-type" => "application/x-www-form-urlencoded; charset=utf-8"
    }

    {:ok, SignatureV4.sign(%{method: :post, uri: "/", host: host, headers: headers, body: body}, config, @service, config.region)}
  end

  defp endpoint(%{endpoint: endpoint}) when is_binary(endpoint) and endpoint != "", do: endpoint
  defp endpoint(config), do: "https://#{host(config)}/"

  defp host(%{endpoint: endpoint}) when is_binary(endpoint) and endpoint != "" do
    endpoint |> URI.parse() |> Map.fetch!(:host)
  end

  defp host(config), do: "#{@service}.#{config.region}.amazonaws.com"

  defp resolve_credentials(opts) do
    access_key_id = Keyword.get(opts, :access_key_id) || System.get_env("AWS_ACCESS_KEY_ID")
    secret_access_key = Keyword.get(opts, :secret_access_key) || System.get_env("AWS_SECRET_ACCESS_KEY")
    session_token = Keyword.get(opts, :session_token) || System.get_env("AWS_SESSION_TOKEN")

    cond do
      present?(access_key_id) and present?(secret_access_key) ->
        {:ok, access_key_id, secret_access_key, presence(session_token)}

      ecs_credentials_url() != nil ->
        fetch_ecs_credentials(opts)

      not present?(access_key_id) ->
        {:error, {:missing_aws_config, :access_key_id}}

      true ->
        {:error, {:missing_aws_config, :secret_access_key}}
    end
  end

  defp ecs_credentials_url do
    case System.get_env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") do
      uri when is_binary(uri) and uri != "" ->
        @ecs_credentials_host <> uri

      _ ->
        case System.get_env("AWS_CONTAINER_CREDENTIALS_FULL_URI") do
          uri when is_binary(uri) and uri != "" -> uri
          _ -> nil
        end
    end
  end

  defp fetch_ecs_credentials(opts) do
    url = ecs_credentials_url()

    case Req.get([url: url] ++ Keyword.get(opts, :ecs_credentials_req_options, [])) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        parse_ecs_credentials(body)

      {:ok, %{status: status, body: body}} ->
        {:error, {:ecs_credentials_failed, status, body}}

      {:error, reason} ->
        {:error, {:ecs_credentials_failed, reason}}
    end
  end

  defp parse_ecs_credentials(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} -> parse_ecs_credentials(decoded)
      {:error, reason} -> {:error, {:ecs_credentials_decode_failed, reason}}
    end
  end

  defp parse_ecs_credentials(body) when is_map(body) do
    access_key_id = Map.get(body, "AccessKeyId")
    secret_access_key = Map.get(body, "SecretAccessKey")
    token = Map.get(body, "Token")

    if present?(access_key_id) and present?(secret_access_key) do
      {:ok, access_key_id, secret_access_key, presence(token)}
    else
      {:error, {:ecs_credentials_invalid, body}}
    end
  end

  defp required_opt(opts, key, default) do
    case Keyword.get(opts, key) || default do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_aws_config, key}}
    end
  end

  defp req_options(opts), do: Keyword.get(opts, :req_options, Application.get_env(:symphony_elixir, :cloudwatch_req_options, []))

  defp env_first(names), do: Enum.find_value(names, &System.get_env/1)

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false

  defp presence(value) when is_binary(value) and value != "", do: value
  defp presence(_value), do: nil
end
