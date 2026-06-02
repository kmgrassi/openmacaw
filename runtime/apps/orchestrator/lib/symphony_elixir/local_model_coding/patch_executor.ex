defmodule SymphonyElixir.LocalModelCoding.PatchExecutor do
  @moduledoc """
  Workspace-scoped executor for the local model coding `apply_patch` tool.
  """

  alias SymphonyElixir.PathSafety

  @type event_callback :: (map() -> term())

  @spec tool_definition() :: map()
  def tool_definition do
    %{
      "name" => "apply_patch",
      "description" => "Apply a structured patch inside the assigned workspace.",
      "parameters_schema" => %{
        "type" => "object",
        "required" => ["patch"],
        "additionalProperties" => false,
        "properties" => %{
          "patch" => %{
            "type" => "string",
            "description" => "Patch text using the *** Begin Patch / *** End Patch format."
          }
        }
      },
      "execution_kind" => "local_model_coding.apply_patch",
      "writes" => true
    }
  end

  @spec execute(map(), keyword()) :: {:ok, map()}
  def execute(arguments, opts) when is_map(arguments) and is_list(opts) do
    workspace_root = Keyword.fetch!(opts, :workspace_root)
    on_event = Keyword.get(opts, :on_event, fn _event -> :ok end)
    cwd = Map.get(arguments, "cwd") || Map.get(arguments, :cwd)

    case Map.get(arguments, "patch") || Map.get(arguments, :patch) do
      patch when is_binary(patch) and patch != "" ->
        do_execute(patch, workspace_root, cwd, on_event)

      _ ->
        {:ok, failure_result(:invalid_patch, "apply_patch requires a non-empty patch string", [])}
    end
  end

  def execute(_arguments, _opts),
    do: {:ok, failure_result(:invalid_arguments, "apply_patch arguments must be an object", [])}

  defp do_execute(patch, workspace_root, cwd, on_event) do
    with {:ok, canonical_root} <- PathSafety.canonicalize(workspace_root),
         {:ok, canonical_base} <- canonical_patch_base(canonical_root, cwd),
         {:ok, operations} <- parse_patch(patch),
         {:ok, planned_changes} <- validate_operations(operations, canonical_root, canonical_base) do
      emit(on_event, :patch_apply_begin, %{
        "workspace_root" => canonical_root,
        "cwd" => canonical_base,
        "changes" => Enum.map(planned_changes, &change_summary/1)
      })

      result = apply_operations(planned_changes)

      emit(
        on_event,
        :patch_apply_end,
        %{
          "workspace_root" => canonical_root,
          "cwd" => canonical_base,
          "success" => match?({:ok, _changes}, result),
          "changes" => result_changes(result),
          "error" => result_error(result)
        }
        |> reject_nil_values()
      )

      case result do
        {:ok, changes} ->
          {:ok,
           %{
             "type" => "tool_call_result",
             "success" => true,
             "output" => "Patch applied successfully.",
             "changes" => Enum.map(changes, &change_summary/1)
           }}

        {:error, reason} ->
          {:ok, failure_result(:patch_apply_failed, inspect(reason), Enum.map(planned_changes, &change_summary/1))}
      end
    else
      {:error, reason} ->
        {:ok, failure_result(:patch_apply_failed, inspect(reason), [])}
    end
  end

  defp parse_patch(patch) do
    lines = String.split(patch, "\n", trim: false)

    with ["*** Begin Patch" | rest] <- lines,
         {:ok, operations, rest} <- parse_operations(rest, []),
         :ok <- require_end_patch(rest) do
      {:ok, Enum.reverse(operations)}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_patch_envelope}
    end
  end

  defp parse_operations(["*** End Patch" | _] = rest, operations), do: {:ok, operations, rest}
  defp parse_operations(["" | rest], operations), do: parse_operations(rest, operations)

  defp parse_operations(["*** Add File: " <> path | rest], operations) do
    {body, rest} = take_change_lines(rest)

    with {:ok, lines} <- strip_add_lines(body) do
      parse_operations(rest, [%{action: :add, path: path, lines: lines} | operations])
    end
  end

  defp parse_operations(["*** Delete File: " <> path | rest], operations) do
    parse_operations(rest, [%{action: :delete, path: path} | operations])
  end

  defp parse_operations(["*** Update File: " <> path | rest], operations) do
    {move_to, rest} = take_move_to(rest)
    {body, rest} = take_change_lines(rest)
    parse_operations(rest, [%{action: :update, path: path, move_to: move_to, lines: body} | operations])
  end

  defp parse_operations([line | _rest], _operations), do: {:error, {:invalid_patch_line, line}}
  defp parse_operations([], _operations), do: {:error, :missing_end_patch}

  defp require_end_patch(["*** End Patch" | _rest]), do: :ok
  defp require_end_patch(_rest), do: {:error, :missing_end_patch}

  defp take_move_to(["*** Move to: " <> path | rest]), do: {path, rest}
  defp take_move_to(rest), do: {nil, rest}

  defp take_change_lines(lines) do
    Enum.split_while(lines, fn line ->
      line == "*** End of File" or not String.starts_with?(line, "*** ")
    end)
  end

  defp strip_add_lines(lines) do
    Enum.reduce_while(lines, {:ok, []}, fn
      "+" <> line, {:ok, stripped} -> {:cont, {:ok, [line | stripped]}}
      line, {:ok, _stripped} -> {:halt, {:error, {:invalid_add_file_line, line}}}
    end)
    |> case do
      {:ok, stripped} -> {:ok, Enum.reverse(stripped)}
      error -> error
    end
  end

  defp canonical_patch_base(canonical_root, cwd) when cwd in [nil, ""], do: {:ok, canonical_root}

  defp canonical_patch_base(canonical_root, cwd) when is_binary(cwd) do
    expanded = Path.expand(cwd, canonical_root)

    with {:ok, canonical_cwd} <- PathSafety.canonicalize(expanded),
         :ok <- ensure_base_inside_workspace(canonical_cwd, canonical_root),
         true <- File.dir?(canonical_cwd) do
      {:ok, canonical_cwd}
    else
      {:error, reason} -> {:error, {:invalid_patch_cwd, reason}}
      false -> {:error, {:invalid_patch_cwd, :not_directory}}
    end
  end

  defp canonical_patch_base(_canonical_root, _cwd), do: {:error, {:invalid_patch_cwd, :expected_path}}

  defp validate_operations(operations, canonical_root, canonical_base) do
    operations
    |> Enum.reduce_while({:ok, []}, fn operation, {:ok, changes} ->
      case validate_operation(operation, canonical_root, canonical_base) do
        {:ok, change} -> {:cont, {:ok, [change | changes]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, changes} -> {:ok, Enum.reverse(changes)}
      error -> error
    end
  end

  defp validate_operation(%{action: :add, path: path, lines: lines}, canonical_root, canonical_base) do
    with {:ok, resolved_path} <- validate_patch_path(path, canonical_root, canonical_base),
         :ok <- reject_existing_path(resolved_path) do
      {:ok, %{action: :add, path: path, resolved_path: resolved_path, lines: lines}}
    end
  end

  defp validate_operation(%{action: :delete, path: path}, canonical_root, canonical_base) do
    with {:ok, resolved_path} <- validate_patch_path(path, canonical_root, canonical_base),
         :ok <- require_regular_file(resolved_path) do
      {:ok, %{action: :delete, path: path, resolved_path: resolved_path}}
    end
  end

  defp validate_operation(%{action: :update, path: path, move_to: move_to, lines: lines}, canonical_root, canonical_base) do
    with {:ok, resolved_path} <- validate_patch_path(path, canonical_root, canonical_base),
         :ok <- require_regular_file(resolved_path),
         {:ok, resolved_move_to} <- validate_optional_move_path(move_to, canonical_root, canonical_base) do
      {:ok, %{action: :update, path: path, resolved_path: resolved_path, move_to: move_to, resolved_move_to: resolved_move_to, lines: lines}}
    end
  end

  defp validate_patch_path(path, canonical_root, canonical_base) when is_binary(path) and path != "" do
    expanded = Path.expand(path, canonical_base)

    with {:ok, canonical_path} <- PathSafety.canonicalize(expanded),
         :ok <- ensure_inside_workspace(canonical_path, canonical_root) do
      {:ok, canonical_path}
    end
  end

  defp validate_patch_path(path, _canonical_root, _canonical_base), do: {:error, {:invalid_patch_path, path}}

  defp validate_optional_move_path(nil, _canonical_root, _canonical_base), do: {:ok, nil}

  defp validate_optional_move_path(path, canonical_root, canonical_base) do
    with {:ok, resolved_path} <- validate_patch_path(path, canonical_root, canonical_base),
         :ok <- reject_existing_path(resolved_path) do
      {:ok, resolved_path}
    end
  end

  defp ensure_inside_workspace(path, canonical_root) do
    root_prefix = canonical_root <> "/"

    cond do
      path == canonical_root ->
        {:error, {:workspace_path_is_root, path}}

      String.starts_with?(path <> "/", root_prefix) ->
        :ok

      true ->
        {:error, {:workspace_path_escape, path, canonical_root}}
    end
  end

  defp ensure_base_inside_workspace(path, canonical_root) do
    root_prefix = canonical_root <> "/"

    if path == canonical_root or String.starts_with?(path <> "/", root_prefix) do
      :ok
    else
      {:error, {:workspace_path_escape, path, canonical_root}}
    end
  end

  defp reject_existing_path(path) do
    case File.lstat(path) do
      {:error, :enoent} -> :ok
      {:ok, _stat} -> {:error, {:path_already_exists, path}}
      {:error, reason} -> {:error, {:path_stat_failed, path, reason}}
    end
  end

  defp require_regular_file(path) do
    case File.stat(path) do
      {:ok, %File.Stat{type: :regular}} -> :ok
      {:ok, %File.Stat{type: type}} -> {:error, {:not_regular_file, path, type}}
      {:error, reason} -> {:error, {:path_stat_failed, path, reason}}
    end
  end

  defp apply_operations(changes) do
    Enum.reduce_while(changes, {:ok, []}, fn change, {:ok, applied} ->
      case prepare_operation(change) do
        {:ok, applied_change} -> {:cont, {:ok, [applied_change | applied]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, applied} ->
        prepared = Enum.reverse(applied)

        with :ok <- commit_prepared_operations(prepared) do
          {:ok, Enum.map(prepared, &Map.drop(&1, [:content]))}
        end

      error ->
        error
    end
  end

  defp prepare_operation(%{action: :add, lines: lines} = change) do
    {:ok, Map.merge(change, %{content: Enum.join(lines, "\n"), additions: length(lines), deletions: 0})}
  end

  defp prepare_operation(%{action: :delete, resolved_path: path} = change) do
    with {:ok, content} <- File.read(path) do
      {:ok, Map.merge(change, %{additions: 0, deletions: line_count(content)})}
    end
  end

  defp prepare_operation(%{action: :update, resolved_path: path, lines: patch_lines} = change) do
    with {:ok, content} <- File.read(path),
         {:ok, updated, stats} <- apply_update_lines(content, patch_lines) do
      {:ok, change |> Map.merge(stats) |> Map.put(:content, updated)}
    end
  end

  defp commit_prepared_operations(changes) do
    Enum.reduce_while(changes, :ok, fn change, :ok ->
      case commit_prepared_operation(change) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp commit_prepared_operation(%{action: :add, resolved_path: path, content: content}) do
    with :ok <- File.mkdir_p(Path.dirname(path)) do
      File.write(path, content)
    end
  end

  defp commit_prepared_operation(%{action: :delete, resolved_path: path}) do
    File.rm(path)
  end

  defp commit_prepared_operation(%{action: :update, resolved_path: path, resolved_move_to: nil, content: content}) do
    File.write(path, content)
  end

  defp commit_prepared_operation(%{action: :update, resolved_path: path, resolved_move_to: move_to, content: content}) do
    with :ok <- File.mkdir_p(Path.dirname(move_to)),
         :ok <- File.write(move_to, content),
         :ok <- File.rm(path) do
      :ok
    end
  end

  defp apply_update_lines(content, patch_lines) do
    original = String.split(content, "\n", trim: false)

    patch_lines
    |> Enum.reject(&(&1 == "*** End of File" or String.starts_with?(&1, "@@")))
    |> Enum.reduce_while({:ok, %{index: 0, output: [], additions: 0, deletions: 0}}, fn line, {:ok, acc} ->
      apply_patch_line(original, line, acc)
    end)
    |> case do
      {:ok, acc} ->
        remaining = Enum.drop(original, acc.index)
        updated = Enum.reverse(acc.output) ++ remaining
        {:ok, Enum.join(updated, "\n"), %{additions: acc.additions, deletions: acc.deletions}}

      error ->
        error
    end
  end

  defp apply_patch_line(_original, "+" <> text, acc) do
    {:cont, {:ok, %{acc | output: [text | acc.output], additions: acc.additions + 1}}}
  end

  defp apply_patch_line(original, "-" <> text, acc) do
    case find_line(original, text, acc.index) do
      {:ok, index} ->
        prefix = original |> Enum.slice(acc.index, index - acc.index) |> Enum.reverse()
        {:cont, {:ok, %{acc | index: index + 1, output: prefix ++ acc.output, deletions: acc.deletions + 1}}}

      :error ->
        {:halt, {:error, {:patch_context_not_found, text}}}
    end
  end

  defp apply_patch_line(original, " " <> text, acc) do
    case find_line(original, text, acc.index) do
      {:ok, index} ->
        prefix = original |> Enum.slice(acc.index, index - acc.index + 1) |> Enum.reverse()
        {:cont, {:ok, %{acc | index: index + 1, output: prefix ++ acc.output}}}

      :error ->
        {:halt, {:error, {:patch_context_not_found, text}}}
    end
  end

  defp apply_patch_line(_original, "", acc), do: {:cont, {:ok, acc}}
  defp apply_patch_line(_original, line, _acc), do: {:halt, {:error, {:invalid_patch_change_line, line}}}

  defp find_line(lines, text, start_index) do
    lines
    |> Enum.drop(start_index)
    |> Enum.find_index(&(&1 == text))
    |> case do
      nil -> :error
      offset -> {:ok, start_index + offset}
    end
  end

  defp line_count(""), do: 0
  defp line_count(content), do: content |> String.split("\n", trim: true) |> length()

  defp result_changes({:ok, changes}), do: Enum.map(changes, &change_summary/1)
  defp result_changes({:error, _reason}), do: []

  defp result_error({:ok, _changes}), do: nil
  defp result_error({:error, reason}), do: inspect(reason)

  defp change_summary(change) do
    %{
      "path" => Map.fetch!(change, :path),
      "action" => change.action |> Atom.to_string(),
      "additions" => Map.get(change, :additions, count_added_lines(change)),
      "deletions" => Map.get(change, :deletions, count_removed_lines(change))
    }
    |> maybe_put("move_to", Map.get(change, :move_to))
  end

  defp count_added_lines(%{action: :add, lines: lines}), do: length(lines)
  defp count_added_lines(%{lines: lines}) when is_list(lines), do: Enum.count(lines, &String.starts_with?(&1, "+"))
  defp count_added_lines(_change), do: 0

  defp count_removed_lines(%{action: :delete}), do: 0
  defp count_removed_lines(%{lines: lines}) when is_list(lines), do: Enum.count(lines, &String.starts_with?(&1, "-"))
  defp count_removed_lines(_change), do: 0

  defp failure_result(code, message, changes) do
    %{
      "type" => "tool_call_result",
      "success" => false,
      "error_code" => Atom.to_string(code),
      "error" => message,
      "output" => message,
      "changes" => changes
    }
  end

  defp emit(on_event, event, payload) do
    on_event.(%{event: event, payload: payload})
    :ok
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
