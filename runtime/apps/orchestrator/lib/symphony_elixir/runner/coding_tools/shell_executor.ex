defmodule SymphonyElixir.Runner.CodingTools.ShellExecutor do
  @moduledoc """
  Workspace-scoped executor for the local coding `shell.exec` tool.

  The executor accepts argv input, resolves cwd under a workspace root, filters
  environment variables through an explicit allowlist, streams stdout/stderr
  deltas, enforces output and time limits, and supports cooperative
  cancellation via `cancel/1`.
  """

  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.Runner.Contract

  @default_timeout_ms 30_000
  @default_output_limit_bytes 64_000
  @default_env_allowlist ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TERM"]
  @env_name_regex ~r/^[A-Za-z_][A-Za-z0-9_]*$/

  @type input :: %{
          optional(String.t()) => term(),
          optional(atom()) => term()
        }

  @type options :: %{
          required(:workspace_root) => Path.t(),
          optional(:command_id) => String.t(),
          optional(:timeout_ms) => pos_integer(),
          optional(:output_limit_bytes) => pos_integer(),
          optional(:env_allowlist) => [String.t()],
          optional(:on_event) => (map() -> term()),
          optional(:approval_callback) => (map() -> :ok | {:error, term()})
        }

  @type result :: %{
          required(String.t()) => term()
        }

  @doc """
  Runs a workspace-scoped command from `shell.exec`-style input.
  """
  @spec run(input(), options()) :: {:ok, result()} | {:error, term()}
  def run(input, opts) when is_map(input) and is_map(opts) do
    command_id = command_id(input, opts)

    with {:ok, argv} <- argv(input),
         {:ok, workspace_root} <- workspace_root(opts),
         {:ok, cwd} <- cwd(input, workspace_root),
         {:ok, executable} <- resolve_executable(argv, cwd, workspace_root),
         :ok <- approve(input, opts, command_id, argv, cwd),
         {:ok, temp_dir, stdout_path, stderr_path, pidfile} <- create_io_paths(command_id),
         {:ok, result} <- do_run(input, opts, command_id, [executable | tl(argv)], cwd, temp_dir, stdout_path, stderr_path, pidfile) do
      {:ok, result}
    end
  end

  @doc """
  Cancels a running command by command id or command pidfile.

  The command id is the same id passed in `opts.command_id` or `input.id`.
  """
  @spec cancel(String.t()) :: :ok | {:error, term()}
  def cancel(command_id) when is_binary(command_id) do
    pidfile = pidfile_path(command_id)
    File.write(cancel_marker_path(command_id), "cancelled")

    with {:ok, pid} <- read_child_pid(pidfile) do
      kill_child(pid)
    end
  end

  def cancel(_command_id), do: {:error, :invalid_command_id}

  defp do_run(input, opts, command_id, argv, cwd, temp_dir, stdout_path, stderr_path, pidfile) do
    output_limit = positive_integer(map_value(opts, :output_limit_bytes), @default_output_limit_bytes)
    timeout_ms = positive_integer(map_value(opts, :timeout_ms), @default_timeout_ms)

    emit(opts, :command_started, %{
      "command_id" => command_id,
      "argv" => argv,
      "cwd" => cwd,
      "timeout_ms" => timeout_ms,
      "output_limit_bytes" => output_limit,
      "sandbox_policy" => map_value(opts, :sandbox_policy) || %{"type" => "workspaceWrite"}
    })

    started_at = monotonic_ms()

    port =
      Port.open({:spawn_executable, shell_path()}, [
        :binary,
        :exit_status,
        {:cd, cwd},
        {:args, ["-c", shell_wrapper(), "shell-exec", stdout_path, stderr_path, pidfile | argv]},
        {:env, env_entries(input, opts)}
      ])

    state = %{
      command_id: command_id,
      port: port,
      pidfile: pidfile,
      stdout_path: stdout_path,
      stderr_path: stderr_path,
      stdout_offset: 0,
      stderr_offset: 0,
      stdout: "",
      stderr: "",
      output: "",
      captured_bytes: 0,
      output_limit_bytes: output_limit,
      truncated?: false,
      cancelled?: false,
      timed_out?: false,
      exit_status: nil,
      started_at: started_at,
      deadline_ms: started_at + timeout_ms,
      opts: opts
    }

    result =
      receive_loop(state)
      |> Map.put(:duration_ms, max(monotonic_ms() - started_at, 0))
      |> result_from_state()

    File.rm_rf(temp_dir)
    {:ok, result}
  end

  defp receive_loop(state) do
    receive do
      {port, {:exit_status, status}} when port == state.port ->
        state
        |> poll_outputs()
        |> Map.put(:exit_status, status)
        |> mark_cancelled_from_file()

      {:shell_exec_cancel, command_id} when command_id == state.command_id ->
        cancel_running_command(state)
        receive_loop(%{state | cancelled?: true})
    after
      25 ->
        state = poll_outputs(state)

        if monotonic_ms() >= state.deadline_ms do
          cancel_running_command(state)
          %{state | timed_out?: true}
        else
          receive_loop(state)
        end
    end
  end

  defp capture_output(%{captured_bytes: captured, output_limit_bytes: limit} = state, stream, chunk) do
    remaining = max(limit - captured, 0)
    captured_chunk = binary_part(chunk, 0, min(byte_size(chunk), remaining))
    truncated? = state.truncated? or byte_size(chunk) > remaining

    if captured_chunk != "" do
      emit(state.opts, :command_output_delta, %{
        "command_id" => state.command_id,
        "stream" => stream,
        "text" => captured_chunk
      })
    end

    state
    |> Map.update!(String.to_existing_atom(stream), &(&1 <> captured_chunk))
    |> Map.update!(:output, &(&1 <> captured_chunk))
    |> Map.put(:captured_bytes, captured + byte_size(captured_chunk))
    |> Map.put(:truncated?, truncated?)
  end

  defp poll_outputs(state) do
    state
    |> poll_output("stdout", state.stdout_path, state.stdout_offset)
    |> poll_output("stderr", state.stderr_path, state.stderr_offset)
  end

  defp poll_output(state, stream, path, offset) do
    case File.read(path) do
      {:ok, contents} ->
        size = byte_size(contents)

        if size > offset do
          chunk = binary_part(contents, offset, size - offset)

          state
          |> capture_output(stream, chunk)
          |> Map.put(String.to_existing_atom(stream <> "_offset"), size)
        else
          state
        end

      {:error, _reason} ->
        state
    end
  end

  defp mark_cancelled_from_file(state) do
    if File.exists?(cancel_marker_path(state.command_id)) do
      %{state | cancelled?: true}
    else
      state
    end
  end

  defp result_from_state(state) do
    success? = state.exit_status == 0 and not state.timed_out? and not state.cancelled?

    result =
      %{
        "type" => "tool_call_result",
        "tool_name" => "shell.exec",
        "command_id" => state.command_id,
        "success" => success?,
        "exit_status" => state.exit_status,
        "stdout" => state.stdout,
        "stderr" => state.stderr,
        "output" => state.output,
        "output_truncated" => state.truncated?,
        "timed_out" => state.timed_out?,
        "cancelled" => state.cancelled?,
        "duration_ms" => state.duration_ms
      }

    emit(state.opts, :command_completed, Map.drop(result, ["stdout", "stderr", "output"]))
    result
  end

  defp cancel_running_command(state) do
    with {:ok, pid} <- read_child_pid(state.pidfile) do
      kill_child(pid)
    end

    port_close(state.port)
  end

  defp port_close(port) do
    Port.close(port)
  catch
    :error, _reason -> :ok
  end

  defp kill_child(pid) when is_integer(pid) and pid > 0 do
    kill_descendants(pid)

    case System.cmd("kill", ["-TERM", Integer.to_string(pid)], stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {_output, _status} -> :ok
    end
  end

  defp kill_descendants(pid) do
    with pgrep when is_binary(pgrep) <- System.find_executable("pgrep"),
         {output, 0} <- System.cmd(pgrep, ["-P", Integer.to_string(pid)], stderr_to_stdout: true) do
      output
      |> String.split()
      |> Enum.each(fn child_pid ->
        with {child, ""} <- Integer.parse(child_pid) do
          kill_descendants(child)
          System.cmd("kill", ["-TERM", Integer.to_string(child)], stderr_to_stdout: true)
        end
      end)
    else
      _ -> :ok
    end
  end

  defp read_child_pid(pidfile) do
    with {:ok, contents} <- File.read(pidfile),
         {pid, ""} <- Integer.parse(String.trim(contents)) do
      {:ok, pid}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_child_pid}
    end
  end

  defp argv(input) do
    case map_value(input, :argv) do
      [command | _] = argv when is_binary(command) ->
        if Enum.all?(argv, &is_binary/1), do: {:ok, argv}, else: {:error, {:invalid_argv, :non_binary_argument}}

      [] ->
        {:error, {:invalid_argv, :empty}}

      _other ->
        {:error, {:invalid_argv, :expected_string_list}}
    end
  end

  defp resolve_executable([command | _argv], cwd, workspace_root) do
    cond do
      String.contains?(command, <<0>>) ->
        {:error, {:invalid_executable, :nul_byte}}

      Path.type(command) == :absolute ->
        resolve_workspace_executable(command, workspace_root)

      String.contains?(command, "/") ->
        command
        |> Path.expand(cwd)
        |> resolve_workspace_executable(workspace_root)

      true ->
        case System.find_executable(command) do
          nil -> {:error, {:executable_not_found, command}}
          path -> {:ok, path}
        end
    end
  end

  defp resolve_workspace_executable(path, workspace_root) do
    with {:ok, canonical_path} <- PathSafety.canonicalize(path),
         :ok <- ensure_executable_inside_workspace(path, canonical_path, workspace_root),
         true <- File.regular?(canonical_path) do
      {:ok, canonical_path}
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, {:executable_not_found, path}}
    end
  end

  defp ensure_executable_inside_workspace(expanded_path, canonical_path, workspace_root) do
    cond do
      path_inside?(canonical_path, workspace_root) ->
        :ok

      path_inside?(Path.expand(expanded_path), workspace_root) ->
        {:error, {:executable_symlink_escape, expanded_path, workspace_root}}

      true ->
        {:error, {:executable_outside_workspace, canonical_path, workspace_root}}
    end
  end

  defp workspace_root(opts) do
    case map_value(opts, :workspace_root) do
      root when is_binary(root) ->
        PathSafety.canonicalize(root)

      _other ->
        {:error, :missing_workspace_root}
    end
  end

  defp cwd(input, workspace_root) do
    requested_cwd = map_value(input, :cwd) || "."

    with {:ok, expanded_cwd} <- expand_cwd(requested_cwd, workspace_root),
         {:ok, canonical_cwd} <- PathSafety.canonicalize(expanded_cwd),
         :ok <- ensure_inside_workspace(expanded_cwd, canonical_cwd, workspace_root),
         :ok <- ensure_directory(canonical_cwd) do
      {:ok, canonical_cwd}
    end
  end

  defp expand_cwd(cwd, workspace_root) when is_binary(cwd) do
    if String.contains?(cwd, [<<0>>, "\n", "\r"]) do
      {:error, {:invalid_cwd, :invalid_characters}}
    else
      {:ok, if(Path.type(cwd) == :absolute, do: cwd, else: Path.expand(cwd, workspace_root))}
    end
  end

  defp expand_cwd(_cwd, _workspace_root), do: {:error, {:invalid_cwd, :not_binary}}

  defp ensure_inside_workspace(expanded_cwd, canonical_cwd, workspace_root) do
    cond do
      path_inside?(canonical_cwd, workspace_root) ->
        :ok

      path_inside?(Path.expand(expanded_cwd), workspace_root) ->
        {:error, {:cwd_symlink_escape, expanded_cwd, workspace_root}}

      true ->
        {:error, {:cwd_outside_workspace, canonical_cwd, workspace_root}}
    end
  end

  defp ensure_directory(path) do
    if File.dir?(path), do: :ok, else: {:error, {:cwd_not_found, path}}
  end

  defp path_inside?(path, root), do: path == root or String.starts_with?(path, root <> "/")

  defp approve(input, opts, command_id, argv, cwd) do
    approval_callback = map_value(opts, :approval_callback)

    if is_function(approval_callback, 1) do
      request = %{
        "tool_name" => "shell.exec",
        "command_id" => command_id,
        "argv" => argv,
        "cwd" => cwd,
        "sandbox_policy" => map_value(opts, :sandbox_policy),
        "metadata" => map_value(input, :metadata) || %{}
      }

      case approval_callback.(request) do
        :ok ->
          :ok

        {:error, reason} ->
          emit(opts, :approval_requested, Map.put(request, "reason", inspect(reason)))
          {:error, {:approval_required, reason}}
      end
    else
      :ok
    end
  end

  defp create_io_paths(command_id) do
    temp_dir = Path.join(System.tmp_dir!(), "symphony-shell-exec-#{command_id}")
    stdout_path = Path.join(temp_dir, "stdout")
    stderr_path = Path.join(temp_dir, "stderr")
    pidfile = pidfile_path(command_id)

    with {:ok, _removed} <- File.rm_rf(temp_dir),
         :ok <- File.mkdir_p(temp_dir),
         :ok <- File.mkdir_p(Path.dirname(pidfile)),
         :ok <- File.write(stdout_path, ""),
         :ok <- File.write(stderr_path, "") do
      File.rm(pidfile)
      File.rm(cancel_marker_path(command_id))
      {:ok, temp_dir, stdout_path, stderr_path, pidfile}
    end
  end

  defp pidfile_path(command_id), do: Path.join([System.tmp_dir!(), "symphony-shell-exec-pids", command_id <> ".pid"])
  defp cancel_marker_path(command_id), do: Path.join([System.tmp_dir!(), "symphony-shell-exec-pids", command_id <> ".cancel"])

  defp shell_wrapper do
    ~s(out=$1; err=$2; pidfile=$3; shift 3; "$@" > "$out" 2> "$err" & child=$!; printf "%s" "$child" > "$pidfile"; wait "$child" 2>/dev/null)
  end

  defp shell_path, do: System.find_executable("sh") || "/bin/sh"

  defp env_entries(input, opts) do
    inherited_env = System.get_env()
    input_env = map_value(input, :env) || %{}
    allowlist = map_value(opts, :env_allowlist) || @default_env_allowlist
    allowed = MapSet.new(Enum.filter(allowlist, &valid_env_name?/1))

    cleared_entries =
      inherited_env
      |> Map.keys()
      |> Enum.reject(fn key -> MapSet.member?(allowed, key) end)
      |> Enum.map(fn key -> {String.to_charlist(key), false} end)

    allowed_entries =
      inherited_env
      |> Map.take(MapSet.to_list(allowed))
      |> Map.merge(filter_input_env(input_env, allowed))
      |> Enum.map(fn {key, value} -> {String.to_charlist(key), String.to_charlist(value)} end)

    cleared_entries ++ allowed_entries
  end

  defp filter_input_env(env, allowed) when is_map(env) do
    env
    |> Enum.filter(fn {key, value} -> valid_env_name?(key) and MapSet.member?(allowed, key) and is_binary(value) end)
    |> Map.new()
  end

  defp filter_input_env(_env, _allowed), do: %{}

  defp valid_env_name?(name) when is_binary(name), do: Regex.match?(@env_name_regex, name)
  defp valid_env_name?(_name), do: false

  defp command_id(input, opts) do
    map_value(opts, :command_id) || map_value(input, :id) || Ecto.UUID.generate()
  end

  defp emit(opts, event, payload) do
    message = %{event: event, payload: payload}

    with on_event when is_function(on_event, 1) <- map_value(opts, :on_event),
         {:ok, normalized} <- Contract.normalize_event(message) do
      on_event.(normalized)
    else
      _ -> :ok
    end
  end

  defp positive_integer(value, _default) when is_integer(value) and value > 0, do: value
  defp positive_integer(_value, default), do: default

  defp monotonic_ms, do: System.monotonic_time(:millisecond)

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  defp map_value(_map, _key), do: nil
end
