defmodule SymphonyElixir.Provider.AnthropicMessages do
  @moduledoc """
  Anthropic Messages API provider adapter.

  The adapter accepts an already-resolved execution profile. Secret material is
  expected to be supplied by runtime credential resolution and is never returned
  in normalized events or errors.
  """

  @behaviour SymphonyElixir.Provider

  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.ToolAdapter.Anthropic, as: ToolCallAdapter

  @default_base_url "https://api.anthropic.com/v1/messages"
  @default_version "2023-06-01"
  @default_max_tokens 4096

  @retryable_error_codes MapSet.new([
                           "provider_rate_limited",
                           "provider_timeout",
                           "provider_capacity",
                           "provider_unavailable",
                           "provider_content_refused",
                           "provider_stream_interrupted",
                           "provider_unknown"
                         ])

  @spec validate_profile(map()) :: :ok | {:error, term()}
  def validate_profile(profile) when is_map(profile) do
    cond do
      blank?(profile_value(profile, :model)) ->
        {:error, {:missing_requirement, :model}}

      blank?(api_key(profile)) ->
        {:error, {:missing_requirement, :credential}}

      true ->
        :ok
    end
  end

  def validate_profile(_profile), do: {:error, {:invalid_profile, :not_a_map}}

  @impl true
  def start_turn(profile, messages, tools \\ [], opts \\ [])

  def start_turn(profile, messages, tools, opts)
      when is_map(profile) and is_list(messages) and is_list(tools) do
    with :ok <- validate_profile(profile) do
      started_at = System.monotonic_time(:millisecond)
      model = profile_value(profile, :model)
      request = request_body(profile, model, messages, tools, opts)
      context = provider_context(profile, opts)
      Observability.log_model_call_started(context)

      req =
        Req.new(
          url: profile_value(profile, :base_url) || @default_base_url,
          headers: [
            {"x-api-key", api_key(profile)},
            {"anthropic-version", profile_value(profile, :anthropic_version) || @default_version},
            {"content-type", "application/json"}
          ]
        )
        |> Req.merge(Keyword.get(opts, :req_options, []))

      case Req.post(req, json: request) do
        {:ok, %Req.Response{status: status, body: body} = response} when status in 200..299 ->
          if Observability.provider_content_refusal?(body) do
            classification =
              Observability.provider_content_refusal_failure(body, context, elapsed_ms(started_at))
              |> Map.put(:status_code, status)
              |> Map.put(:provider_status, status)
              |> Map.put(:provider_request_id, Observability.provider_request_id(response))
              |> Observability.log_provider_failure()

            {:error, {:retryable, classification}}
          else
            Observability.log_model_call_completed(context, elapsed_ms(started_at),
              status_code: status,
              provider_request_id: Observability.provider_request_id(response)
            )

            {:ok, normalize_response(body, model)}
          end

        {:ok, %Req.Response{status: status, body: body} = response} ->
          classification =
            classify_status_failure(
              status,
              body,
              response,
              context,
              elapsed_ms(started_at)
            )
            |> Observability.log_provider_failure()

          error_kind = if classification.retryable, do: :retryable, else: :fatal
          {:error, {error_kind, classification}}

        {:error, reason} ->
          classification =
            classify_request_failure(reason, context, elapsed_ms(started_at))
            |> Observability.log_provider_failure()

          {:error, {:retryable, classification}}
      end
    end
  end

  def start_turn(_profile, _messages, _tools, _opts) do
    {:error, {:fatal, %{error_code: :invalid_provider_request}}}
  end

  @spec normalize_event(term()) :: {:ok, map()} | :ignore | {:error, term()}
  def normalize_event(%{"type" => "message_start", "message" => message}) when is_map(message) do
    {:ok,
     %{
       type: "run.started",
       provider: "anthropic",
       run_id: Map.get(message, "id"),
       model: Map.get(message, "model")
     }
     |> reject_nil_values()}
  end

  def normalize_event(%{"type" => "content_block_start", "content_block" => %{"type" => "text", "text" => text}})
      when is_binary(text) and text != "" do
    {:ok, %{type: "message.delta", text: text}}
  end

  def normalize_event(%{"type" => "content_block_start", "content_block" => %{"type" => "text", "text" => ""}}),
    do: :ignore

  def normalize_event(%{
        "type" => "content_block_start",
        "index" => index,
        "content_block" => %{"type" => "tool_use"} = block
      }) do
    {:ok,
     %{
       type: "tool.started",
       call_id: Map.get(block, "id"),
       tool_name: Map.get(block, "name"),
       arguments: normalize_tool_arguments(Map.get(block, "input")),
       index: index
     }
     |> reject_nil_values()}
  end

  def normalize_event(%{"type" => "content_block_delta", "delta" => %{"type" => "text_delta", "text" => text}})
      when is_binary(text) and text != "" do
    {:ok, %{type: "message.delta", text: text}}
  end

  def normalize_event(%{
        "type" => "content_block_delta",
        "index" => index,
        "delta" => %{"type" => "input_json_delta", "partial_json" => partial_json}
      })
      when is_binary(partial_json) do
    {:ok, %{type: "tool.arguments.delta", index: index, partial_json: partial_json}}
  end

  def normalize_event(%{"type" => "message_delta", "usage" => usage} = event) when is_map(usage) do
    {:ok,
     %{
       type: "usage.updated",
       usage: normalize_usage(usage),
       stop_reason: normalize_stop_reason(get_in(event, ["delta", "stop_reason"]))
     }
     |> reject_nil_values()}
  end

  def normalize_event(%{"type" => "message_stop"}), do: {:ok, %{type: "run.completed"}}

  def normalize_event(%{"type" => "error", "error" => error}) when is_map(error) do
    classification = classify_provider_error(error)

    {:ok,
     %{
       type: "run.failed",
       error_code: classification.error_code,
       retryable: classification.retryable,
       reason: Map.get(error, "message")
     }
     |> reject_nil_values()}
  end

  def normalize_event(%{"type" => "ping"}), do: :ignore
  def normalize_event(%{"type" => "content_block_stop"}), do: :ignore
  def normalize_event(%{"type" => "message_delta"}), do: :ignore
  def normalize_event(%{"type" => type}), do: {:error, {:unknown_anthropic_event, type}}
  def normalize_event(_event), do: {:error, {:unknown_anthropic_event, nil}}

  @spec supports?(atom()) :: boolean()
  def supports?(:messages), do: true
  def supports?(:tool_calls), do: true
  def supports?(:usage), do: true
  def supports?(:system_prompt), do: true
  def supports?(:streaming), do: true
  def supports?(_capability), do: false

  @spec response_events(map()) :: [map()]
  def response_events(%{"type" => "message"} = message) do
    content_events =
      message
      |> Map.get("content", [])
      |> Enum.flat_map(&content_block_events/1)

    [
      normalize_success_event(%{"type" => "message_start", "message" => message}),
      content_events,
      normalize_usage_event(message)
    ]
    |> List.flatten()
    |> Enum.reject(&is_nil/1)
  end

  def response_events(_message), do: []

  @spec normalize_response(map(), String.t()) :: SymphonyElixir.Provider.turn_result()
  def normalize_response(%{"type" => "message"} = message, requested_model) do
    output_text = output_text(message)
    usage = normalize_usage(Map.get(message, "usage"))

    %{
      provider: "anthropic",
      model: Map.get(message, "model", requested_model),
      id: Map.get(message, "id"),
      output_text: output_text,
      tool_calls: ToolCallAdapter.parse_tool_calls(message),
      usage: usage,
      finish_reason: normalize_stop_reason(Map.get(message, "stop_reason")),
      events: runner_events(output_text, usage),
      raw: message
    }
  end

  def normalize_response(body, requested_model) do
    %{
      provider: "anthropic",
      model: requested_model,
      output_text: "",
      tool_calls: [],
      usage: %{},
      events: [],
      raw: %{"body" => body}
    }
  end

  @spec normalize_usage(map()) :: map()
  def normalize_usage(usage) when is_map(usage) do
    %{
      input_tokens: Map.get(usage, "input_tokens"),
      output_tokens: Map.get(usage, "output_tokens"),
      cache_creation_input_tokens: Map.get(usage, "cache_creation_input_tokens"),
      cache_read_input_tokens: Map.get(usage, "cache_read_input_tokens")
    }
    |> reject_nil_values()
  end

  def normalize_usage(_usage), do: %{}

  @spec normalize_stop_reason(term()) :: String.t() | nil
  def normalize_stop_reason("end_turn"), do: "completed"
  def normalize_stop_reason("tool_use"), do: "tool_calls"
  def normalize_stop_reason("max_tokens"), do: "max_tokens"
  def normalize_stop_reason("stop_sequence"), do: "stop_sequence"
  def normalize_stop_reason("pause_turn"), do: "paused"
  def normalize_stop_reason("refusal"), do: "refusal"
  def normalize_stop_reason(reason) when is_binary(reason), do: reason
  def normalize_stop_reason(_reason), do: nil

  @spec classify_status_failure(non_neg_integer(), term(), Req.Response.t(), map(), non_neg_integer()) :: map()
  def classify_status_failure(status, body, response, context, duration_ms) do
    base = Observability.provider_status_failure(status, body, response, context, duration_ms)
    error_code = anthropic_status_error_code(status, body, Map.get(base, :error_code))

    base
    |> Map.put(:error_code, error_code)
    |> Map.put(:retryable, retryable?(error_code))
  end

  @spec classify_request_failure(term(), map(), non_neg_integer()) :: map()
  def classify_request_failure(reason, context, duration_ms) do
    base = Observability.provider_request_failure(reason, context, duration_ms)
    error_code = request_error_code(base)

    base
    |> Map.put(:error_code, error_code)
    |> Map.put(:retryable, retryable?(error_code))
  end

  @spec classify_provider_error(map()) :: map()
  def classify_provider_error(error) when is_map(error) do
    error_code = anthropic_error_type_code(Map.get(error, "type")) || "provider_unknown"

    %{
      error_code: error_code,
      retryable: retryable?(error_code)
    }
  end

  defp request_body(profile, model, messages, tools, opts) do
    %{
      "model" => model,
      "max_tokens" => profile_value(profile, :max_tokens) || @default_max_tokens,
      "messages" => Enum.map(messages, &normalize_message/1),
      "system" => Keyword.get(opts, :system) || profile_value(profile, :system),
      "tools" => normalize_tools(tools),
      "metadata" => Keyword.get(opts, :metadata)
    }
    |> reject_blank_values()
  end

  defp normalize_message(message) when is_map(message) do
    message
    |> normalize_known_key(:role, "role")
    |> normalize_known_key(:content, "content")
  end

  defp normalize_known_key(map, atom_key, string_key) do
    case Map.fetch(map, atom_key) do
      {:ok, value} -> map |> Map.delete(atom_key) |> Map.put_new(string_key, value)
      :error -> map
    end
  end

  defp normalize_tools(tools) when is_list(tools), do: ToolCallAdapter.to_tool_specs(tools)
  defp normalize_tools(_tools), do: []

  defp content_block_events(%{"type" => "text", "text" => text}) when is_binary(text) and text != "" do
    [%{type: "message.delta", text: text}, %{type: "message.completed", text: text}]
  end

  defp content_block_events(%{"type" => "tool_use"} = block) do
    [
      %{
        type: "tool.started",
        call_id: Map.get(block, "id"),
        tool_name: Map.get(block, "name"),
        arguments: normalize_tool_arguments(Map.get(block, "input"))
      }
      |> reject_nil_values()
    ]
  end

  defp content_block_events(_block), do: []

  defp output_text(message) do
    message
    |> Map.get("content", [])
    |> Enum.flat_map(fn
      %{"type" => "text", "text" => text} when is_binary(text) -> [text]
      _block -> []
    end)
    |> Enum.join("")
  end

  defp runner_events(output_text, usage) do
    []
    |> maybe_append_text_delta(output_text)
    |> Kernel.++([
      %{
        event: :turn_completed,
        timestamp: DateTime.utc_now(),
        usage: usage,
        payload: %{"usage" => usage}
      }
    ])
  end

  defp maybe_append_text_delta(events, ""), do: events

  defp maybe_append_text_delta(events, text) do
    events ++
      [
        %{
          event: :notification,
          timestamp: DateTime.utc_now(),
          payload: %{
            "method" => "provider/message.delta",
            "params" => %{"textDelta" => text}
          }
        }
      ]
  end

  defp normalize_success_event(event) do
    case normalize_event(event) do
      {:ok, normalized} -> normalized
      :ignore -> nil
      {:error, _reason} -> nil
    end
  end

  defp normalize_usage_event(message) do
    %{
      type: "run.completed",
      usage: normalize_usage(Map.get(message, "usage")),
      stop_reason: normalize_stop_reason(Map.get(message, "stop_reason"))
    }
    |> reject_empty_usage()
    |> reject_nil_values()
  end

  defp reject_empty_usage(%{usage: usage} = event) when usage == %{}, do: Map.delete(event, :usage)
  defp reject_empty_usage(event), do: event

  defp normalize_tool_arguments(arguments) when is_map(arguments), do: arguments
  defp normalize_tool_arguments(_arguments), do: %{}

  defp provider_context(profile, opts) do
    metadata = Keyword.get(opts, :metadata, %{})

    %{
      provider: "anthropic",
      model: profile_value(profile, :model),
      runner_kind: profile_value(profile, :runner_kind),
      credential_scope: profile_value(profile, :credential_scope),
      credential_id: profile_value(profile, :credential_id),
      attempt: Keyword.get(opts, :attempt, 1),
      trace_id: Keyword.get(opts, :trace_id) || map_value(metadata, :trace_id),
      workspace_id: Keyword.get(opts, :workspace_id) || map_value(metadata, :workspace_id),
      agent_id: Keyword.get(opts, :agent_id) || map_value(metadata, :agent_id),
      run_id: Keyword.get(opts, :run_id) || map_value(metadata, :run_id),
      turn_id: Keyword.get(opts, :turn_id) || map_value(metadata, :turn_id)
    }
  end

  defp anthropic_status_error_code(status, body, fallback) do
    cond do
      anthropic_body_error_code(body) ->
        anthropic_body_error_code(body)

      status in [401, 403] ->
        "provider_auth_failed"

      status == 429 ->
        "provider_rate_limited"

      status in [408, 529] ->
        "provider_capacity"

      status in [500, 502, 503, 504] ->
        "provider_unavailable"

      true ->
        fallback || "provider_unknown"
    end
  end

  defp anthropic_body_error_code(%{"error" => %{"type" => type}}), do: anthropic_error_type_code(type)
  defp anthropic_body_error_code(_body), do: nil

  defp anthropic_error_type_code("authentication_error"), do: "provider_auth_failed"
  defp anthropic_error_type_code("permission_error"), do: "provider_auth_failed"
  defp anthropic_error_type_code("rate_limit_error"), do: "provider_rate_limited"
  defp anthropic_error_type_code("overloaded_error"), do: "provider_capacity"
  defp anthropic_error_type_code("api_error"), do: "provider_unavailable"
  defp anthropic_error_type_code("refusal"), do: "provider_content_refused"
  defp anthropic_error_type_code("content_policy_error"), do: "provider_content_refused"
  defp anthropic_error_type_code("not_found_error"), do: "provider_invalid_request"
  defp anthropic_error_type_code("invalid_request_error"), do: "provider_invalid_request"
  defp anthropic_error_type_code(_type), do: nil

  defp request_error_code(%{error_code: "provider_timeout"}), do: "provider_timeout"
  defp request_error_code(%{error_code: "provider_stream_interrupted"}), do: "provider_stream_interrupted"
  defp request_error_code(_classification), do: "provider_unknown"

  defp retryable?(error_code), do: MapSet.member?(@retryable_error_codes, error_code)

  defp api_key(profile) do
    profile_value(profile, :api_key) ||
      secret_value(profile_value(profile, :credential)) ||
      secret_value(profile_value(profile, :credential_ref))
  end

  defp secret_value(value) when is_binary(value), do: value
  defp secret_value(%{"value" => value}) when is_binary(value), do: value
  defp secret_value(%{"secret" => value}) when is_binary(value), do: value
  defp secret_value(%{value: value}) when is_binary(value), do: value
  defp secret_value(%{secret: value}) when is_binary(value), do: value
  defp secret_value(_value), do: nil

  defp profile_value(profile, key) do
    Map.get(profile, key) || Map.get(profile, Atom.to_string(key))
  end

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  defp map_value(_map, _key), do: nil

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp blank?(value), do: is_nil(value) or value == ""

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp reject_blank_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> blank?(value) or value == [] end)
    |> Map.new()
  end
end
