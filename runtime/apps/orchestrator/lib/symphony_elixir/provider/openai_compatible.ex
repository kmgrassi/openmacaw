defmodule SymphonyElixir.Provider.OpenAICompatible do
  @moduledoc """
  OpenAI-compatible Chat Completions provider adapter.

  The adapter targets providers that implement `POST /chat/completions` with
  OpenAI-style messages, tools, usage, and assistant tool calls. The base URL,
  model, and bearer credential come from the resolved execution profile.
  """

  @behaviour SymphonyElixir.Provider

  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.ToolAdapter.OpenAICompatible, as: ToolCallAdapter
  alias SymphonyElixir.ToolCall

  @default_base_url "https://api.openai.com/v1"
  @passthrough_request_keys ~w(temperature top_p max_tokens max_completion_tokens presence_penalty frequency_penalty stop response_format tool_choice parallel_tool_calls)

  @doc """
  Normalizes OpenAI-compatible streaming chunks into the provider turn shape.

  Local OpenAI-compatible providers are not perfectly uniform, but Ollama,
  vLLM, LM Studio, and OpenAI-compatible proxies generally emit Chat
  Completions chunks with `choices[].delta`, optional `usage`, and final
  `finish_reason` fields. This function keeps that provider-adjacent input at
  the adapter boundary and emits the same runtime event vocabulary as regular
  provider-backed runs.
  """
  @spec normalize_chunks([map()], String.t()) :: SymphonyElixir.Provider.turn_result()
  def normalize_chunks(chunks, requested_model) when is_list(chunks) do
    state =
      Enum.reduce(chunks, initial_chunk_state(requested_model), fn chunk, state ->
        normalize_chunk(chunk, state)
      end)

    tool_calls = state.tool_calls |> Map.values() |> Enum.sort_by(& &1.index) |> Enum.map(&finalize_tool_call/1)

    completion_event =
      if state.failed? do
        []
      else
        [run_completed_event(state.output_text, state.usage)]
      end

    %{
      provider: "openai_compatible",
      model: state.model || requested_model,
      id: state.id,
      output_text: state.output_text,
      tool_calls: tool_calls,
      usage: state.usage,
      finish_reason: state.finish_reason,
      events: state.events ++ completion_event,
      raw: %{"chunks" => chunks}
    }
  end

  @impl true
  def start_turn(profile, messages, tools \\ [], opts \\ [])

  def start_turn(profile, messages, tools, opts)
      when is_map(profile) and is_list(messages) and is_list(tools) do
    with {:ok, model} <- required_string(profile, "model"),
         {:ok, bearer} <- bearer_token(profile) do
      base_url = profile_value(profile, "base_url") || @default_base_url
      req_options = Keyword.get(opts, :req_options, profile_value(profile, "req_options") || [])

      request =
        profile
        |> base_request(model, messages, tools)
        |> maybe_put_metadata(Keyword.get(opts, :metadata))

      started_at = System.monotonic_time(:millisecond)
      context = provider_context(profile, model, opts)
      Observability.log_model_call_started(context)

      req =
        Req.new(
          url: chat_completions_url(base_url),
          headers: [
            {"authorization", "Bearer #{bearer}"},
            {"content-type", "application/json"}
          ]
        )
        |> Req.merge(req_options)

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
          Observability.provider_status_failure(status, body, response, context, elapsed_ms(started_at))
          |> Observability.log_provider_failure()

          {:error, classify_status(status, body)}

        {:error, reason} ->
          Observability.provider_request_failure(reason, context, elapsed_ms(started_at))
          |> Observability.log_provider_failure()

          {:error, {:retryable, %{error_code: :provider_request_failed, reason: inspect(reason)}}}
      end
    end
  end

  def start_turn(_profile, _messages, _tools, _opts) do
    {:error, {:fatal, %{error_code: :invalid_provider_request}}}
  end

  defp base_request(profile, model, messages, tools) do
    %{
      "model" => model,
      "messages" => Enum.map(messages, &normalize_message/1)
    }
    |> maybe_put_tools(tools)
    |> put_passthrough_options(profile)
  end

  defp normalize_message(message) when is_map(message) do
    message
    |> normalize_known_key(:role, "role")
    |> normalize_known_key(:content, "content")
    |> normalize_known_key(:name, "name")
    |> normalize_known_key(:tool_call_id, "tool_call_id")
    |> normalize_known_key(:tool_calls, "tool_calls")
  end

  defp normalize_known_key(map, atom_key, string_key) do
    case Map.fetch(map, atom_key) do
      {:ok, value} -> map |> Map.delete(atom_key) |> Map.put_new(string_key, value)
      :error -> map
    end
  end

  defp maybe_put_tools(request, []), do: request

  defp maybe_put_tools(request, tools) do
    Map.put(request, "tools", Enum.map(tools, &normalize_tool/1))
  end

  defp normalize_tool(%{"type" => "function", "function" => %{} = _function} = tool), do: tool
  defp normalize_tool(%{type: "function", function: %{} = function}), do: %{"type" => "function", "function" => stringify_keys(function)}

  defp normalize_tool(%{"name" => name} = spec) do
    %{
      "type" => "function",
      "function" => %{
        "name" => name,
        "description" => Map.get(spec, "description", ""),
        "parameters" => Map.get(spec, "parameters") || Map.get(spec, "inputSchema") || %{"type" => "object", "properties" => %{}}
      }
    }
  end

  defp normalize_tool(%{name: name} = spec) do
    normalize_tool(%{
      "name" => name,
      "description" => Map.get(spec, :description, ""),
      "parameters" => Map.get(spec, :parameters) || Map.get(spec, :inputSchema)
    })
  end

  defp normalize_tool(tool) when is_map(tool), do: stringify_keys(tool)

  defp put_passthrough_options(request, profile) do
    Enum.reduce(@passthrough_request_keys, request, fn key, acc ->
      case profile_value(profile, key) do
        nil -> acc
        value -> Map.put(acc, key, value)
      end
    end)
  end

  defp maybe_put_metadata(request, metadata) when is_map(metadata), do: Map.put(request, "metadata", metadata)
  defp maybe_put_metadata(request, _metadata), do: request

  defp provider_context(profile, model, opts) do
    metadata = Keyword.get(opts, :metadata, %{})

    %{
      provider: "openai_compatible",
      model: model,
      runner_kind: profile_value(profile, "runner_kind") || profile_value(profile, :runner_kind),
      credential_scope: profile_value(profile, "credential_scope") || profile_value(profile, :credential_scope),
      credential_id: profile_value(profile, "credential_id") || profile_value(profile, :credential_id),
      attempt: Keyword.get(opts, :attempt, 1),
      trace_id: Keyword.get(opts, :trace_id) || map_value(metadata, :trace_id),
      workspace_id: Keyword.get(opts, :workspace_id) || map_value(metadata, :workspace_id),
      agent_id: Keyword.get(opts, :agent_id) || map_value(metadata, :agent_id),
      run_id: Keyword.get(opts, :run_id) || map_value(metadata, :run_id),
      turn_id: Keyword.get(opts, :turn_id) || map_value(metadata, :turn_id)
    }
  end

  defp normalize_response(body, requested_model) when is_map(body) do
    choice = body |> Map.get("choices", []) |> List.first() || %{}
    message = Map.get(choice, "message", %{})
    output_text = message_content_text(Map.get(message, "content"))
    tool_calls = ToolCallAdapter.parse_tool_calls(%{"tool_calls" => Map.get(message, "tool_calls", [])})
    usage = Map.get(body, "usage", %{})

    %{
      provider: "openai_compatible",
      model: Map.get(body, "model", requested_model),
      id: Map.get(body, "id"),
      output_text: output_text,
      tool_calls: tool_calls,
      usage: usage,
      finish_reason: Map.get(choice, "finish_reason"),
      events: response_events(output_text, tool_calls, usage),
      raw: body
    }
  end

  defp normalize_response(body, requested_model) do
    %{
      provider: "openai_compatible",
      model: requested_model,
      output_text: "",
      tool_calls: [],
      usage: %{},
      events: [],
      raw: %{"body" => body}
    }
  end

  defp message_content_text(content) when is_binary(content), do: content

  defp message_content_text(content) when is_list(content) do
    content
    |> Enum.flat_map(fn
      %{"type" => type, "text" => text} when type in ["text", "output_text"] and is_binary(text) -> [text]
      %{"text" => text} when is_binary(text) -> [text]
      _part -> []
    end)
    |> Enum.join("")
  end

  defp message_content_text(_content), do: ""

  defp decode_arguments(arguments) when is_binary(arguments) do
    {decoded, malformed?} = ToolCall.decode_arguments(arguments)
    if malformed?, do: arguments, else: decoded
  end

  defp decode_arguments(arguments) when is_map(arguments), do: arguments
  defp decode_arguments(_arguments), do: %{}

  defp response_events(output_text, tool_calls, usage) do
    []
    |> maybe_append_text_delta(output_text)
    |> Kernel.++(tool_call_events(tool_calls))
    |> maybe_append_usage_updated(usage)
    |> Kernel.++([run_completed_event(output_text, usage)])
  end

  defp maybe_append_text_delta(events, ""), do: events

  defp maybe_append_text_delta(events, text) do
    events ++
      [
        %{
          event: :notification,
          timestamp: DateTime.utc_now(),
          payload: %{
            "method" => "message.delta",
            "params" => %{"textDelta" => text}
          }
        }
      ]
  end

  defp tool_call_events([]), do: []

  defp tool_call_events(tool_calls) do
    Enum.flat_map(tool_calls, fn call ->
      payload = %{
        "type" => "function",
        "id" => call.id,
        "callId" => call.id,
        "name" => call.name,
        "arguments" => call.arguments
      }

      [
        %{event: :tool_call_started, timestamp: DateTime.utc_now(), payload: Map.put(payload, "method", "tool.started")},
        %{event: :tool_call_completed, timestamp: DateTime.utc_now(), payload: Map.put(payload, "method", "tool.completed")}
      ]
    end)
  end

  defp maybe_append_usage_updated(events, usage) when usage == %{} or is_nil(usage), do: events

  defp maybe_append_usage_updated(events, usage) do
    events ++
      [
        %{
          event: :notification,
          timestamp: DateTime.utc_now(),
          usage: usage,
          payload: %{"method" => "usage.updated", "params" => %{"usage" => usage}}
        }
      ]
  end

  defp run_completed_event(output_text, usage) do
    %{
      event: :turn_completed,
      timestamp: DateTime.utc_now(),
      usage: usage,
      payload: %{"method" => "run.completed", "params" => %{"output" => output_text, "usage" => usage}}
    }
  end

  defp run_failed_event(error) do
    %{
      event: :turn_ended_with_error,
      timestamp: DateTime.utc_now(),
      message: provider_error_message(error) || "OpenAI-compatible run failed",
      payload: %{"method" => "run.failed", "params" => %{"error" => error}}
    }
  end

  defp initial_chunk_state(requested_model) do
    %{
      id: nil,
      model: requested_model,
      output_text: "",
      tool_calls: %{},
      usage: %{},
      finish_reason: nil,
      events: [],
      failed?: false
    }
  end

  defp normalize_chunk(%{"error" => error}, state) do
    %{state | failed?: true, events: state.events ++ [run_failed_event(error)]}
  end

  defp normalize_chunk(chunk, state) when is_map(chunk) do
    choice = chunk |> Map.get("choices", []) |> List.first() || %{}
    delta = Map.get(choice, "delta", %{})
    usage = Map.get(chunk, "usage") || state.usage

    state
    |> put_chunk_identity(chunk)
    |> append_content_delta(Map.get(delta, "content"))
    |> merge_tool_deltas(Map.get(delta, "tool_calls", []))
    |> maybe_complete_tool_calls(Map.get(choice, "finish_reason"))
    |> maybe_update_finish_reason(Map.get(choice, "finish_reason"))
    |> maybe_append_chunk_usage(usage)
  end

  defp normalize_chunk(_chunk, state), do: state

  defp put_chunk_identity(state, chunk) do
    %{state | id: state.id || Map.get(chunk, "id"), model: Map.get(chunk, "model") || state.model}
  end

  defp append_content_delta(state, text) when is_binary(text) and text != "" do
    %{state | output_text: state.output_text <> text, events: maybe_append_text_delta(state.events, text)}
  end

  defp append_content_delta(state, content) when is_list(content) do
    append_content_delta(state, message_content_text(content))
  end

  defp append_content_delta(state, _text), do: state

  defp merge_tool_deltas(state, calls) when is_list(calls) do
    Enum.reduce(calls, state, fn call, acc ->
      index = Map.get(call, "index", map_size(acc.tool_calls))
      existing = Map.get(acc.tool_calls, index, %{index: index, id: nil, name: nil, arguments: "", started?: false, completed?: false})
      function = Map.get(call, "function", %{})

      updated = %{
        existing
        | id: Map.get(call, "id") || existing.id,
          name: append_optional(existing.name, Map.get(function, "name")),
          arguments: existing.arguments <> argument_delta(Map.get(function, "arguments"))
      }

      events =
        if existing.started? do
          acc.events
        else
          acc.events ++ [%{event: :tool_call_started, timestamp: DateTime.utc_now(), payload: tool_event_payload(updated, "tool.started")}]
        end

      %{acc | tool_calls: Map.put(acc.tool_calls, index, %{updated | started?: true}), events: events}
    end)
  end

  defp merge_tool_deltas(state, _calls), do: state

  defp maybe_complete_tool_calls(state, reason) when is_binary(reason) do
    {tool_calls, events} =
      Enum.reduce(state.tool_calls, {state.tool_calls, state.events}, fn {index, call}, {calls, events} ->
        if call.completed? do
          {calls, events}
        else
          completed = %{call | completed?: true}
          {Map.put(calls, index, completed), events ++ [%{event: :tool_call_completed, timestamp: DateTime.utc_now(), payload: tool_event_payload(completed, "tool.completed")}]}
        end
      end)

    %{state | tool_calls: tool_calls, events: events}
  end

  defp maybe_complete_tool_calls(state, _finish_reason), do: state

  defp maybe_update_finish_reason(state, reason) when is_binary(reason), do: %{state | finish_reason: reason}
  defp maybe_update_finish_reason(state, _reason), do: state

  defp maybe_append_chunk_usage(state, usage) when is_map(usage) and usage != %{} and usage != state.usage do
    %{state | usage: usage, events: maybe_append_usage_updated(state.events, usage)}
  end

  defp maybe_append_chunk_usage(state, usage) when is_map(usage), do: %{state | usage: usage}
  defp maybe_append_chunk_usage(state, _usage), do: state

  defp append_optional(nil, value) when is_binary(value), do: value
  defp append_optional(existing, value) when is_binary(existing) and is_binary(value), do: existing <> value
  defp append_optional(existing, _value), do: existing

  defp argument_delta(nil), do: ""
  defp argument_delta(value) when is_binary(value), do: value

  defp argument_delta(value) when is_map(value) or is_list(value) do
    case Jason.encode(value) do
      {:ok, encoded} -> encoded
      {:error, _reason} -> inspect(value)
    end
  end

  defp argument_delta(value), do: to_string(value)

  defp finalize_tool_call(call) do
    %{
      id: call.id,
      name: call.name,
      arguments: decode_arguments(call.arguments)
    }
  end

  defp tool_event_payload(call, method) do
    %{
      "method" => method,
      "type" => "function",
      "id" => call.id,
      "callId" => call.id,
      "name" => call.name,
      "arguments" => decode_arguments(call.arguments)
    }
  end

  defp chat_completions_url(base_url) do
    base_url
    |> to_string()
    |> String.trim_trailing("/")
    |> Kernel.<>("/chat/completions")
  end

  defp bearer_token(profile) do
    token =
      profile_value(profile, "bearer_token") ||
        profile_value(profile, "api_key") ||
        secret_value(profile_value(profile, "credential")) ||
        secret_value(profile_value(profile, "credential_ref"))

    case token do
      token when is_binary(token) and token != "" -> {:ok, token}
      _ -> {:error, {:missing_requirement, :credential}}
    end
  end

  defp secret_value(value) when is_binary(value), do: value
  defp secret_value(%{"value" => value}) when is_binary(value), do: value
  defp secret_value(%{"secret" => value}) when is_binary(value), do: value
  defp secret_value(%{value: value}) when is_binary(value), do: value
  defp secret_value(%{secret: value}) when is_binary(value), do: value
  defp secret_value(_value), do: nil

  defp required_string(profile, key) do
    case profile_value(profile, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_requirement, String.to_atom(key)}}
    end
  end

  defp profile_value(profile, key) do
    case Map.fetch(profile, key) do
      {:ok, value} -> value
      :error -> Map.get(profile, atom_key(key))
    end
  end

  defp atom_key(key) when is_binary(key), do: String.to_atom(key)
  defp atom_key(key) when is_atom(key), do: key

  defp classify_status(status, body) do
    error_code = status_error_code(status, body)

    classification = %{
      error_code: error_code,
      provider_status: status,
      retryable: retryable_status?(status, error_code),
      message: provider_error_message(body)
    }

    if classification.retryable do
      {:retryable, classification}
    else
      {:fatal, classification}
    end
  end

  defp status_error_code(status, body) do
    if Observability.content_policy_status_failure?(status, body) do
      :provider_content_refused
    else
      status_error_code(status)
    end
  end

  defp status_error_code(status) when status in [401, 403], do: :provider_auth_failed
  defp status_error_code(429), do: :provider_rate_limited
  defp status_error_code(status) when status in 500..599, do: :provider_unavailable
  defp status_error_code(_status), do: :provider_rejected_request

  defp retryable_status?(_status, :provider_content_refused), do: true
  defp retryable_status?(status, _error_code), do: status == 429 or status in 500..599

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  defp map_value(_map, _key), do: nil

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp provider_error_message(%{"error" => %{"message" => message}}) when is_binary(message), do: message
  defp provider_error_message(%{"message" => message}) when is_binary(message), do: message
  defp provider_error_message(body) when is_binary(body), do: body
  defp provider_error_message(_body), do: nil

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), stringify_nested(value)}
      {key, value} -> {key, stringify_nested(value)}
    end)
  end

  defp stringify_nested(value) when is_map(value), do: stringify_keys(value)
  defp stringify_nested(value) when is_list(value), do: Enum.map(value, &stringify_nested/1)
  defp stringify_nested(value), do: value
end
