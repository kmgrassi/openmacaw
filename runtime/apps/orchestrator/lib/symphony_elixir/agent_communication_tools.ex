defmodule SymphonyElixir.AgentCommunicationTools do
  @moduledoc """
  Agent-to-agent handoff and remediation tools backed by platform control-plane APIs.
  """

  require Logger

  @message_tool "agent.message"
  @remediation_tool "agent.remediate"
  @tool_names [@message_tool, @remediation_tool]
  @remediation_actions ~w(retry restart request_credentials request_user_input)

  @spec tool_names() :: [String.t()]
  def tool_names, do: @tool_names

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => @message_tool,
        "description" => "Send a structured handoff or coordination message to another agent.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["target_agent_id", "body"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace boundary for the message."),
            "observer_agent_id" => string_schema("Agent sending or supervising the handoff."),
            "target_agent_id" => string_schema("Agent that should receive the message."),
            "body" => string_schema("Human-readable handoff or coordination text."),
            "message_type" =>
              enum_schema(
                ["handoff", "status", "question", "coordination"],
                "Structured message category."
              ),
            "payload" => object_schema("Optional machine-readable message details."),
            "trace_id" => nullable_string_schema("End-to-end observability trace id."),
            "run_id" => nullable_string_schema("Runtime run id related to the message.")
          }
        }
      },
      %{
        "name" => @remediation_tool,
        "description" => "Request a platform-controlled remediation action for another agent.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["target_agent_id", "action"],
          "properties" => %{
            "workspace_id" => string_schema("Workspace boundary for the remediation."),
            "observer_agent_id" => string_schema("Agent requesting remediation."),
            "target_agent_id" => string_schema("Agent to remediate."),
            "action" => enum_schema(@remediation_actions, "Allowed remediation action."),
            "reason" => nullable_string_schema("Short reason for the remediation request."),
            "payload" => object_schema("Optional action-specific remediation details."),
            "trace_id" => nullable_string_schema("End-to-end observability trace id."),
            "run_id" => nullable_string_schema("Runtime run id related to the remediation.")
          }
        }
      }
    ]
  end

  @spec execute(String.t(), term(), keyword()) :: {:ok, map()} | {:error, term()}
  def execute(tool, arguments, opts \\ [])

  def execute(@message_tool, arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, payload} <- message_payload(args, opts),
         {:ok, response} <-
           post_control_plane(
             ["api", "agents", payload["target_agent_id"], "messages"],
             payload,
             opts
           ) do
      {:ok, %{"message" => response, "target_agent_id" => payload["target_agent_id"]}}
    end
  end

  def execute(@remediation_tool, arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, payload} <- remediation_payload(args, opts),
         :ok <- log_remediation_request(payload),
         {:ok, response} <-
           post_control_plane(
             ["api", "agents", payload["target_agent_id"], "remediations"],
             payload,
             opts
           ) do
      {:ok, %{"remediation" => response, "target_agent_id" => payload["target_agent_id"]}}
    end
  end

  def execute(tool, _arguments, _opts), do: {:error, {:unsupported_tool, tool}}

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :agent_control_plane_req_options, [])

  defp message_payload(args, opts) do
    with {:ok, workspace_id} <- scoped_string(args, opts, "workspace_id"),
         {:ok, observer_agent_id} <- scoped_string(args, opts, "observer_agent_id", :agent_id),
         {:ok, target_agent_id} <- required_string(args, "target_agent_id"),
         {:ok, body} <- required_string(args, "body"),
         {:ok, payload} <- optional_map(args, "payload") do
      {:ok,
       %{
         "workspace_id" => workspace_id,
         "observer_agent_id" => observer_agent_id,
         "target_agent_id" => target_agent_id,
         "message_type" => optional_string(args, "message_type") || "handoff",
         "body" => body,
         "payload" => payload
       }
       |> maybe_put("trace_id", optional_string(args, "trace_id"))
       |> maybe_put("run_id", optional_string(args, "run_id"))}
    end
  end

  defp remediation_payload(args, opts) do
    with {:ok, workspace_id} <- scoped_string(args, opts, "workspace_id"),
         {:ok, observer_agent_id} <- scoped_string(args, opts, "observer_agent_id", :agent_id),
         {:ok, target_agent_id} <- required_string(args, "target_agent_id"),
         {:ok, action} <- required_string(args, "action"),
         :ok <- validate_remediation_action(action),
         {:ok, payload} <- optional_map(args, "payload") do
      {:ok,
       %{
         "workspace_id" => workspace_id,
         "observer_agent_id" => observer_agent_id,
         "target_agent_id" => target_agent_id,
         "action" => action,
         "payload" => payload
       }
       |> maybe_put("reason", optional_string(args, "reason"))
       |> maybe_put("trace_id", optional_string(args, "trace_id"))
       |> maybe_put("run_id", optional_string(args, "run_id"))}
    end
  end

  defp post_control_plane(path_segments, payload, opts) do
    with {:ok, config} <- control_plane_config(opts) do
      req =
        [headers: headers(config)]
        |> Keyword.merge(config.req_options)
        |> Req.new()

      case Req.post(req, url: url(config.endpoint, path_segments), json: payload) do
        {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
          {:ok, normalize_body(body)}

        {:ok, %Req.Response{status: status, body: body}} ->
          {:error, {:control_plane_http_error, status, body}}

        {:error, reason} ->
          {:error, {:control_plane_request_failed, reason}}
      end
    end
  end

  defp control_plane_config(opts) do
    raw =
      :symphony_elixir
      |> Application.get_env(:agent_control_plane, [])
      |> Enum.into(%{})
      |> Map.merge(Map.new(Keyword.get(opts, :control_plane_config, [])))

    endpoint = string_config(raw, :endpoint) || string_config(raw, "endpoint")
    api_key = string_config(raw, :api_key) || string_config(raw, "api_key")
    req_options = Keyword.get(opts, :req_options, req_options())

    case endpoint do
      value when is_binary(value) and value != "" ->
        {:ok,
         %{endpoint: String.trim_trailing(value, "/"), api_key: api_key, req_options: req_options}}

      _ ->
        {:error, :missing_control_plane_endpoint}
    end
  end

  defp string_config(map, key) do
    case Map.get(map, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp headers(%{api_key: api_key}) when is_binary(api_key) and api_key != "" do
    [{"accept", "application/json"}, {"authorization", "Bearer #{api_key}"}]
  end

  defp headers(_config), do: [{"accept", "application/json"}]

  defp url(endpoint, path_segments) do
    encoded_path =
      path_segments
      |> Enum.map(fn segment -> URI.encode(to_string(segment), &URI.char_unreserved?/1) end)
      |> Enum.join("/")

    endpoint <> "/" <> encoded_path
  end

  defp normalize_body(body) when is_map(body), do: body
  defp normalize_body(body) when is_list(body), do: %{"items" => body}
  defp normalize_body(nil), do: %{}
  defp normalize_body(body), do: %{"body" => body}

  defp log_remediation_request(payload) do
    event =
      Map.take(payload, [
        "workspace_id",
        "observer_agent_id",
        "target_agent_id",
        "action",
        "reason",
        "trace_id",
        "run_id"
      ])
      |> Map.put("event", "manager_remediation_requested")

    Logger.info(fn -> Jason.encode!(event) end)
    :ok
  end

  defp normalize_arguments(arguments) when is_map(arguments) do
    {:ok, Map.new(arguments, fn {key, value} -> {to_string(key), value} end)}
  end

  defp normalize_arguments(_arguments), do: {:error, :invalid_arguments}

  defp required_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, {:missing_argument, key}}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, {:missing_argument, key}}
    end
  end

  defp scoped_string(args, opts, key, opt_key \\ nil) do
    opt_key = opt_key || String.to_atom(key)

    case Keyword.get(opts, opt_key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> required_string(args, key)
    end
  end

  defp optional_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end

      _ ->
        nil
    end
  end

  defp optional_map(args, key) do
    case Map.get(args, key) do
      nil -> {:ok, %{}}
      value when is_map(value) -> {:ok, value}
      _ -> {:error, {:invalid_argument, key, "must be an object"}}
    end
  end

  defp validate_remediation_action(action) when action in @remediation_actions, do: :ok
  defp validate_remediation_action(action), do: {:error, {:invalid_remediation_action, action}}

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp string_schema(description), do: %{"type" => "string", "description" => description}

  defp nullable_string_schema(description),
    do: %{"type" => ["string", "null"], "description" => description}

  defp enum_schema(values, description),
    do: %{"type" => "string", "enum" => values, "description" => description}

  defp object_schema(description) do
    %{
      "type" => ["object", "null"],
      "description" => description,
      "additionalProperties" => true
    }
  end
end
