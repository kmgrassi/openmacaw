defmodule SymphonyElixir.CloudExecution.Aws.EcsClient do
  @moduledoc """
  Small AWS ECS JSON API client used by the task scheduler.
  """

  alias SymphonyElixir.Aws.SignatureV4

  @service "ecs"
  @target_prefix "AmazonEC2ContainerServiceV20141113"

  @type config :: SymphonyElixir.CloudExecution.Aws.Config.t()

  @callback run_task(config(), map()) :: {:ok, map()} | {:error, term()}
  @callback describe_tasks(config(), [String.t()]) :: {:ok, map()} | {:error, term()}
  @callback stop_task(config(), String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  @callback list_tasks(config(), keyword()) :: {:ok, map()} | {:error, term()}

  @spec run_task(config(), map()) :: {:ok, map()} | {:error, term()}
  def run_task(config, payload), do: call(config, "RunTask", payload)

  @spec describe_tasks(config(), [String.t()]) :: {:ok, map()} | {:error, term()}
  def describe_tasks(config, task_arns) do
    call(config, "DescribeTasks", %{
      "cluster" => config.cluster,
      "tasks" => task_arns,
      "include" => ["TAGS"]
    })
  end

  @spec stop_task(config(), String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def stop_task(config, task_arn, reason) do
    call(config, "StopTask", %{
      "cluster" => config.cluster,
      "task" => task_arn,
      "reason" => reason
    })
  end

  @spec list_tasks(config(), keyword()) :: {:ok, map()} | {:error, term()}
  def list_tasks(config, opts \\ []) do
    payload =
      %{
        "cluster" => config.cluster,
        "desiredStatus" => Keyword.get(opts, :desired_status, "RUNNING")
      }
      |> maybe_put("nextToken", Keyword.get(opts, :next_token))

    call(config, "ListTasks", payload)
  end

  defp call(config, action, payload) do
    with {:ok, credentials} <- credentials() do
      body = Jason.encode!(payload)
      host = "ecs.#{config.region}.amazonaws.com"
      target = "#{@target_prefix}.#{action}"

      headers =
        %{
          "content-type" => "application/x-amz-json-1.1",
          "x-amz-target" => target
        }
        |> signed_headers(host, body, credentials, config.region)

      case Req.post("https://#{host}/", body: body, headers: headers) do
        {:ok, %{status: status, body: response_body}} when status in 200..299 ->
          decode_response(response_body)

        {:ok, %{status: status, body: response_body}} ->
          {:error, {:aws_ecs_error, status, decode_body(response_body)}}

        {:error, reason} ->
          {:error, {:aws_ecs_request_failed, reason}}
      end
    end
  end

  defp signed_headers(headers, host, body, credentials, region) do
    SignatureV4.sign(
      %{method: :post, uri: "/", host: host, headers: headers, body: body},
      credentials,
      @service,
      region
    )
  end

  defp credentials do
    access_key_id = System.get_env("AWS_ACCESS_KEY_ID")
    secret_access_key = System.get_env("AWS_SECRET_ACCESS_KEY")

    cond do
      present?(access_key_id) and present?(secret_access_key) ->
        {:ok,
         %{
           access_key_id: access_key_id,
           secret_access_key: secret_access_key,
           session_token: System.get_env("AWS_SESSION_TOKEN")
         }}

      true ->
        {:error, {:aws_credentials_missing, ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]}}
    end
  end

  defp decode_response(body) when is_map(body), do: {:ok, body}

  defp decode_response(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} -> {:ok, decoded}
      {:error, reason} -> {:error, {:aws_ecs_decode_failed, reason}}
    end
  end

  defp decode_body(body) when is_map(body), do: body

  defp decode_body(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> body
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false
end
