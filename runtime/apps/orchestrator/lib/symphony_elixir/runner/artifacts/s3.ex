defmodule SymphonyElixir.Runner.Artifacts.S3 do
  @moduledoc """
  Minimal S3 PutObject client for runtime artifacts.

  The implementation intentionally keeps the public contract small so execution
  adapters can inject a mock uploader in tests while production uses AWS
  Signature Version 4 and the task role credentials exposed to the container.
  """

  @behaviour SymphonyElixir.Runner.Artifacts.Uploader

  @type put_options :: [
          content_type: String.t(),
          region: String.t(),
          endpoint: String.t(),
          credentials: map()
        ]

  @ecs_credentials_host "http://169.254.170.2"

  @impl true
  def put_object(bucket, key, body, opts \\ []) when is_binary(bucket) and is_binary(key) do
    with {:ok, config} <- config(opts),
         {:ok, headers} <- signed_headers(config, bucket, key, body, opts) do
      req_options =
        [url: url(config, bucket, key), body: body, headers: headers]
        |> Keyword.merge(s3_req_options(opts))

      case Req.put(req_options) do
        {:ok, %Req.Response{status: status, headers: response_headers}} when status in 200..299 ->
          {:ok, %{"etag" => response_header(response_headers, "etag")}}

        {:ok, %Req.Response{status: status, body: body}} ->
          {:error, {:s3_put_failed, status, body}}

        {:error, reason} ->
          {:error, {:s3_put_failed, reason}}
      end
    end
  end

  defp s3_req_options(opts) do
    Keyword.get(
      opts,
      :req_options,
      Application.get_env(:symphony_elixir, :s3_req_options, [])
    )
  end

  defp config(opts) do
    credentials = Keyword.get(opts, :credentials, %{})

    with {:ok, region} <- required_opt(opts, :region, env_first(["AWS_REGION", "AWS_DEFAULT_REGION"])),
         {:ok, access_key_id, secret_access_key, session_token} <-
           resolve_credentials(opts, credentials) do
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

  defp resolve_credentials(opts, credentials) do
    access_key_id =
      Keyword.get(opts, :access_key_id) ||
        Map.get(credentials, "access_key_id") ||
        System.get_env("AWS_ACCESS_KEY_ID")

    secret_access_key =
      Keyword.get(opts, :secret_access_key) ||
        Map.get(credentials, "secret_access_key") ||
        System.get_env("AWS_SECRET_ACCESS_KEY")

    session_token =
      Keyword.get(opts, :session_token) ||
        Map.get(credentials, "session_token") ||
        System.get_env("AWS_SESSION_TOKEN")

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
    req_options = Keyword.get(opts, :ecs_credentials_req_options, ecs_req_options())

    case Req.get([url: url] |> Keyword.merge(req_options)) do
      {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
        parse_ecs_credentials(body)

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:ecs_credentials_failed, status, body}}

      {:error, reason} ->
        {:error, {:ecs_credentials_failed, reason}}
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

  defp parse_ecs_credentials(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} -> parse_ecs_credentials(decoded)
      {:error, reason} -> {:error, {:ecs_credentials_invalid, reason}}
    end
  end

  defp parse_ecs_credentials(other), do: {:error, {:ecs_credentials_invalid, other}}

  defp ecs_req_options do
    Application.get_env(:symphony_elixir, :s3_ecs_credentials_req_options, [])
  end

  defp required_opt(opts, key, fallback) do
    value = Keyword.get(opts, key) || fallback

    if present?(value) do
      {:ok, value}
    else
      {:error, {:missing_aws_config, key}}
    end
  end

  defp present?(value), do: is_binary(value) and String.trim(value) != ""

  defp presence(value) do
    if present?(value), do: value, else: nil
  end

  defp env_first(names), do: Enum.find_value(names, &System.get_env/1)

  defp signed_headers(config, bucket, key, body, opts) do
    now = DateTime.utc_now()
    amz_date = Calendar.strftime(now, "%Y%m%dT%H%M%SZ")
    date = Calendar.strftime(now, "%Y%m%d")
    payload_hash = sha256_hex(body)
    host = host(config, bucket)

    headers =
      [
        {"content-type", Keyword.get(opts, :content_type, "application/octet-stream")},
        {"host", host},
        {"x-amz-content-sha256", payload_hash},
        {"x-amz-date", amz_date}
      ]
      |> maybe_put_session_token(config.session_token)

    canonical_request =
      [
        "PUT",
        canonical_uri(config, bucket, key),
        "",
        canonical_headers(headers),
        signed_header_names(headers),
        payload_hash
      ]
      |> Enum.join("\n")

    credential_scope = "#{date}/#{config.region}/s3/aws4_request"

    string_to_sign =
      ["AWS4-HMAC-SHA256", amz_date, credential_scope, sha256_hex(canonical_request)]
      |> Enum.join("\n")

    signature =
      signing_key(config.secret_access_key, date, config.region)
      |> hmac(string_to_sign)
      |> Base.encode16(case: :lower)

    authorization =
      "AWS4-HMAC-SHA256 Credential=#{config.access_key_id}/#{credential_scope}, SignedHeaders=#{signed_header_names(headers)}, Signature=#{signature}"

    {:ok, [{"authorization", authorization} | headers]}
  end

  defp maybe_put_session_token(headers, nil), do: headers
  defp maybe_put_session_token(headers, ""), do: headers
  defp maybe_put_session_token(headers, token), do: [{"x-amz-security-token", token} | headers]

  defp url(%{endpoint: endpoint} = config, bucket, key) when is_binary(endpoint) and endpoint != "" do
    String.trim_trailing(endpoint, "/") <> canonical_uri(config, bucket, key)
  end

  defp url(config, bucket, key), do: "https://#{host(config, bucket)}#{canonical_uri(config, bucket, key)}"

  defp canonical_uri(%{endpoint: endpoint}, bucket, key)
       when is_binary(endpoint) and endpoint != "" do
    "/#{encode_path(bucket)}/#{encode_path(key)}"
  end

  defp canonical_uri(_config, _bucket, key), do: "/" <> encode_path(key)

  defp host(%{endpoint: endpoint}, _bucket) when is_binary(endpoint) and endpoint != "" do
    endpoint
    |> URI.parse()
    |> Map.fetch!(:host)
  end

  defp host(%{region: "us-east-1"}, bucket), do: "#{bucket}.s3.amazonaws.com"
  defp host(%{region: region}, bucket), do: "#{bucket}.s3.#{region}.amazonaws.com"

  defp canonical_headers(headers) do
    headers
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> Enum.map(fn {key, value} -> "#{String.downcase(key)}:#{String.trim(to_string(value))}\n" end)
    |> Enum.join()
  end

  defp signed_header_names(headers) do
    headers
    |> Enum.map(fn {key, _value} -> String.downcase(key) end)
    |> Enum.sort()
    |> Enum.join(";")
  end

  defp signing_key(secret, date, region) do
    ("AWS4" <> secret)
    |> hmac(date)
    |> hmac(region)
    |> hmac("s3")
    |> hmac("aws4_request")
  end

  defp hmac(key, data), do: :crypto.mac(:hmac, :sha256, key, data)

  defp sha256_hex(data), do: :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

  defp encode_path(path) do
    path
    |> String.split("/", trim: true)
    |> Enum.map(fn segment -> URI.encode(segment, &URI.char_unreserved?/1) end)
    |> Enum.join("/")
  end

  defp response_header(headers, key) do
    headers
    |> Enum.find_value(fn
      {^key, [value | _]} -> value
      {^key, value} when is_binary(value) -> value
      _other -> nil
    end)
  end
end
