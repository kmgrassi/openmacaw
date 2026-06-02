defmodule SymphonyElixir.PathSafety do
  @moduledoc false

  @type local_workspace_cwd_option :: {:require_dir?, boolean()}

  @spec canonicalize(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  def canonicalize(path) when is_binary(path) do
    expanded_path = Path.expand(path)
    {root, segments} = split_absolute_path(expanded_path)

    case resolve_segments(root, [], segments) do
      {:ok, canonical_path} ->
        {:ok, canonical_path}

      {:error, reason} ->
        {:error, {:path_canonicalize_failed, expanded_path, reason}}
    end
  end

  @spec validate_path_segment(String.t()) :: :ok | {:error, term()}
  def validate_path_segment(segment) when is_binary(segment) do
    cond do
      segment == "" ->
        {:error, {:invalid_path_segment, segment, :empty}}

      segment in [".", ".."] ->
        {:error, {:invalid_path_segment, segment, :relative_segment}}

      String.contains?(segment, ["/", "\\"]) ->
        {:error, {:invalid_path_segment, segment, :path_separator}}

      String.contains?(segment, ["\n", "\r", <<0>>]) ->
        {:error, {:invalid_path_segment, segment, :invalid_characters}}

      true ->
        :ok
    end
  end

  def validate_path_segment(segment), do: {:error, {:invalid_path_segment, segment, :not_binary}}

  @spec workspace_child_path(Path.t(), String.t()) :: {:ok, Path.t()} | {:error, term()}
  def workspace_child_path(root, segment) when is_binary(root) do
    with :ok <- validate_path_segment(segment) do
      root
      |> Path.join(segment)
      |> canonicalize()
    end
  end

  @spec validate_workspace_child(Path.t(), Path.t()) :: :ok | {:error, term()}
  def validate_workspace_child(workspace, root) when is_binary(workspace) and is_binary(root) do
    expanded_workspace = Path.expand(workspace)
    expanded_root = Path.expand(root)
    expanded_root_prefix = expanded_root <> "/"

    with {:ok, canonical_workspace} <- canonicalize(expanded_workspace),
         {:ok, canonical_root} <- canonicalize(expanded_root) do
      canonical_root_prefix = canonical_root <> "/"

      cond do
        canonical_workspace == canonical_root ->
          {:error, {:workspace_equals_root, canonical_workspace, canonical_root}}

        String.starts_with?(canonical_workspace <> "/", canonical_root_prefix) ->
          :ok

        String.starts_with?(expanded_workspace <> "/", expanded_root_prefix) ->
          {:error, {:workspace_symlink_escape, expanded_workspace, canonical_root}}

        true ->
          {:error, {:workspace_outside_root, canonical_workspace, canonical_root}}
      end
    else
      {:error, {:path_canonicalize_failed, path, reason}} ->
        {:error, {:workspace_path_unreadable, path, reason}}
    end
  end

  @spec validate_local_workspace_cwd(Path.t(), Path.t(), [local_workspace_cwd_option()]) ::
          {:ok, Path.t()} | {:error, term()}
  def validate_local_workspace_cwd(workspace, root, opts \\ [])
      when is_binary(workspace) and is_binary(root) and is_list(opts) do
    expanded_workspace = Path.expand(workspace)
    expanded_root = Path.expand(root)
    expanded_root_prefix = expanded_root <> "/"
    require_dir? = Keyword.get(opts, :require_dir?, false)

    with {:ok, canonical_workspace} <- canonicalize(expanded_workspace),
         {:ok, canonical_root} <- canonicalize(expanded_root) do
      canonical_root_prefix = canonical_root <> "/"

      cond do
        require_dir? and not File.dir?(canonical_workspace) ->
          {:error, {:invalid_workspace_cwd, :cwd_not_found, canonical_workspace}}

        canonical_workspace == canonical_root ->
          {:error, {:invalid_workspace_cwd, :workspace_root, canonical_workspace}}

        String.starts_with?(canonical_workspace <> "/", canonical_root_prefix) ->
          {:ok, canonical_workspace}

        String.starts_with?(expanded_workspace <> "/", expanded_root_prefix) ->
          {:error, {:invalid_workspace_cwd, :symlink_escape, expanded_workspace, canonical_root}}

        true ->
          {:error, {:invalid_workspace_cwd, :outside_workspace_root, canonical_workspace, canonical_root}}
      end
    else
      {:error, {:path_canonicalize_failed, path, reason}} ->
        {:error, {:invalid_workspace_cwd, :path_unreadable, path, reason}}
    end
  end

  defp split_absolute_path(path) when is_binary(path) do
    [root | segments] = Path.split(path)
    {root, segments}
  end

  defp resolve_segments(root, resolved_segments, []), do: {:ok, join_path(root, resolved_segments)}

  defp resolve_segments(root, resolved_segments, [segment | rest]) do
    candidate_path = join_path(root, resolved_segments ++ [segment])

    case File.lstat(candidate_path) do
      {:ok, %File.Stat{type: :symlink}} ->
        with {:ok, target} <- :file.read_link_all(String.to_charlist(candidate_path)) do
          resolved_target = Path.expand(IO.chardata_to_string(target), join_path(root, resolved_segments))
          {target_root, target_segments} = split_absolute_path(resolved_target)
          resolve_segments(target_root, [], target_segments ++ rest)
        end

      {:ok, _stat} ->
        resolve_segments(root, resolved_segments ++ [segment], rest)

      {:error, :enoent} ->
        {:ok, join_path(root, resolved_segments ++ [segment | rest])}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp join_path(root, segments) when is_list(segments) do
    Enum.reduce(segments, root, fn segment, acc -> Path.join(acc, segment) end)
  end
end
