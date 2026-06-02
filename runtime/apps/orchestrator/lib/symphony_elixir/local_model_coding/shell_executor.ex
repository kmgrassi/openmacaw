defmodule SymphonyElixir.LocalModelCoding.ShellExecutor do
  @moduledoc """
  Workspace-scoped executor for the local-model coding `shell.exec` tool.

  The executor intentionally accepts argv arrays only. It does not interpolate a
  shell command string, and every command runs with a cwd that resolves inside
  the approved workspace.
  """

  alias SymphonyElixir.PathSafety

  @type input :: %{
          required(:argv) => [String.t()],
          required(:workspace) => Path.t(),
          optional(:cwd) => Path.t(),
          optional(:env) => map(),
          optional(:allowed_env) => [String.t()],
          optional(:timeout_ms) => pos_integer(),
          optional(:output_limit_bytes) => pos_integer(),
          optional(:approval_policy) => String.t(),
          optional(:approval_callback) => (approval_request() -> approval_response()),
          optional(:sandbox_policy) => String.t(),
          optional(:on_event) => (event() -> any())
        }

  @type approval_request :: %{
          required(:tool) => String.t(),
          required(:argv) => [String.t()],
          required(:command) => String.t(),
          required(:cwd) => Path.t(),
          required(:workspace) => Path.t(),
          required(:sandbox_policy) => String.t()
        }

  @type approval_response :: :approved | :denied | {:ok, :approved} | {:error, term()}

  @type event :: %{
          required(:event) => atom(),
          required(:payload) => map()
        }

  @type result :: %{
          required(:tool) => String.t(),
          required(:argv) => [String.t()],
          required(:command) => String.t(),
          required(:cwd) => Path.t(),
          required(:exit_code) => non_neg_integer() | nil,
          required(:stdout) => String.t(),
          required(:stderr) => String.t(),
          required(:timed_out?) => boolean(),
          required(:cancelled?) => boolean(),
          required(:truncated?) => boolean()
        }

  @type async_handle :: %{required(:pid) => pid(), required(:ref) => reference()}

  @default_timeout_ms 60_000
  @default_output_limit_bytes 64_000
  @tool_name "shell.exec"

  @spec exec(input() | map()) :: {:ok, result()} | {:error, term()}
  def exec(input) when is_map(input) do
    with {:ok, command} <- prepare(input),
         :ok <- authorize(command) do
      run_prepared(command)
    end
  end

  @spec start(input() | map()) :: {:ok, async_handle()} | {:error, term()}
  def start(input) when is_map(input) do
    with {:ok, command} <- prepare(input),
         :ok <- authorize(command) do
      caller = self()
      ref = make_ref()

      pid =
        spawn(fn ->
          result = run_prepared(command)
          send(caller, {:shell_exec_result, ref, result})
        end)

      {:ok, %{pid: pid, ref: ref}}
    end
  end

  @spec cancel(async_handle() | pid()) :: :ok
  def cancel(%{pid: pid}) when is_pid(pid), do: cancel(pid)

  def cancel(pid) when is_pid(pid) do
    send(pid, :cancel)
    :ok
  end

  defp prepare(input) do
    argv = Map.get(input, :argv) || Map.get(input, "argv")
    workspace = Map.get(input, :workspace) || Map.get(input, "workspace")
    cwd = Map.get(input, :cwd) || Map.get(input, "cwd")

    with {:ok, argv} <- normalize_argv(argv),
         {:ok, workspace} <- canonical_workspace(workspace),
         {:ok, cwd} <- canonical_cwd(workspace, cwd),
         {:ok, executable} <- executable_for(argv),
         {:ok, env} <- filtered_env(input),
         {:ok, timeout_ms} <- positive_integer(input, :timeout_ms, @default_timeout_ms),
         {:ok, output_limit_bytes} <- positive_integer(input, :output_limit_bytes, @default_output_limit_bytes) do
      {:ok,
       %{
         argv: argv,
         command: shell_join(argv),
         executable: executable,
         args: tl(argv),
         workspace: workspace,
         cwd: cwd,
         env: env,
         timeout_ms: timeout_ms,
         output_limit_bytes: output_limit_bytes,
         approval_policy: string_value(input, :approval_policy) || "on-request",
         approval_callback: Map.get(input, :approval_callback) || Map.get(input, "approval_callback"),
         sandbox_policy: string_value(input, :sandbox_policy) || "workspace-write",
         on_event: Map.get(input, :on_event) || Map.get(input, "on_event")
       }}
    end
  end

  defp normalize_argv([command | _rest] = argv) when is_binary(command) do
    if Enum.all?(argv, &is_binary/1), do: {:ok, argv}, else: {:error, {:invalid_shell_exec_argv, :non_binary_argument}}
  end

  defp normalize_argv(_argv), do: {:error, {:invalid_shell_exec_argv, :expected_non_empty_string_list}}

  defp canonical_workspace(workspace) when is_binary(workspace) do
    with {:ok, canonical} <- PathSafety.canonicalize(workspace),
         {:ok, %File.Stat{type: type}} when type in [:directory, :symlink] <- File.lstat(canonical) do
      {:ok, canonical}
    else
      {:error, reason} -> {:error, {:invalid_shell_exec_workspace, reason}}
      _ -> {:error, {:invalid_shell_exec_workspace, :not_directory}}
    end
  end

  defp canonical_workspace(_workspace), do: {:error, {:invalid_shell_exec_workspace, :expected_path}}

  defp canonical_cwd(workspace, cwd) when cwd in [nil, ""], do: {:ok, workspace}

  defp canonical_cwd(workspace, cwd) when is_binary(cwd) do
    candidate = Path.expand(cwd, workspace)

    with {:ok, canonical} <- PathSafety.canonicalize(candidate),
         :ok <- ensure_path_in_workspace(canonical, workspace),
         {:ok, %File.Stat{type: :directory}} <- File.lstat(canonical) do
      {:ok, canonical}
    else
      {:error, reason} -> {:error, {:invalid_shell_exec_cwd, reason}}
      _ -> {:error, {:invalid_shell_exec_cwd, :not_directory}}
    end
  end

  defp canonical_cwd(_workspace, _cwd), do: {:error, {:invalid_shell_exec_cwd, :expected_path}}

  defp ensure_path_in_workspace(path, workspace) do
    workspace_prefix = workspace <> "/"

    if path == workspace or String.starts_with?(path <> "/", workspace_prefix) do
      :ok
    else
      {:error, :outside_workspace}
    end
  end

  defp executable_for([command | _argv]) do
    cond do
      String.contains?(command, "/") ->
        {:error, {:invalid_shell_exec_argv, :command_must_be_resolved_from_path}}

      executable = System.find_executable(command) ->
        {:ok, executable}

      true ->
        {:error, {:invalid_shell_exec_argv, :command_not_found}}
    end
  end

  defp filtered_env(input) do
    env = Map.get(input, :env) || Map.get(input, "env") || %{}
    allowed = Map.get(input, :allowed_env) || Map.get(input, "allowed_env") || []

    cond do
      not is_map(env) ->
        {:error, {:invalid_shell_exec_env, :expected_map}}

      not Enum.all?(allowed, &is_binary/1) ->
        {:error, {:invalid_shell_exec_env, :allowlist_must_be_strings}}

      true ->
        allowed = MapSet.new(allowed)

        filtered =
          env
          |> Enum.flat_map(fn {key, value} ->
            key = to_string(key)

            if MapSet.member?(allowed, key) and is_binary(value) do
              [{key, value}]
            else
              []
            end
          end)

        {:ok, filtered}
    end
  end

  defp positive_integer(input, key, default) do
    value = Map.get(input, key) || Map.get(input, Atom.to_string(key)) || default

    if is_integer(value) and value > 0 do
      {:ok, value}
    else
      {:error, {:invalid_shell_exec_option, key}}
    end
  end

  defp authorize(%{approval_policy: "never"}), do: :ok

  defp authorize(%{approval_callback: callback} = command) when is_function(callback, 1) do
    request = Map.take(command, [:argv, :command, :cwd, :workspace, :sandbox_policy]) |> Map.put(:tool, @tool_name)
    emit(command, :approval_requested, request)

    case callback.(request) do
      :approved -> emit_approval_resolved(command, "approved")
      {:ok, :approved} -> emit_approval_resolved(command, "approved")
      :denied -> {:error, {:approval_required, request}}
      {:error, reason} -> {:error, {:approval_required, Map.put(request, :reason, reason)}}
      other -> {:error, {:approval_required, Map.put(request, :reason, {:unexpected_approval_response, other})}}
    end
  end

  defp authorize(command) do
    request = Map.take(command, [:argv, :command, :cwd, :workspace, :sandbox_policy]) |> Map.put(:tool, @tool_name)
    emit(command, :approval_requested, request)
    {:error, {:approval_required, request}}
  end

  defp emit_approval_resolved(command, decision) do
    emit(command, :approval_resolved, %{"tool" => @tool_name, "decision" => decision})
    :ok
  end

  defp run_prepared(command) do
    emit(command, :command_started, command_payload(command))
    {executable, args} = isolated_env_command(command)

    port =
      Port.open({:spawn_executable, String.to_charlist(executable)}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args: Enum.map(args, &String.to_charlist/1),
        cd: String.to_charlist(command.cwd)
      ])

    timer = Process.send_after(self(), {:shell_exec_timeout, port}, command.timeout_ms)
    state = %{stdout: "", stderr: "", output_bytes: 0, truncated?: false, cancelled?: false, timed_out?: false}
    result = collect(command, port, timer, state)
    emit(command, :command_completed, Map.drop(result, [:stdout, :stderr]) |> Map.put(:stdout_bytes, byte_size(result.stdout)))
    {:ok, result}
  end

  defp collect(command, port, timer, state) do
    receive do
      {^port, {:data, data}} ->
        {chunk, state} = cap_chunk(data, state, command.output_limit_bytes)

        if chunk != "" do
          emit(command, :command_output_delta, %{"stream" => "stdout", "text" => chunk})
        end

        if state.truncated? do
          close_port(port)
          finalize(command, state, nil, timer)
        else
          collect(command, port, timer, state)
        end

      {^port, {:exit_status, exit_code}} ->
        finalize(command, state, exit_code, timer)

      {:shell_exec_timeout, ^port} ->
        close_port(port)
        finalize(command, %{state | timed_out?: true}, nil, timer)

      :cancel ->
        close_port(port)
        finalize(command, %{state | cancelled?: true}, nil, timer)
    end
  end

  defp cap_chunk(data, %{output_bytes: output_bytes} = state, limit) do
    remaining = limit - output_bytes

    cond do
      remaining <= 0 ->
        {"", %{state | truncated?: true}}

      byte_size(data) <= remaining ->
        {data, %{state | stdout: state.stdout <> data, output_bytes: output_bytes + byte_size(data)}}

      true ->
        chunk = binary_part(data, 0, remaining)
        {chunk, %{state | stdout: state.stdout <> chunk, output_bytes: limit, truncated?: true}}
    end
  end

  defp finalize(command, state, exit_code, timer) do
    Process.cancel_timer(timer)

    %{
      tool: @tool_name,
      argv: command.argv,
      command: command.command,
      cwd: command.cwd,
      exit_code: exit_code,
      stdout: state.stdout,
      stderr: state.stderr,
      timed_out?: state.timed_out?,
      cancelled?: state.cancelled?,
      truncated?: state.truncated?
    }
  end

  defp close_port(port) do
    try do
      Port.close(port)
    catch
      :error, :badarg -> :ok
    end
  end

  defp isolated_env_command(command) do
    env_args = Enum.map(command.env, fn {key, value} -> "#{key}=#{value}" end)
    env_executable = System.find_executable("env") || "/usr/bin/env"

    {env_executable, ["-i"] ++ env_args ++ [command.executable | command.args]}
  end

  defp emit(%{on_event: on_event}, event, payload) when is_function(on_event, 1) do
    on_event.(%{event: event, payload: payload})
    :ok
  end

  defp emit(_command, _event, _payload), do: :ok

  defp command_payload(command) do
    command
    |> Map.take([:argv, :command, :cwd, :workspace, :sandbox_policy, :timeout_ms, :output_limit_bytes])
    |> Map.put(:tool, @tool_name)
  end

  defp string_value(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp shell_join(argv) do
    Enum.map_join(argv, " ", fn arg ->
      if String.match?(arg, ~r/^[A-Za-z0-9_@%+=:,.\/-]+$/), do: arg, else: inspect(arg)
    end)
  end
end
