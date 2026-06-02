defmodule SymphonyElixir.PlatformLearningClient do
  @moduledoc """
  HTTP client for the platform-side learning-job handler. The runtime
  is *transport* for `learning_reflection` and `learning_distillation`
  scheduled-task rows; the platform owns execution (LLM call,
  clustering, writes to `memory_items`). When `Delivery` sees one of
  those kinds, it POSTs the job payload here.

  Configured under `:symphony_elixir, :platform_learning_handler`:

      config :symphony_elixir, :platform_learning_handler,
        endpoint: System.get_env("PLATFORM_LEARNING_HANDLER_ENDPOINT"),
        api_key:  System.get_env("PLATFORM_LEARNING_HANDLER_API_KEY")

  If `endpoint` is unset, returns `{:error, :missing_platform_learning_endpoint}`
  — by design: the runtime should not start inserting `learning_*` rows
  (gated separately by `LEARNING_REFLECTION_ENABLED` in
  `SymphonyElixir.Learning.ReflectionDispatcher`) until the platform
  side is wired up. A misconfigured deployment fails the scheduled-task
  run loudly (via `Scheduler.finish_failure/6`) rather than silently
  dropping the work.

  Mirrors the `Req`-based pattern used by
  `SymphonyElixir.AgentCommunicationTools.post_control_plane/3`.
  """

  @type kind :: String.t()
  @type payload :: map()

  @callback post_job(kind(), payload(), keyword()) ::
              {:ok, map()} | {:error, term()}

  @spec post_job(kind(), payload(), keyword()) :: {:ok, map()} | {:error, term()}
  def post_job(kind, payload, opts \\ []) when is_binary(kind) and is_map(payload) do
    with {:ok, config} <- handler_config(opts) do
      req =
        [headers: headers(config)]
        |> Keyword.merge(config.req_options)
        |> Req.new()

      case Req.post(req, url: url(config.endpoint, kind), json: payload) do
        {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
          {:ok, normalize_body(body)}

        {:ok, %Req.Response{status: status, body: body}} ->
          {:error, {:platform_learning_http_error, status, body}}

        {:error, reason} ->
          {:error, {:platform_learning_request_failed, reason}}
      end
    end
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :platform_learning_req_options, [])

  defp handler_config(opts) do
    raw =
      :symphony_elixir
      |> Application.get_env(:platform_learning_handler, [])
      |> Enum.into(%{})
      |> Map.merge(Map.new(Keyword.get(opts, :platform_learning_config, [])))

    endpoint =
      string_config(raw, :endpoint) ||
        string_config(raw, "endpoint") ||
        env_config("PLATFORM_LEARNING_HANDLER_ENDPOINT")

    api_key =
      string_config(raw, :api_key) ||
        string_config(raw, "api_key") ||
        env_config("PLATFORM_LEARNING_HANDLER_API_KEY")

    req_options = Keyword.get(opts, :req_options, req_options())

    case endpoint do
      value when is_binary(value) and value != "" ->
        {:ok,
         %{
           endpoint: String.trim_trailing(value, "/"),
           api_key: api_key,
           req_options: req_options
         }}

      _ ->
        {:error, :missing_platform_learning_endpoint}
    end
  end

  defp string_config(map, key) do
    case Map.get(map, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp env_config(name) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp headers(%{api_key: api_key}) when is_binary(api_key) and api_key != "" do
    [{"accept", "application/json"}, {"authorization", "Bearer #{api_key}"}]
  end

  defp headers(_config), do: [{"accept", "application/json"}]

  # Mirrors the platform PR plan's endpoint shape:
  # `POST /api/learning/jobs/<kind>` with the job payload as JSON body.
  defp url(endpoint, kind) do
    encoded_kind = URI.encode(kind, &URI.char_unreserved?/1)
    endpoint <> "/api/learning/jobs/" <> encoded_kind
  end

  defp normalize_body(body) when is_map(body), do: body
  defp normalize_body(body) when is_binary(body), do: %{"body" => body}
  defp normalize_body(_), do: %{}
end
