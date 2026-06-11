defmodule SymphonyElixir.Manager.ModelClient.OpenAICompatibleChat do
  @moduledoc """
  Manager model client for OpenAI-compatible chat-completions endpoints.
  """

  @behaviour SymphonyElixir.Manager.ModelClient

  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.Planner.ToolNameMapping
  alias SymphonyElixir.ToolAdapter.PromptBased, as: PromptToolCallAdapter
  alias SymphonyElixir.ToolAdapter.OpenAICompatible, as: ToolCallAdapter

  @impl true
  def create_response(session, request, attempt) do
    req =
      Req.new(
        url: chat_completions_url(session.base_url),
        headers: headers(session)
      )
      |> Req.merge(session.req_options)

    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, attempt)
    Observability.log_model_call_started(context)

    case Req.post(req, json: provider_request(request)) do
      {:ok, %Req.Response{status: status, body: body} = provider_response} when status in 200..299 ->
        response = normalize_response(body, request)

        cond do
          Observability.provider_content_refusal?(body) ->
            classification =
              Observability.provider_content_refusal_failure(
                body,
                context,
                duration_since(started_at)
              )
              |> Map.put(:status_code, status)
              |> Map.put(:provider_status, status)
              |> Map.put(:provider_request_id, Observability.provider_request_id(provider_response))
              |> Observability.log_provider_failure()

            {:error, {:retryable, classification}}

          unsupported_tool_call_shape?(response) ->
            classification = %{
              error_code: "provider_invalid_request",
              message: "OpenAI-compatible manager backend returned tool_calls finish_reason without native tool_calls.",
              provider: "openai_compatible",
              model: session.model,
              runner_kind: "manager",
              status_code: status,
              provider_status: status,
              provider_request_id: Observability.provider_request_id(provider_response),
              duration_ms: duration_since(started_at),
              attempt: attempt,
              retry_count: max(attempt - 1, 0),
              retryable: false
            }

            Observability.log_provider_failure(Map.merge(context, classification))

            {:error, {:fatal, Map.put(classification, :error_code, "unsupported_manager_tool_call_format")}}

          true ->
            Observability.log_model_call_completed(context, duration_since(started_at),
              status_code: status,
              provider_request_id: Observability.provider_request_id(provider_response)
            )

            {:ok, response}
        end

      {:ok, %Req.Response{status: status, body: body} = response} ->
        classification =
          Observability.provider_status_failure(
            status,
            body,
            response,
            context,
            duration_since(started_at)
          )
          |> Observability.log_provider_failure()

        error_kind = if classification.retryable, do: :retryable, else: :fatal
        {:error, {error_kind, classification}}

      {:error, reason} ->
        classification =
          Observability.provider_request_failure(
            reason,
            context,
            duration_since(started_at)
          )
          |> Observability.log_provider_failure()

        {:error, {:retryable, classification}}
    end
  end

  @impl true
  def initial_request(session, due_tasks_payload, work_item) do
    history = Map.get(session, :history, [])
    provider_tool_name_map = Map.get(session, :provider_tool_name_map, %{})

    messages =
      [%{"role" => "system", "content" => tool_prompt(session.prompt, session.tool_specs, provider_tool_name_map)}] ++
        history ++
        [%{"role" => "user", "content" => due_tasks_payload}]

    %{
      "model" => session.model,
      "messages" => messages,
      "metadata" => %{
        "runner" => "manager",
        "workspace_id" => session.workspace_id,
        "work_item_id" => work_item.id,
        "work_item_identifier" => work_item.identifier
      },
      "provider_tool_name_map" => provider_tool_name_map,
      "tools" => Enum.map(session.tool_specs, &chat_tool_spec(&1, provider_tool_name_map))
    }
  end

  @impl true
  def follow_up_request(session, response, tool_outputs) do
    messages =
      response
      |> Map.fetch!("messages")
      |> Kernel.++([assistant_message(response)])
      |> Kernel.++(Enum.map(tool_outputs, &tool_output_message/1))

    %{
      "model" => session.model,
      "messages" => messages,
      "metadata" => Map.get(response, "metadata", %{}),
      "provider_tool_name_map" => Map.get(session, :provider_tool_name_map, %{}),
      "tools" => Enum.map(session.tool_specs, &chat_tool_spec(&1, Map.get(session, :provider_tool_name_map, %{})))
    }
  end

  @impl true
  def output_texts(response) when is_map(response) do
    case response |> Map.get("message", %{}) |> message_content_text() do
      "" -> []
      text -> [text]
    end
  end

  def output_texts(_response), do: []

  @impl true
  def tool_calls(response) when is_map(response) do
    native_calls =
      response
      |> Map.get("message", %{})
      |> ToolCallAdapter.parse_tool_calls()

    prompt_calls =
      if native_calls == [] do
        response
        |> Map.get("message", %{})
        |> PromptToolCallAdapter.parse_tool_calls()
      else
        []
      end

    (native_calls ++ prompt_calls)
    |> Enum.map(&canonical_to_function_call(&1, Map.get(response, "provider_tool_name_map", %{})))
  end

  def tool_calls(_response), do: []

  @impl true
  def response_id(response) when is_map(response), do: Map.get(response, "id")
  def response_id(_response), do: nil

  defp normalize_response(body, request) when is_map(body) do
    choice = body |> Map.get("choices", []) |> List.first() || %{}

    body
    |> Map.put("message", Map.get(choice, "message", %{}))
    |> Map.put("status", Map.get(choice, "finish_reason", "completed"))
    |> Map.put("messages", Map.get(request, "messages", []))
    |> Map.put("metadata", Map.get(request, "metadata", %{}))
    |> Map.put("provider_tool_name_map", Map.get(request, "provider_tool_name_map", %{}))
  end

  defp normalize_response(body, request) do
    %{
      "id" => nil,
      "message" => %{"content" => ""},
      "messages" => Map.get(request, "messages", []),
      "metadata" => Map.get(request, "metadata", %{}),
      "raw_body" => body
    }
  end

  defp unsupported_tool_call_shape?(response) do
    Map.get(response, "status") == "tool_calls" and tool_calls(response) == []
  end

  defp provider_request(request), do: Map.drop(request, ["provider_tool_name_map"])

  defp tool_prompt(prompt, tool_specs, provider_tool_name_map) do
    tools =
      tool_specs
      |> Enum.map(fn %{"name" => name} = spec ->
        provider_name = ToolNameMapping.provider_name(name, provider_tool_name_map)
        description = Map.get(spec, "description", "")

        if description == "" do
          provider_name
        else
          "#{provider_name}: #{description}"
        end
      end)
      |> Enum.join("\n")

    prompt <>
      """

      Available tool names are provider-specific. Use the exact names from this list:
      #{tools}

      Prefer native tool calls. If the local model cannot emit native tool calls, reply with a single tagged tool call:
      <function=tool_name>
      <parameter=parameter_name>
      JSON value or text
      </parameter>
      </function>
      """
  end

  defp assistant_message(response) do
    response
    |> Map.get("message", %{})
    |> Map.put("role", "assistant")
  end

  defp tool_output_message(%{"call_id" => call_id, "output" => output}) do
    %{"role" => "tool", "tool_call_id" => call_id, "content" => tool_output_content(output)}
  end

  defp tool_output_message(output), do: %{"role" => "tool", "content" => Jason.encode!(output)}

  defp tool_output_content(output) when is_binary(output), do: output
  defp tool_output_content(output), do: Jason.encode!(output)

  defp chat_tool_spec(%{"name" => name} = spec, provider_tool_name_map) do
    %{
      "type" => "function",
      "function" => %{
        "name" => ToolNameMapping.provider_name(name, provider_tool_name_map),
        "description" => Map.get(spec, "description", ""),
        "parameters" => tool_parameters(spec)
      }
    }
  end

  defp tool_parameters(spec) do
    case Map.get(spec, "inputSchema") || Map.get(spec, :inputSchema) || Map.get(spec, "parameters_schema") ||
           Map.get(spec, :parameters_schema) || Map.get(spec, "parameters") || Map.get(spec, :parameters) do
      schema when is_map(schema) -> schema
      _ -> %{"type" => "object", "properties" => %{}}
    end
  end

  defp canonical_to_function_call(call, provider_tool_name_map) do
    name = ToolNameMapping.runtime_name(call.name, provider_tool_name_map)

    %{
      "type" => "function_call",
      "call_id" => call.id,
      "name" => name,
      "arguments" => function_call_arguments(call)
    }
  end

  defp function_call_arguments(%{malformed_arguments?: true, raw_arguments: raw_arguments})
       when is_binary(raw_arguments),
       do: raw_arguments

  defp function_call_arguments(call), do: Jason.encode!(call.arguments || %{})

  defp message_content_text(%{"content" => content}), do: message_content_text(content)
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

  defp headers(session) do
    [{"content-type", "application/json"}]
    |> maybe_put_authorization(session.api_key)
  end

  defp maybe_put_authorization(headers, api_key) when is_binary(api_key) and api_key != "" do
    [{"authorization", "Bearer #{api_key}"} | headers]
  end

  defp maybe_put_authorization(headers, _api_key), do: headers

  defp chat_completions_url(base_url) do
    base_url
    |> to_string()
    |> String.trim_trailing("/")
    |> Kernel.<>("/chat/completions")
  end

  defp duration_since(started_at) do
    System.monotonic_time(:millisecond) - started_at
  end

  defp provider_context(session, attempt) do
    %{
      provider: "openai_compatible",
      model: session.model,
      runner_kind: "manager",
      credential_scope: Map.get(session, :credential_scope),
      credential_id: Map.get(session, :credential_id),
      attempt: attempt,
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      trace_id: Map.get(session, :trace_id),
      run_id: Map.get(session, :run_id),
      turn_id: Map.get(session, :turn_id)
    }
  end
end
