defmodule SymphonyElixir.Aws.SignatureV4 do
  @moduledoc """
  Minimal AWS Signature Version 4 signer for JSON API requests.
  """

  @type credentials :: %{
          required(:access_key_id) => String.t(),
          required(:secret_access_key) => String.t(),
          optional(:session_token) => String.t() | nil
        }

  @spec sign(map(), credentials(), String.t(), String.t(), DateTime.t()) :: map()
  def sign(request, credentials, service, region, now \\ DateTime.utc_now()) do
    method = request.method |> to_string() |> String.upcase()
    uri = Map.get(request, :uri, "/")
    query = Map.get(request, :query, "")
    body = Map.get(request, :body, "")
    host = request.host
    amz_date = amz_date(now)
    date = date_stamp(now)

    headers =
      request
      |> Map.get(:headers, %{})
      |> normalize_headers()
      |> Map.put("host", host)
      |> Map.put("x-amz-date", amz_date)
      |> maybe_put_token(credentials[:session_token])

    {canonical_headers, signed_headers} = canonical_headers(headers)

    canonical_request =
      [
        method,
        canonical_uri(uri),
        canonical_query(query),
        canonical_headers,
        signed_headers,
        sha256_hex(body)
      ]
      |> Enum.join("\n")

    scope = Enum.join([date, region, service, "aws4_request"], "/")

    string_to_sign =
      ["AWS4-HMAC-SHA256", amz_date, scope, sha256_hex(canonical_request)]
      |> Enum.join("\n")

    signature =
      date
      |> signing_key(credentials.secret_access_key, region, service)
      |> hmac(string_to_sign)
      |> Base.encode16(case: :lower)

    authorization =
      "AWS4-HMAC-SHA256 Credential=#{credentials.access_key_id}/#{scope}, " <>
        "SignedHeaders=#{signed_headers}, Signature=#{signature}"

    Map.put(headers, "authorization", authorization)
  end

  defp maybe_put_token(headers, nil), do: headers
  defp maybe_put_token(headers, ""), do: headers
  defp maybe_put_token(headers, token), do: Map.put(headers, "x-amz-security-token", token)

  defp normalize_headers(headers) do
    Map.new(headers, fn {key, value} ->
      {key |> to_string() |> String.downcase(), normalize_header_value(value)}
    end)
  end

  defp normalize_header_value(value) do
    value
    |> to_string()
    |> String.trim()
    |> String.replace(~r/\s+/, " ")
  end

  defp canonical_headers(headers) do
    pairs = Enum.sort_by(headers, fn {key, _value} -> key end)
    canonical = Enum.map_join(pairs, "", fn {key, value} -> "#{key}:#{value}\n" end)
    signed = Enum.map_join(pairs, ";", fn {key, _value} -> key end)
    {canonical, signed}
  end

  defp canonical_uri(uri) do
    uri
    |> String.split("/", trim: false)
    |> Enum.map(fn segment -> URI.encode(segment, &URI.char_unreserved?/1) end)
    |> Enum.join("/")
  end

  defp canonical_query(""), do: ""

  defp canonical_query(query) when is_binary(query) do
    query
    |> URI.query_decoder()
    |> Enum.map(fn {key, value} ->
      {URI.encode(key, &URI.char_unreserved?/1), URI.encode(value, &URI.char_unreserved?/1)}
    end)
    |> Enum.sort()
    |> Enum.map_join("&", fn {key, value} -> "#{key}=#{value}" end)
  end

  defp sha256_hex(value), do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp signing_key(date, secret, region, service) do
    ("AWS4" <> secret)
    |> hmac(date)
    |> hmac(region)
    |> hmac(service)
    |> hmac("aws4_request")
  end

  defp hmac(key, data), do: :crypto.mac(:hmac, :sha256, key, data)

  defp amz_date(%DateTime{} = datetime), do: Calendar.strftime(datetime, "%Y%m%dT%H%M%SZ")
  defp date_stamp(%DateTime{} = datetime), do: Calendar.strftime(datetime, "%Y%m%d")
end
