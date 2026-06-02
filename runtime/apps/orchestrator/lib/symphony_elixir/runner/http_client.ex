defmodule SymphonyElixir.Runner.HttpClient do
  @moduledoc """
  Shared HTTP client for runner adapters that use bearer-authenticated JSON APIs.
  """

  @type response :: %{status: non_neg_integer(), body: term()}

  @spec get(String.t(), String.t()) :: {:ok, response()} | {:error, term()}
  def get(base_url, path), do: request(:get, base_url, path, nil, nil, [])

  @spec get(String.t(), String.t(), String.t() | nil | keyword()) :: {:ok, response()} | {:error, term()}
  def get(base_url, path, opts) when is_list(opts), do: request(:get, base_url, path, nil, nil, opts)
  def get(base_url, path, api_key), do: request(:get, base_url, path, nil, api_key, [])

  @spec get(String.t(), String.t(), String.t() | nil, keyword()) :: {:ok, response()} | {:error, term()}
  def get(base_url, path, api_key, opts), do: request(:get, base_url, path, nil, api_key, opts)

  @spec post(String.t(), String.t(), map()) :: {:ok, response()} | {:error, term()}
  def post(base_url, path, body), do: request(:post, base_url, path, body, nil, [])

  @spec post(String.t(), String.t(), map(), String.t() | nil | keyword()) :: {:ok, response()} | {:error, term()}
  def post(base_url, path, body, opts) when is_list(opts), do: request(:post, base_url, path, body, nil, opts)
  def post(base_url, path, body, api_key), do: request(:post, base_url, path, body, api_key, [])

  @spec post(String.t(), String.t(), map(), String.t() | nil, keyword()) :: {:ok, response()} | {:error, term()}
  def post(base_url, path, body, api_key, opts), do: request(:post, base_url, path, body, api_key, opts)

  @spec delete(String.t(), String.t()) :: {:ok, response()} | {:error, term()}
  def delete(base_url, path), do: request(:delete, base_url, path, nil, nil, [])

  @spec delete(String.t(), String.t(), String.t() | nil | keyword()) :: {:ok, response()} | {:error, term()}
  def delete(base_url, path, opts) when is_list(opts), do: request(:delete, base_url, path, nil, nil, opts)
  def delete(base_url, path, api_key), do: request(:delete, base_url, path, nil, api_key, [])

  @spec delete(String.t(), String.t(), String.t() | nil, keyword()) :: {:ok, response()} | {:error, term()}
  def delete(base_url, path, api_key, opts), do: request(:delete, base_url, path, nil, api_key, opts)

  @spec request(atom(), String.t(), String.t(), term(), String.t() | nil, keyword()) ::
          {:ok, response()} | {:error, term()}
  def request(method, base_url, path, body, api_key \\ nil, opts \\ []) do
    url = String.trim_trailing(base_url, "/") <> path

    req =
      Req.new(url: url, headers: headers(api_key))
      |> Req.merge(opts)
      |> maybe_json(body)

    case Req.request(req, method: method) do
      {:ok, %Req.Response{status: status, body: response_body}} ->
        {:ok, %{status: status, body: response_body}}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, {:request_failed, Exception.message(e)}}
  end

  defp headers(nil), do: [{"content-type", "application/json"}]
  defp headers(api_key), do: [{"authorization", "Bearer #{api_key}"}, {"content-type", "application/json"}]

  defp maybe_json(req, nil), do: req
  defp maybe_json(req, body), do: Req.merge(req, json: body)
end
