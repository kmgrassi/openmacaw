defmodule SymphonyElixir.Planner.PlanDraft do
  @moduledoc """
  Drafts editable plan documents for the platform plan-review harness.
  """

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
  alias SymphonyElixir.MapUtils
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @responses_url "https://api.openai.com/v1/responses"
  @default_model "gpt-5.1"
  @completion_gates ~w(lint tests peer_review self_review)

  @callback draft_for_agent(String.t(), map()) :: {:ok, map()} | {:error, term()}

  @spec draft_for_agent(String.t(), map()) :: {:ok, map()} | {:error, term()}
  def draft_for_agent(agent_id, params) when is_binary(agent_id) and is_map(params) do
    with {:ok, %Agent{} = agent} <- AgentInventory.get_agent(agent_id),
         :ok <- require_planning_agent(agent),
         {:ok, request} <- validate_request(params),
         {:ok, api_key} <- openai_api_key(agent),
         {:ok, response} <- create_response(agent, api_key, request),
         {:ok, draft} <- extract_draft(response) do
      {:ok, %{"draft" => draft}}
    end
  end

  def draft_for_agent(_agent_id, _params), do: {:error, {:invalid_request, "request body must be a JSON object"}}

  defp require_planning_agent(agent) do
    if Agent.planning?(agent), do: :ok, else: {:error, :not_planning_agent}
  end

  defp validate_request(params) do
    workspace_id = MapUtils.trimmed_string(params, "workspace_id")
    prompt = MapUtils.trimmed_string(params, "prompt")

    cond do
      workspace_id == nil ->
        {:error, {:invalid_request, "workspace_id is required"}}

      prompt == nil ->
        {:error, {:invalid_request, "prompt is required"}}

      true ->
        {:ok,
         %{
           "workspace_id" => workspace_id,
           "prompt" => prompt,
           "default_runner" => MapUtils.trimmed_string(params, "default_runner"),
           "default_model" => MapUtils.trimmed_string(params, "default_model")
         }}
    end
  end

  defp openai_api_key(%Agent{id: agent_id}) when is_binary(agent_id) do
    case AgentInventory.list_credentials(agent_id) do
      {:ok, credentials} ->
        credentials
        |> Enum.find_value(&resolve_openai_credential/1)
        |> case do
          value when is_binary(value) and value != "" -> {:ok, value}
          _ -> openai_api_key_from_env()
        end

      _ ->
        openai_api_key_from_env()
    end
  end

  defp openai_api_key(_agent), do: openai_api_key_from_env()

  defp resolve_openai_credential(%StoredCredential{env_var: "OPENAI_API_KEY"} = credential) do
    case SecretResolver.resolve(credential) do
      {:ok, %{"OPENAI_API_KEY" => value}} when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp resolve_openai_credential(_credential), do: nil

  defp openai_api_key_from_env do
    case System.get_env("OPENAI_API_KEY") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :missing_openai_api_key}
    end
  end

  defp create_response(%Agent{} = agent, api_key, request) do
    req =
      Req.new(
        url: responses_url(),
        headers: [
          {"authorization", "Bearer #{api_key}"},
          {"content-type", "application/json"}
        ]
      )
      |> Req.merge(req_options())

    case Req.post(req, json: response_request(agent, request)) do
      {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
        {:ok, body}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:responses_api_status, status, body}}

      {:error, reason} ->
        {:error, {:responses_api_request, reason}}
    end
  end

  defp response_request(%Agent{} = agent, request) do
    %{
      "model" => model(agent),
      "instructions" => instructions(agent),
      "input" => [
        %{
          "role" => "user",
          "content" => [
            %{
              "type" => "input_text",
              "text" => """
              Workspace ID: #{request["workspace_id"]}
              Preferred runner: #{request["default_runner"] || "none"}
              Preferred model: #{request["default_model"] || "none"}

              User request:
              #{request["prompt"]}
              """
            }
          ]
        }
      ],
      "text" => %{
        "format" => %{
          "type" => "json_schema",
          "name" => "plan_draft",
          "strict" => true,
          "schema" => plan_schema()
        }
      }
    }
  end

  defp instructions(%Agent{} = agent) do
    context =
      case agent.context do
        value when is_binary(value) and value != "" -> "\nAgent context:\n#{value}"
        _ -> ""
      end

    """
    Create one editable implementation plan for the user's request.
    Return only JSON that matches the provided schema.
    Use task IDs like t-01, t-api, or t-tests.
    Split the work into concrete coding tasks with clear instructions.
    Use depends_on only when one task truly blocks another.
    #{context}
    """
  end

  defp model(%Agent{} = agent) do
    MapUtils.trimmed_string(agent.model_settings, "model") ||
      @default_model
  end

  defp extract_draft(%{"draft" => draft}), do: normalize_draft(draft)
  defp extract_draft(%{"plan" => draft}), do: normalize_draft(draft)

  defp extract_draft(response) when is_map(response) do
    response
    |> output_texts()
    |> Enum.join("")
    |> Jason.decode()
    |> case do
      {:ok, %{"draft" => draft}} -> normalize_draft(draft)
      {:ok, %{"plan" => draft}} -> normalize_draft(draft)
      {:ok, draft} -> normalize_draft(draft)
      {:error, reason} -> {:error, {:invalid_plan_draft, [%{"path" => "/", "message" => "Planner returned invalid JSON: #{inspect(reason)}"}]}}
    end
  end

  defp extract_draft(_response),
    do: {:error, {:invalid_plan_draft, [%{"path" => "/", "message" => "Planner returned an invalid response"}]}}

  defp output_texts(response) do
    response
    |> Map.get("output", [])
    |> Enum.flat_map(fn
      %{"type" => "message", "content" => content} when is_list(content) ->
        Enum.flat_map(content, fn
          %{"type" => type, "text" => text} when type in ["output_text", "text"] and is_binary(text) -> [text]
          _ -> []
        end)

      _ ->
        []
    end)
  end

  defp normalize_draft(draft) when is_map(draft) do
    normalized = %{
      "schema_version" => Map.get(draft, "schema_version", "1"),
      "title" => string_field(draft, "title"),
      "intent" => string_field(draft, "intent"),
      "default_runner" => optional_string_field(draft, "default_runner"),
      "default_model" => optional_string_field(draft, "default_model"),
      "tasks" => normalize_tasks(Map.get(draft, "tasks"))
    }

    case validate_draft(normalized) do
      [] -> {:ok, MapUtils.drop_nil_values(normalized)}
      errors -> {:error, {:invalid_plan_draft, errors}}
    end
  end

  defp normalize_draft(_draft),
    do: {:error, {:invalid_plan_draft, [%{"path" => "/", "message" => "Plan draft must be an object"}]}}

  defp normalize_tasks(tasks) when is_list(tasks) do
    Enum.map(tasks, fn
      task when is_map(task) ->
        %{
          "id" => string_field(task, "id"),
          "title" => string_field(task, "title"),
          "instructions" => string_field(task, "instructions"),
          "labels" => normalize_labels(Map.get(task, "labels")),
          "depends_on" => normalize_string_list(Map.get(task, "depends_on")),
          "completion_gates" => normalize_string_list(Map.get(task, "completion_gates"))
        }

      _ ->
        %{}
    end)
  end

  defp normalize_tasks(_tasks), do: []

  defp normalize_labels(labels) when is_map(labels) do
    labels
    |> Enum.reduce(%{}, fn {key, value}, acc ->
      if is_binary(key) and is_binary(value), do: Map.put(acc, key, value), else: acc
    end)
  end

  defp normalize_labels(_labels), do: %{}

  defp normalize_string_list(values) when is_list(values) do
    values
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp normalize_string_list(_values), do: []

  defp validate_draft(draft) do
    []
    |> require_equal("/schema_version", draft["schema_version"], "1")
    |> require_present("/title", draft["title"])
    |> require_present("/intent", draft["intent"])
    |> validate_tasks(draft["tasks"])
  end

  defp validate_tasks(errors, []), do: [%{"path" => "/tasks", "message" => "At least one task is required"} | errors]

  defp validate_tasks(errors, tasks) do
    ids = Enum.map(tasks, &Map.get(&1, "id"))
    id_set = MapSet.new(ids)

    tasks
    |> Enum.with_index()
    |> Enum.reduce(errors, fn {task, index}, acc ->
      path = "/tasks/#{index}"

      acc
      |> require_match("#{path}/id", task["id"], ~r/^t-[a-z0-9-]+$/)
      |> require_present("#{path}/title", task["title"])
      |> require_present("#{path}/instructions", task["instructions"])
      |> validate_dependencies(path, task["depends_on"], id_set)
      |> validate_completion_gates(path, task["completion_gates"])
    end)
    |> validate_duplicate_ids(ids)
  end

  defp validate_dependencies(errors, path, dependencies, id_set) do
    Enum.reduce(dependencies, errors, fn dependency, acc ->
      if MapSet.member?(id_set, dependency) do
        acc
      else
        [%{"path" => "#{path}/depends_on", "message" => "Unknown dependency #{dependency}"} | acc]
      end
    end)
  end

  defp validate_completion_gates(errors, path, gates) do
    Enum.reduce(gates, errors, fn gate, acc ->
      if gate in @completion_gates do
        acc
      else
        [%{"path" => "#{path}/completion_gates", "message" => "Unknown completion gate #{gate}"} | acc]
      end
    end)
  end

  defp validate_duplicate_ids(errors, ids) do
    ids
    |> Enum.frequencies()
    |> Enum.reduce(errors, fn
      {id, count}, acc when count > 1 -> [%{"path" => "/tasks", "message" => "Duplicate task id #{id}"} | acc]
      _entry, acc -> acc
    end)
  end

  defp require_equal(errors, path, value, expected) do
    if value == expected, do: errors, else: [%{"path" => path, "message" => "Must be #{expected}"} | errors]
  end

  defp require_present(errors, path, value) do
    if is_binary(value) and String.trim(value) != "",
      do: errors,
      else: [%{"path" => path, "message" => "Required"} | errors]
  end

  defp require_match(errors, path, value, regex) do
    if is_binary(value) and Regex.match?(regex, value),
      do: errors,
      else: [%{"path" => path, "message" => "Invalid format"} | errors]
  end

  defp string_field(map, key), do: optional_string_field(map, key) || ""

  defp optional_string_field(map, key), do: MapUtils.trimmed_string(map, key)

  defp responses_url do
    Application.get_env(:symphony_elixir, :planner_plan_draft_responses_url, @responses_url)
  end

  defp req_options do
    Application.get_env(:symphony_elixir, :planner_plan_draft_req_options, [])
  end

  defp plan_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["schema_version", "title", "intent", "default_runner", "default_model", "tasks"],
      "properties" => %{
        "schema_version" => %{"type" => "string", "const" => "1"},
        "title" => %{"type" => "string"},
        "intent" => %{"type" => "string"},
        "default_runner" => %{
          "type" => ["string", "null"],
          "enum" => ["codex", "openclaw", "computer_use", "openai_compatible", nil]
        },
        "default_model" => %{"type" => ["string", "null"]},
        "tasks" => %{
          "type" => "array",
          "minItems" => 1,
          "items" => %{
            "type" => "object",
            "additionalProperties" => false,
            "required" => ["id", "title", "instructions", "labels", "depends_on", "completion_gates"],
            "properties" => %{
              "id" => %{"type" => "string", "pattern" => "^t-[a-z0-9-]+$"},
              "title" => %{"type" => "string"},
              "instructions" => %{"type" => "string"},
              "labels" => %{"type" => "object", "additionalProperties" => %{"type" => "string"}},
              "depends_on" => %{"type" => "array", "items" => %{"type" => "string"}},
              "completion_gates" => %{
                "type" => "array",
                "items" => %{"type" => "string", "enum" => @completion_gates}
              }
            }
          }
        }
      }
    }
  end
end
