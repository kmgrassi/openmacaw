defmodule SymphonyElixir.Runner.Artifacts do
  @moduledoc """
  Runtime artifact upload boundary for remote execution adapters.

  Callers provide a configured sink and run identity. This module builds the
  owned run prefix, uploads each artifact, and returns provider-neutral
  references that Platform can persist or render without branching on AWS.
  """

  alias SymphonyElixir.Runner.Artifacts.S3

  @type artifact :: %{
          optional(:name) => String.t(),
          optional(:path) => Path.t(),
          optional(:body) => iodata(),
          optional(:content_type) => String.t(),
          optional(:kind) => String.t()
        }

  @type context :: %{
          required(:sink) => String.t(),
          required(:workspace_id) => String.t(),
          required(:run_id) => String.t(),
          optional(:session_id) => String.t()
        }

  @type artifact_ref :: %{
          required(String.t()) => term()
        }

  @doc """
  Uploads summary, logs, patches, and diagnostics under the caller's run prefix.

  Supported sinks:

    * `s3://bucket/base-prefix`
    * local filesystem paths

  The final key/path always includes
  `workspaces/<workspace_id>/runs/<run_id>/...`. Artifact names are relative
  paths under that prefix and traversal is rejected before any upload happens.
  """
  @spec upload_many(context(), [artifact()], keyword()) :: {:ok, [artifact_ref()]} | {:error, term()}
  def upload_many(context, artifacts, opts \\ []) when is_map(context) and is_list(artifacts) do
    with {:ok, sink} <- parse_sink(fetch_required(context, :sink)),
         {:ok, prefix} <- run_prefix(context),
         {:ok, normalized_artifacts} <- normalize_artifacts(artifacts) do
      uploader = Keyword.get(opts, :uploader, default_uploader(sink))

      normalized_artifacts
      |> Enum.reduce_while({:ok, []}, fn artifact, {:ok, refs} ->
        case upload_one(sink, prefix, artifact, uploader) do
          {:ok, ref} -> {:cont, {:ok, [ref | refs]}}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)
      |> case do
        {:ok, refs} -> {:ok, Enum.reverse(refs)}
        error -> error
      end
    end
  end

  @doc """
  Builds a summary JSON artifact. The body is encoded immediately so callers get
  deterministic upload bytes and a clear error before the remote runner exits.
  """
  @spec summary(map()) :: artifact()
  def summary(summary) when is_map(summary) do
    %{
      name: "summary.json",
      kind: "summary",
      content_type: "application/json",
      body: Jason.encode_to_iodata!(summary)
    }
  end

  @doc """
  Builds a command log artifact from captured command output.
  """
  @spec command_log(String.t(), iodata()) :: artifact()
  def command_log(command_id, body) when is_binary(command_id) do
    %{
      name: Path.join(["command-logs", safe_filename(command_id) <> ".log"]),
      kind: "command_log",
      content_type: "text/plain; charset=utf-8",
      body: body
    }
  end

  @doc """
  Builds a final patch/review artifact.
  """
  @spec final_artifact(String.t(), iodata(), String.t()) :: artifact()
  def final_artifact(name, body, content_type \\ "text/plain; charset=utf-8") when is_binary(name) do
    %{name: Path.join("final", name), kind: "patch", content_type: content_type, body: body}
  end

  @doc """
  Builds a diagnostics artifact for failed materialization or execution.
  """
  @spec diagnostics(map()) :: artifact()
  def diagnostics(diagnostics) when is_map(diagnostics) do
    %{
      name: "diagnostics.json",
      kind: "diagnostic",
      content_type: "application/json",
      body: Jason.encode_to_iodata!(diagnostics)
    }
  end

  defp upload_one(%{type: :s3, bucket: bucket, prefix: base_prefix}, run_prefix, artifact, uploader) do
    key = join_key([base_prefix, run_prefix, artifact.name])

    with :ok <- ensure_owned_key(key, join_key([base_prefix, run_prefix])),
         {:ok, body} <- artifact_body(artifact),
         {:ok, upload_meta} <- uploader.put_object(bucket, key, body, content_type: artifact.content_type) do
      {:ok,
       %{
         "kind" => artifact.kind,
         "name" => artifact.name,
         "uri" => "s3://#{bucket}/#{key}",
         "bucket" => bucket,
         "key" => key,
         "content_type" => artifact.content_type,
         "metadata" => upload_meta || %{}
       }}
    end
  end

  defp upload_one(%{type: :local, root: root}, run_prefix, artifact, _uploader) do
    path = Path.join([root, run_prefix, artifact.name])
    owned_root = Path.join(root, run_prefix)

    with :ok <- ensure_owned_path(path, owned_root),
         {:ok, body} <- artifact_body(artifact),
         :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(path, body) do
      {:ok,
       %{
         "kind" => artifact.kind,
         "name" => artifact.name,
         "uri" => path,
         "path" => path,
         "content_type" => artifact.content_type,
         "metadata" => %{}
       }}
    end
  end

  defp normalize_artifacts(artifacts) do
    artifacts
    |> Enum.reduce_while({:ok, []}, fn artifact, {:ok, acc} ->
      case normalize_artifact(artifact) do
        {:ok, normalized} -> {:cont, {:ok, [normalized | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, normalized} -> {:ok, Enum.reverse(normalized)}
      error -> error
    end
  end

  defp normalize_artifact(artifact) when is_map(artifact) do
    with {:ok, name} <- safe_relative_name(fetch_required(artifact, :name)),
         {:ok, kind} <- safe_kind(map_value(artifact, :kind) || "artifact") do
      {:ok,
       %{
         name: name,
         kind: kind,
         path: map_value(artifact, :path),
         body: map_value(artifact, :body),
         content_type: map_value(artifact, :content_type) || "application/octet-stream"
       }}
    end
  end

  defp normalize_artifact(_artifact), do: {:error, :invalid_artifact}

  defp artifact_body(%{body: body}) when not is_nil(body), do: {:ok, IO.iodata_to_binary(body)}

  defp artifact_body(%{path: path}) when is_binary(path) do
    case File.read(path) do
      {:ok, body} -> {:ok, body}
      {:error, reason} -> {:error, {:artifact_read_failed, path, reason}}
    end
  end

  defp artifact_body(_artifact), do: {:error, :missing_artifact_body}

  defp run_prefix(context) do
    with {:ok, workspace_id} <- safe_segment(fetch_required(context, :workspace_id)),
         {:ok, run_id} <- safe_segment(fetch_required(context, :run_id)) do
      {:ok, join_key(["workspaces", workspace_id, "runs", run_id])}
    end
  end

  defp parse_sink("s3://" <> rest) do
    case String.split(rest, "/", parts: 2) do
      [bucket] -> safe_bucket(bucket, "")
      [bucket, prefix] -> safe_bucket(bucket, prefix)
    end
  end

  defp parse_sink(path) when is_binary(path) do
    if String.trim(path) == "" do
      {:error, :missing_artifact_sink}
    else
      {:ok, %{type: :local, root: Path.expand(path)}}
    end
  end

  defp parse_sink(_sink), do: {:error, :invalid_artifact_sink}

  defp safe_bucket(bucket, prefix) do
    cond do
      not Regex.match?(~r/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, bucket) ->
        {:error, {:invalid_s3_bucket, bucket}}

      String.contains?(bucket, "..") ->
        {:error, {:invalid_s3_bucket, bucket}}

      true ->
        with {:ok, prefix} <- safe_prefix(prefix) do
          {:ok, %{type: :s3, bucket: bucket, prefix: prefix}}
        end
    end
  end

  defp safe_prefix(""), do: {:ok, ""}
  defp safe_prefix(prefix), do: safe_relative_name(prefix)

  defp safe_relative_name(name) when is_binary(name) do
    segments = String.split(name, "/", trim: true)

    cond do
      String.trim(name) == "" ->
        {:error, :empty_artifact_name}

      Path.type(name) == :absolute or String.contains?(name, ["\\", <<0>>]) ->
        {:error, {:invalid_artifact_name, name}}

      Enum.any?(segments, &unsafe_path_segment?/1) ->
        {:error, {:invalid_artifact_name, name}}

      true ->
        {:ok, Enum.join(segments, "/")}
    end
  end

  defp safe_relative_name(name), do: {:error, {:invalid_artifact_name, name}}

  defp safe_segment(value) when is_binary(value) do
    if Regex.match?(~r/^[A-Za-z0-9._-]+$/, value) and not unsafe_path_segment?(value) do
      {:ok, value}
    else
      {:error, {:invalid_artifact_segment, value}}
    end
  end

  defp safe_segment(value), do: {:error, {:invalid_artifact_segment, value}}

  defp safe_kind(kind) when is_binary(kind) do
    if Regex.match?(~r/^[a-z][a-z0-9_]*$/, kind), do: {:ok, kind}, else: {:error, {:invalid_artifact_kind, kind}}
  end

  defp safe_kind(kind), do: {:error, {:invalid_artifact_kind, kind}}

  defp safe_filename(value) do
    value
    |> String.replace(~r/[^A-Za-z0-9._-]+/, "_")
    |> String.trim("._-")
    |> case do
      "" -> "command"
      filename -> filename
    end
  end

  defp unsafe_path_segment?(segment), do: segment in ["", ".", ".."] or String.contains?(segment, <<0>>)

  defp ensure_owned_key(key, prefix) do
    if key == prefix or String.starts_with?(key, prefix <> "/") do
      :ok
    else
      {:error, {:artifact_prefix_escape, key, prefix}}
    end
  end

  defp ensure_owned_path(path, root) do
    expanded_path = Path.expand(path)
    expanded_root = Path.expand(root)

    if expanded_path == expanded_root or String.starts_with?(expanded_path, expanded_root <> "/") do
      :ok
    else
      {:error, {:artifact_prefix_escape, expanded_path, expanded_root}}
    end
  end

  defp join_key(parts) do
    parts
    |> List.flatten()
    |> Enum.reject(&is_nil/1)
    |> Enum.map(&to_string/1)
    |> Enum.map(&String.trim(&1, "/"))
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("/")
  end

  defp default_uploader(%{type: :s3}), do: S3
  defp default_uploader(_sink), do: nil

  defp fetch_required(map, key), do: map_value(map, key) || map_value(map, to_string(key))

  defp map_value(map, key) when is_atom(key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))
  defp map_value(map, key) when is_binary(key), do: Map.get(map, key)
end
