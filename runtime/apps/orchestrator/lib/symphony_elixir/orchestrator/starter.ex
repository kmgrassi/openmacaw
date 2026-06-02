defmodule SymphonyElixir.Orchestrator.Starter do
  @moduledoc """
  Starts an orchestrator instance programmatically from a config map,
  bypassing the CLI entrypoint.

  This is used by the Launcher to spin up orchestrator instances without
  shelling out. Each orchestrator gets a generated WORKFLOW.md file and
  runs as a supervised process under the Launcher's DynamicSupervisor.

  ## Config map shape

      %{
        "port" => 4000,
        "repository" => "https://github.com/org/repo",
        "tracker" => %{"kind" => "database", ...},
        "workflow_template" => "coding",
        "max_concurrent_agents" => 5,
        ...
      }

  ## Config isolation

  Each orchestrator instance gets its own workflow file, registered in
  `Launcher.ConfigRegistry` keyed by process name and PID. The Orchestrator
  reads config via `Workflow.workflow_file_path/0`, which checks the registry
  first before falling back to global Application env. This allows multiple
  orchestrators to coexist in the same BEAM node with independent configs.
  """

  require Logger

  alias SymphonyElixir.ExecutionProfile

  @doc """
  Starts an orchestrator process under the given `DynamicSupervisor`.

  Returns `{:ok, pid}` where `pid` is the orchestrator GenServer.

  ## Options

  - `:supervisor` — the DynamicSupervisor to start under (required)
  - `:port` — port for this orchestrator's HTTP server (required)
  - `:config` — the raw config map from the Launcher API (required)
  - `:id` — orchestrator ID for naming (required)
  """
  @spec start(keyword()) :: {:ok, pid()} | {:error, term()}
  def start(opts) do
    supervisor = Keyword.fetch!(opts, :supervisor)
    port = Keyword.fetch!(opts, :port)
    config = opts |> Keyword.fetch!(:config) |> normalize_server_config(port)
    id = Keyword.fetch!(opts, :id)

    workflow_content = build_workflow_content(config)
    workflow_path = write_temp_workflow(id, workflow_content)

    name = :"orchestrator_#{id}"

    # Register per-instance workflow path in the config registry so this
    # orchestrator reads its own config rather than mutating global state.
    SymphonyElixir.Launcher.ConfigRegistry.put(name, workflow_path)

    child_spec = %{
      id: name,
      start: {SymphonyElixir.Orchestrator, :start_link, [[name: name, workflow_path: workflow_path, port: port]]},
      restart: :temporary
    }

    case DynamicSupervisor.start_child(supervisor, child_spec) do
      {:ok, pid} = ok ->
        # Also register by PID so callees can look up config from self()
        SymphonyElixir.Launcher.ConfigRegistry.put(pid, workflow_path)
        ok

      error ->
        SymphonyElixir.Launcher.ConfigRegistry.delete(name)
        error
    end
  end

  @doc """
  Builds WORKFLOW.md content from a config map.
  """
  @spec build_workflow_content(map()) :: String.t()
  def build_workflow_content(config) do
    tracker = Map.get(config, "tracker", %{})
    workspace = Map.get(config, "workspace", %{})
    agent = Map.get(config, "agent", %{})
    stored_agent = Map.get(config, "stored_agent", %{})

    yaml_map =
      %{}
      |> maybe_put("tracker", build_tracker_config(tracker))
      |> maybe_put("workspace", build_workspace_config(workspace, config))
      |> maybe_put("agent", build_agent_config(agent, config))
      |> maybe_put("codex", build_codex_config(config))
      |> maybe_put("server", build_server_config(config))
      |> maybe_put("stored_agent", build_stored_agent_config(stored_agent))
      |> maybe_put("execution_profile", build_execution_profile_config(config))

    yaml_content =
      yaml_map
      |> Enum.map(fn {k, v} -> yaml_encode_section(k, v) end)
      |> Enum.join("\n")

    prompt = Map.get(config, "prompt", default_prompt())

    "---\n#{yaml_content}---\n#{prompt}\n"
  end

  defp build_tracker_config(tracker) do
    tracker
    |> Map.take(["kind", "api_key", "project_slug", "endpoint", "table", "repository"])
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
    |> Map.new()
  end

  defp build_workspace_config(workspace, config) do
    workspace
    |> Map.put("repository", Map.get(config, "repository", Map.get(workspace, "repository")))
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
    |> Map.new()
  end

  defp build_agent_config(agent, config) do
    agent
    |> maybe_put_from(config, "max_concurrent_agents")
    |> Enum.reject(fn {_k, v} -> is_nil(v) end)
    |> Map.new()
  end

  defp build_codex_config(config) do
    codex =
      config
      |> Map.get("codex", %{})
      |> Map.take([
        "command",
        "model",
        "model_provider",
        "approval_policy",
        "thread_sandbox",
        "turn_timeout_ms",
        "read_timeout_ms",
        "stall_timeout_ms"
      ])

    codex
    |> maybe_put_new("model", config |> configured_model() |> normalize_codex_model())
    |> maybe_put_new("model_provider", configured_model_provider(config))
    |> maybe_put_new("command", derived_codex_command(config))
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
    |> Map.new()
  end

  defp derived_codex_command(config) do
    config
    |> configured_model()
    |> normalize_codex_model()
    |> case do
      nil -> nil
      model -> "codex --model #{model} app-server"
    end
  end

  defp configured_model(config) do
    runner_model(config) || stored_agent_model(config)
  end

  defp configured_model_provider(config) do
    runner_model_provider(config) || stored_agent_model_provider(config)
  end

  defp runner_model(%{"runners" => runners}) when is_list(runners) do
    runners
    |> Enum.find_value(fn
      %{"model" => model} when is_binary(model) -> model
      _ -> nil
    end)
  end

  defp runner_model(_), do: nil

  defp runner_model_provider(%{"runners" => runners}) when is_list(runners) do
    runners
    |> Enum.find_value(fn
      %{"provider" => provider} when is_binary(provider) -> provider
      %{"model" => model} when is_binary(model) -> provider_from_model(model)
      _ -> nil
    end)
  end

  defp runner_model_provider(_), do: nil

  defp stored_agent_model(config) do
    model_settings = get_in(config, ["stored_agent", "model_settings"]) || %{}

    cond do
      is_binary(model_settings["primary"]) -> model_settings["primary"]
      is_binary(model_settings["model"]) -> model_settings["model"]
      true -> nil
    end
  end

  defp stored_agent_model_provider(config) do
    model_settings = get_in(config, ["stored_agent", "model_settings"]) || %{}

    cond do
      is_binary(model_settings["provider"]) -> model_settings["provider"]
      is_binary(model_settings["primary"]) -> provider_from_model(model_settings["primary"])
      is_binary(model_settings["model"]) -> provider_from_model(model_settings["model"])
      true -> nil
    end
  end

  defp normalize_codex_model(model) when is_binary(model) do
    model
    |> String.trim()
    |> case do
      "" -> nil
      value -> value |> String.split("/") |> List.last()
    end
  end

  defp normalize_codex_model(_), do: nil

  defp provider_from_model(model) when is_binary(model) do
    case String.split(model, "/", parts: 2) do
      [provider, _model] when provider != "" -> provider
      _ -> nil
    end
  end

  defp provider_from_model(_), do: nil

  defp build_stored_agent_config(stored_agent) when is_map(stored_agent) do
    stored_agent
    |> Map.take(["id", "name", "workspace_id", "project_id", "type", "tool_policy"])
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
    |> Map.new()
  end

  defp build_stored_agent_config(_), do: %{}

  defp build_server_config(config) do
    config
    |> Map.get("server", %{})
    |> ensure_map()
    |> Map.take(["host", "port"])
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
    |> Map.new()
  end

  defp build_execution_profile_config(config) do
    case ExecutionProfile.normalize_from_config(config) do
      {:ok, profile} -> profile
      {:error, _reason} -> %{}
    end
  end

  defp normalize_server_config(config, port) do
    Map.put(
      config,
      "server",
      Map.merge(%{"host" => "127.0.0.1", "port" => port}, config |> Map.get("server", %{}) |> ensure_map())
    )
  end

  defp ensure_map(value) when is_map(value), do: value
  defp ensure_map(_), do: %{}

  defp maybe_put(map, _key, value) when value == %{}, do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp maybe_put_new(map, _key, value) when value in [nil, ""], do: map
  defp maybe_put_new(map, key, value), do: Map.put_new(map, key, value)

  defp maybe_put_from(map, source, key) do
    case Map.get(source, key) do
      nil -> map
      val -> Map.put(map, key, val)
    end
  end

  defp yaml_encode_section(key, value) when is_map(value) do
    lines =
      Enum.map(value, fn {k, v} -> yaml_encode_entry(k, v, 2) end)

    "#{key}:\n#{Enum.join(lines, "\n")}\n"
  end

  defp yaml_encode_entry(key, value, indent) when is_map(value) do
    nested =
      value
      |> Enum.map(fn {k, v} -> yaml_encode_entry(k, v, indent + 2) end)
      |> Enum.join("\n")

    "#{String.duplicate(" ", indent)}#{key}:\n#{nested}"
  end

  defp yaml_encode_entry(key, value, indent) do
    "#{String.duplicate(" ", indent)}#{key}: #{yaml_encode_value(value)}"
  end

  defp yaml_encode_value(v) when is_binary(v), do: v
  defp yaml_encode_value(v) when is_integer(v), do: Integer.to_string(v)
  defp yaml_encode_value(v) when is_float(v), do: Float.to_string(v)
  defp yaml_encode_value(v) when is_boolean(v), do: Atom.to_string(v)
  defp yaml_encode_value(nil), do: "null"
  defp yaml_encode_value(v) when is_list(v), do: "[" <> Enum.map_join(v, ", ", &yaml_encode_value/1) <> "]"
  defp yaml_encode_value(v), do: inspect(v)

  @doc false
  @spec write_temp_workflow(String.t(), String.t()) :: Path.t()
  def write_temp_workflow(id, content) do
    dir = Path.join(System.tmp_dir!(), "symphony_launcher")
    File.mkdir_p!(dir)
    path = Path.join(dir, "WORKFLOW_#{id}.md")
    File.write!(path, content)
    path
  end

  defp default_prompt do
    """
    You are working on an issue.

    Identifier: {{ issue.identifier }}
    Title: {{ issue.title }}

    Body:
    {% if issue.description %}
    {{ issue.description }}
    {% else %}
    No description provided.
    {% endif %}
    """
  end
end
