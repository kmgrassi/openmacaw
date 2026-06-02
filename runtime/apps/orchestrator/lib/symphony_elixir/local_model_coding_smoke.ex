defmodule SymphonyElixir.LocalModelCodingSmoke do
  @moduledoc """
  Manual PR4 smoke harness for local OpenAI-compatible coding models.

  The harness creates a disposable workspace, asks the configured local model to
  read `message.txt` through `shell.exec`, asks it to call `apply_patch`, asks it
  to verify the edit through `shell.exec`, executes both tools through
  runtime-owned code, and then requires a final assistant response. It is a
  narrow manual flow for proving the local-model coding path before the
  production `LocalModelCoding` runner is wired into platform routing.
  """

  alias SymphonyElixir.{PathSafety, Provider.OpenAICompatible, ToolSpec}

  @default_base_url "http://127.0.0.1:11434/v1"
  @default_model "qwen2.5-coder:latest"
  @default_api_key "ollama"
  @default_max_iterations 6
  @default_command_timeout_ms 15_000
  @workspace_prefix "symphony-local-model-coding-smoke-"
  @expected_patch """
  diff --git a/message.txt b/message.txt
  --- a/message.txt
  +++ b/message.txt
  @@ -1 +1 @@
  -before
  +after
  """

  @type config :: %{
          required(:base_url) => String.t(),
          required(:model) => String.t(),
          required(:api_key) => String.t(),
          required(:workspace) => String.t() | nil,
          required(:max_iterations) => pos_integer(),
          required(:command_timeout_ms) => pos_integer(),
          optional(:req_options) => keyword()
        }

  @type summary :: %{
          required(:provider) => String.t(),
          required(:model) => String.t(),
          required(:workspace) => String.t(),
          required(:output_text) => String.t(),
          required(:tool_calls) => [String.t()],
          required(:events) => [String.t()]
        }

  @spec default_config_from_env() :: config()
  def default_config_from_env do
    %{
      base_url:
        env("SYMPHONY_LOCAL_MODEL_BASE_URL") ||
          env("OLLAMA_OPENAI_BASE_URL") ||
          ollama_openai_base_url(env("OLLAMA_BASE_URL")) ||
          @default_base_url,
      model: env("SYMPHONY_LOCAL_MODEL_NAME") || env("OLLAMA_MODEL") || @default_model,
      api_key: env("SYMPHONY_LOCAL_MODEL_API_KEY") || env("OLLAMA_API_KEY") || @default_api_key,
      workspace: env("SYMPHONY_LOCAL_MODEL_CODING_SMOKE_WORKSPACE"),
      max_iterations: integer_env("SYMPHONY_LOCAL_MODEL_CODING_SMOKE_MAX_ITERATIONS", @default_max_iterations),
      command_timeout_ms: integer_env("SYMPHONY_LOCAL_MODEL_CODING_SMOKE_COMMAND_TIMEOUT_MS", @default_command_timeout_ms)
    }
  end

  @spec run(keyword()) :: {:ok, summary()} | {:error, term()}
  def run(opts \\ []) when is_list(opts) do
    config =
      default_config_from_env()
      |> Map.merge(Map.new(Keyword.get(opts, :config, %{})))
      |> maybe_put_req_options(Keyword.get(opts, :req_options))

    with :ok <- validate_config(config),
         {:ok, workspace} <- prepare_workspace(config.workspace),
         {:ok, summary} <- run_loop(config, workspace) do
      {:ok, summary}
    end
  end

  @spec ollama_openai_base_url(String.t() | nil) :: String.t() | nil
  def ollama_openai_base_url(nil), do: nil

  def ollama_openai_base_url(base_url) when is_binary(base_url) do
    base_url = String.trim_trailing(base_url, "/")

    if String.ends_with?(base_url, "/v1") do
      base_url
    else
      base_url <> "/v1"
    end
  end

  defp run_loop(config, workspace) do
    profile = %{
      "base_url" => config.base_url,
      "model" => config.model,
      "api_key" => config.api_key,
      "temperature" => 0,
      "max_tokens" => 512,
      "tool_choice" => "auto"
    }

    state = %{
      messages: initial_messages(),
      events: ["run.started"],
      tool_calls: [],
      workspace: workspace,
      final_result: nil
    }

    iterate(profile, config, state, 1)
  end

  defp iterate(_profile, config, state, iteration) when iteration > config.max_iterations do
    {:error, smoke_error(:provider_parsing, {:max_iterations_exceeded, config.max_iterations, state.tool_calls})}
  end

  defp iterate(profile, config, state, iteration) do
    state = %{state | events: state.events ++ ["provider_dispatch_started"]}

    with {:ok, result} <- call_provider(profile, state.messages, config),
         state = %{state | events: state.events ++ ["provider_dispatch_completed"]},
         {:ok, state} <- handle_provider_result(result, profile, config, state) do
      if state.final_result do
        validate_summary(state, state.final_result)
      else
        iterate(profile, config, state, iteration + 1)
      end
    end
  end

  defp call_provider(profile, messages, config) do
    tools = ToolSpec.to_provider_format(tool_definitions(), "openai_compatible")

    case OpenAICompatible.start_turn(profile, messages, tools, req_options: Map.get(config, :req_options, [])) do
      {:ok, result} -> {:ok, result}
      {:error, reason} -> {:error, smoke_error(:provider_dispatch, reason)}
    end
  end

  defp handle_provider_result(%{tool_calls: tool_calls} = result, _profile, config, state) when is_list(tool_calls) and tool_calls != [] do
    with {:ok, tool_messages, event_names, tool_names} <- execute_tool_calls(tool_calls, state.workspace, config) do
      {:ok,
       %{
         state
         | messages: state.messages ++ [assistant_tool_call_message(result)] ++ tool_messages,
           events: state.events ++ provider_event_names(result) ++ event_names,
           tool_calls: state.tool_calls ++ tool_names
       }}
    end
  end

  defp handle_provider_result(%{output_text: output_text} = result, _profile, _config, state) when is_binary(output_text) and output_text != "" do
    {:ok, %{state | events: state.events ++ provider_event_names(result), final_result: result}}
  end

  defp handle_provider_result(result, _profile, _config, _state) do
    {:error, smoke_error(:provider_parsing, {:empty_turn, Map.take(result, [:finish_reason, :tool_calls, :output_text])})}
  end

  defp execute_tool_calls(tool_calls, workspace, config) do
    Enum.reduce_while(tool_calls, {:ok, [], [], []}, fn call, {:ok, messages, events, names} ->
      case execute_tool_call(call, workspace, config) do
        {:ok, tool_result, event_names} ->
          tool_message = %{
            "role" => "tool",
            "tool_call_id" => tool_call_id(call),
            "content" => Jason.encode!(tool_result)
          }

          {:cont, {:ok, messages ++ [tool_message], events ++ event_names, names ++ [call.name]}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
  end

  defp execute_tool_call(%{name: "apply_patch", arguments: arguments}, workspace, _config) when is_map(arguments) do
    with {:ok, patch} <- required_argument(arguments, "patch"),
         {:ok, changed_files} <- apply_patch(workspace, patch) do
      {:ok,
       %{
         "status" => "completed",
         "changed_files" => changed_files
       }, ["tool_call_started", "patch_apply_begin", "patch_apply_end", "tool_call_completed"]}
    else
      {:error, {:invalid_tool_arguments, _message} = reason} -> {:error, smoke_error(:tool_schema_translation, reason)}
      {:error, reason} -> {:error, smoke_error(:execution_policy, reason)}
    end
  end

  defp execute_tool_call(%{name: "shell.exec", arguments: arguments}, workspace, config) when is_map(arguments) do
    with {:ok, command} <- argv_argument(arguments),
         {:ok, cwd} <- command_cwd(workspace, Map.get(arguments, "cwd")),
         {:ok, result} <- shell_exec(cwd, command, config.command_timeout_ms),
         :ok <- require_successful_command(result) do
      {:ok, result, command_events(result)}
    else
      {:error, {:invalid_tool_arguments, _message} = reason} -> {:error, smoke_error(:tool_schema_translation, reason)}
      {:error, reason} -> {:error, smoke_error(:execution_policy, reason)}
    end
  end

  defp execute_tool_call(%{name: name}, _workspace, _config), do: {:error, smoke_error(:tool_schema_translation, {:unsupported_smoke_tool, name})}

  defp apply_patch(workspace, patch) do
    patch_file = Path.join(workspace, ".local_model_coding_smoke.patch")

    with :ok <- File.write(patch_file, patch),
         {:ok, changed_files} <- changed_files_from_patch(workspace, patch),
         {:ok, _check_output} <- git_apply(workspace, ["apply", "--check", patch_file]),
         {:ok, _apply_output} <- git_apply(workspace, ["apply", patch_file]) do
      File.rm(patch_file)
      {:ok, changed_files}
    else
      {:error, reason} ->
        File.rm(patch_file)
        {:error, {:apply_patch_failed, reason}}
    end
  end

  defp changed_files_from_patch(workspace, patch) do
    files =
      Regex.scan(~r/^diff --git a\/(.+?) b\/(.+?)$/m, patch)
      |> Enum.map(fn [_line, _from, to] -> to end)
      |> Enum.uniq()

    cond do
      files == [] ->
        {:error, :patch_has_no_changed_files}

      true ->
        with :ok <- Enum.reduce_while(files, :ok, &validate_workspace_relative_path(workspace, &1, &2)) do
          {:ok, files}
        end
    end
  end

  defp validate_workspace_relative_path(workspace, path, :ok) do
    with false <- Path.type(path) == :absolute,
         true <- safe_relative_path?(path),
         {:ok, canonical_path} <- PathSafety.canonicalize(Path.join(workspace, path)),
         :ok <- ensure_inside_workspace(workspace, canonical_path) do
      {:cont, :ok}
    else
      _ -> {:halt, {:error, {:unsafe_patch_path, path}}}
    end
  end

  defp git_apply(workspace, args) do
    case System.cmd("git", args, cd: workspace, stderr_to_stdout: true) do
      {output, 0} -> {:ok, output}
      {output, status} -> {:error, %{command: ["git" | args], status: status, output: output}}
    end
  end

  defp shell_exec(cwd, [executable | args] = command, timeout_ms) do
    if shell_executable_safe?(executable) do
      executable_path = executable_path(cwd, executable)

      task =
        Task.async(fn ->
          safe_system_cmd(executable_path, args, cwd)
        end)

      case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
        {:ok, {:ok, {output, status}}} ->
          {:ok,
           %{
             "status" => if(status == 0, do: "completed", else: "failed"),
             "exit_code" => status,
             "command" => command,
             "output" => output
           }}

        {:ok, {:error, reason}} ->
          {:error, {:shell_exec_failed, reason}}

        {:exit, reason} ->
          {:error, {:shell_exec_failed, {:task_exit, reason}}}

        nil ->
          {:error, {:shell_exec_failed, :command_timeout}}
      end
    else
      {:error, {:shell_exec_failed, {:unsafe_executable, executable}}}
    end
  end

  defp shell_exec(_cwd, _command, _timeout_ms), do: {:error, {:shell_exec_failed, :empty_command}}

  defp executable_path(cwd, "./" <> _rest = executable), do: Path.join(cwd, executable)
  defp executable_path(cwd, "../" <> _rest = executable), do: Path.join(cwd, executable)
  defp executable_path(_cwd, executable), do: executable

  defp safe_system_cmd(executable, args, cwd) do
    {:ok, System.cmd(executable, args, cd: cwd, stderr_to_stdout: true)}
  rescue
    error in ErlangError -> {:error, {:system_cmd_error, error.original}}
    error -> {:error, {:system_cmd_exception, Exception.message(error)}}
  catch
    kind, reason -> {:error, {:system_cmd_catch, kind, reason}}
  end

  defp require_successful_command(%{"exit_code" => 0}), do: :ok
  defp require_successful_command(result), do: {:error, {:shell_exec_failed, result}}

  defp validate_summary(state, result) do
    output_text = result |> Map.get(:output_text, "") |> to_string() |> String.trim()
    shell_exec_count = Enum.count(state.tool_calls, &(&1 == "shell.exec"))

    cond do
      shell_exec_count < 2 ->
        {:error, smoke_error(:event_persistence, :missing_shell_exec_read_or_verify_call)}

      "apply_patch" not in state.tool_calls ->
        {:error, smoke_error(:event_persistence, :missing_apply_patch_call)}

      missing_required_events(state.events) != [] ->
        {:error, smoke_error(:event_persistence, {:missing_events, missing_required_events(state.events)})}

      output_text == "" ->
        {:error, smoke_error(:provider_parsing, :empty_final_output)}

      true ->
        {:ok,
         %{
           provider: Map.get(result, :provider),
           model: Map.get(result, :model),
           workspace: state.workspace,
           output_text: output_text,
           tool_calls: state.tool_calls,
           events: Enum.uniq(state.events ++ ["turn_completed", "final_response"])
         }}
    end
  end

  defp assistant_tool_call_message(%{raw: %{"choices" => [%{"message" => message} | _]}}) when is_map(message) do
    Map.take(message, ["role", "content", "tool_calls"])
  end

  defp assistant_tool_call_message(result) do
    %{
      "role" => "assistant",
      "content" => Map.get(result, :output_text, ""),
      "tool_calls" =>
        result
        |> Map.get(:tool_calls, [])
        |> Enum.map(fn call ->
          %{
            "id" => tool_call_id(call),
            "type" => "function",
            "function" => %{
              "name" => call.name,
              "arguments" => Jason.encode!(call.arguments)
            }
          }
        end)
    }
  end

  defp provider_event_names(%{events: events}) when is_list(events) do
    Enum.flat_map(events, fn
      %{event: :notification, payload: %{"method" => "message.delta"}} -> ["message.delta"]
      %{event: :notification, payload: %{"method" => method}} when is_binary(method) -> [method]
      %{event: :tool_call_started} -> ["tool_call_started"]
      %{event: :tool_call_completed} -> ["tool_call_completed"]
      %{event: :turn_completed} -> ["provider_turn_completed"]
      %{event: event} when is_atom(event) -> [Atom.to_string(event)]
      _event -> []
    end)
  end

  defp provider_event_names(_result), do: []

  defp tool_call_id(%{id: id}) when is_binary(id) and id != "", do: id
  defp tool_call_id(%{name: name}), do: "local-smoke-#{name}"

  defp argv_argument(arguments) do
    case Map.get(arguments, "argv") do
      command when is_list(command) and command != [] -> validate_command_argument(command)
      _ -> {:error, {:invalid_tool_arguments, "shell.exec.argv must be a non-empty string array"}}
    end
  end

  defp validate_command_argument(command) do
    if Enum.all?(command, &is_binary/1) do
      {:ok, command}
    else
      {:error, {:invalid_tool_arguments, "shell.exec.argv must be a non-empty string array"}}
    end
  end

  defp command_events(%{"output" => output}) when is_binary(output) and output != "" do
    ["tool_call_started", "command_started", "command_output_delta", "command_completed", "tool_call_completed"]
  end

  defp command_events(_result), do: ["tool_call_started", "command_started", "command_completed", "tool_call_completed"]

  defp command_cwd(workspace, nil), do: {:ok, workspace}
  defp command_cwd(workspace, ""), do: {:ok, workspace}

  defp command_cwd(workspace, cwd) when is_binary(cwd) do
    with false <- Path.type(cwd) == :absolute,
         true <- safe_relative_path?(cwd),
         {:ok, canonical_cwd} <- PathSafety.canonicalize(Path.join(workspace, cwd)),
         :ok <- ensure_inside_workspace(workspace, canonical_cwd),
         true <- File.dir?(canonical_cwd) do
      {:ok, canonical_cwd}
    else
      _ -> {:error, {:unsafe_command_cwd, cwd}}
    end
  end

  defp command_cwd(_workspace, cwd), do: {:error, {:unsafe_command_cwd, cwd}}

  defp ensure_inside_workspace(workspace, path) do
    workspace = Path.expand(workspace)
    workspace_prefix = workspace <> "/"

    if path == workspace or String.starts_with?(path, workspace_prefix) do
      :ok
    else
      {:error, {:path_outside_workspace, path}}
    end
  end

  defp safe_relative_path?(path) do
    path
    |> Path.split()
    |> Enum.all?(fn segment -> segment not in ["..", ".", ""] and not String.contains?(segment, <<0>>) end)
  end

  defp shell_executable_safe?(executable) do
    is_binary(executable) and executable != "" and not String.contains?(executable, <<0>>)
  end

  defp required_argument(arguments, key) do
    case Map.get(arguments, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:invalid_tool_arguments, "#{key} must be a non-empty string"}}
    end
  end

  defp initial_messages do
    [
      %{
        "role" => "system",
        "content" => """
        You are running a local coding smoke test. Use tool calls, not prose, for workspace actions.

        First call shell.exec with argv ["cat", "message.txt"] to read the fixture file. After the read result is
        returned, call apply_patch with the exact patch from the user message. After the patch result is returned,
        call shell.exec with argv ["./test.sh"]. After the verification result is returned, answer with one short
        sentence that says whether the smoke passed.
        """
      },
      %{
        "role" => "user",
        "content" => """
        Prove local model coding tool execution.

        First call shell.exec with:
        {"argv":["cat","message.txt"]}

        Call apply_patch with this exact patch:

        #{@expected_patch}

        Then call shell.exec with:
        {"argv":["./test.sh"]}
        """
      }
    ]
  end

  defp tool_definitions do
    [
      %{
        name: "apply_patch",
        description: "Apply a unified git patch inside the disposable smoke workspace.",
        parameters_schema: %{
          "type" => "object",
          "required" => ["patch"],
          "additionalProperties" => false,
          "properties" => %{
            "patch" => %{"type" => "string", "description" => "Unified git patch text."}
          }
        }
      },
      %{
        name: "shell.exec",
        description: "Run an argv command inside the disposable smoke workspace.",
        parameters_schema: %{
          "type" => "object",
          "required" => ["argv"],
          "additionalProperties" => false,
          "properties" => %{
            "argv" => %{"type" => "array", "items" => %{"type" => "string"}, "minItems" => 1},
            "cwd" => %{"type" => "string", "description" => "Optional workspace-relative directory."}
          }
        }
      }
    ]
  end

  defp prepare_workspace(nil) do
    System.tmp_dir!()
    |> Path.join(@workspace_prefix <> unique_suffix())
    |> prepare_workspace()
  end

  defp prepare_workspace(workspace) when is_binary(workspace) do
    workspace = Path.expand(workspace)

    with :ok <- File.mkdir_p(workspace),
         :ok <- write_fixture_files(workspace),
         {:ok, _output} <- git_apply(workspace, ["init", "--quiet"]),
         {:ok, canonical_workspace} <- PathSafety.canonicalize(workspace) do
      {:ok, canonical_workspace}
    else
      {:error, reason} -> {:error, {:workspace_prepare_failed, reason}}
    end
  end

  defp write_fixture_files(workspace) do
    test_script = """
    #!/bin/sh
    set -eu
    test "$(cat message.txt)" = "after"
    """

    with :ok <- File.write(Path.join(workspace, "message.txt"), "before\n"),
         :ok <- File.write(Path.join(workspace, "test.sh"), test_script),
         :ok <- File.chmod(Path.join(workspace, "test.sh"), 0o755) do
      :ok
    end
  end

  defp validate_config(%{base_url: base_url, model: model, api_key: api_key, max_iterations: max_iterations, command_timeout_ms: command_timeout_ms})
       when is_binary(base_url) and is_binary(model) and is_binary(api_key) and is_integer(max_iterations) and is_integer(command_timeout_ms) do
    cond do
      String.trim(base_url) == "" -> {:error, smoke_error(:model_selection, {:missing_requirement, :base_url})}
      String.trim(model) == "" -> {:error, smoke_error(:model_selection, {:missing_requirement, :model})}
      String.trim(api_key) == "" -> {:error, smoke_error(:model_selection, {:missing_requirement, :api_key})}
      max_iterations < 1 -> {:error, smoke_error(:model_selection, {:invalid_requirement, :max_iterations})}
      command_timeout_ms < 1 -> {:error, smoke_error(:model_selection, {:invalid_requirement, :command_timeout_ms})}
      true -> :ok
    end
  end

  defp validate_config(_config), do: {:error, smoke_error(:model_selection, :invalid_local_model_coding_smoke_config)}

  defp missing_required_events(events) do
    [
      "provider_dispatch_started",
      "provider_dispatch_completed",
      "tool_call_started",
      "command_output_delta",
      "patch_apply_begin",
      "patch_apply_end",
      "tool_call_completed"
    ] -- Enum.uniq(events)
  end

  defp smoke_error(phase, reason), do: {:local_model_coding_smoke_failed, {phase, reason}}

  defp maybe_put_req_options(config, nil), do: config
  defp maybe_put_req_options(config, req_options), do: Map.put(config, :req_options, req_options)

  defp integer_env(key, default) do
    case env(key) do
      nil ->
        default

      value ->
        case Integer.parse(value) do
          {integer, ""} -> integer
          _ -> default
        end
    end
  end

  defp env(key) do
    case System.get_env(key) do
      nil -> nil
      value -> value |> String.trim() |> blank_to_nil()
    end
  end

  defp blank_to_nil(""), do: nil
  defp blank_to_nil(value), do: value

  defp unique_suffix do
    System.unique_integer([:positive])
    |> Integer.to_string(36)
  end
end
