defmodule SymphonyElixir.WorkerBridge.RepositoryManager do
  @moduledoc """
  Prepares local workspaces for worker bridge sessions.

  Repository caches are stored as durable bare mirrors under the worker bridge
  root, while per-session workspaces are materialized as disposable clones.
  """

  require Logger

  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.WorkerBridge.RepositoryCredential
  alias SymphonyElixir.WorkerBridge.RepositoryManager.Metadata
  alias SymphonyElixir.WorkerBridge.RepositoryManager.MirrorLock

  @askpass_filename "git-askpass.sh"
  @alias_pattern ~r/^[a-z0-9_-]+$/
  # Default mirror-lock wait: 10 minutes. A large repo clone over EFS can
  # legitimately take many minutes, so timing out concurrent requests just
  # causes the second request to retry the same slow path. The previous 30s
  # timeout caused avoidable failures during normal load bursts when one
  # worker held the lock for a slow initial mirror. Override via
  # `:mirror_lock_timeout_ms` application env when running in environments
  # with different latency characteristics.
  #
  # Future option: detect that the lock holder is still actively progressing
  # (e.g., bump the lock dir's mtime as a heartbeat) and extend the wait
  # while progress is being made. For now the conservative fix is a
  # generous, configurable timeout.
  @default_lock_timeout_ms :timer.minutes(10)

  @type repository_spec :: %{required(String.t()) => term()}
  @type materialized_resource :: %{required(String.t()) => term()}

  @spec prepare_workspace(repository_spec(), String.t()) :: {:ok, Path.t()} | {:error, term()}
  def prepare_workspace(%{"url" => url} = repository, session_id)
      when is_binary(url) and is_binary(session_id) do
    with :ok <- ensure_git_available(),
         {:ok, normalized_url} <- normalize_repository_url(url),
         repo_id <- repo_id(safe_locator(normalized_url)),
         {:ok, credential} <- RepositoryCredential.resolve(repository),
         {:ok, cache_result} <-
           ensure_mirror_cache(repository, normalized_url, repo_id, credential),
         {:ok, workspace_path, checkout_ms, materialization_method} <-
           create_session_workspace(cache_result.cache_path, repository, session_id, repo_id),
         :ok <-
           record_workspace_metadata(
             workspace_path,
             cache_result,
             repository,
             checkout_ms,
             materialization_method
           ),
         :ok <- touch_registry(cache_result, checkout_ms) do
      RuntimeLog.log(:info, :repo_workspace_materialized, %{
        repo_id: repo_id,
        cache_path: cache_result.cache_path,
        cache_hit: cache_result.cache_hit,
        cache_event: cache_result.cache_event,
        checkout_method: "clone_from_mirror",
        checkout_duration_ms: checkout_ms,
        fetch_duration_ms: cache_result.fetch_ms,
        workspace_path: workspace_path,
        selected_slot: "worker_bridge_local"
      })

      {:ok, workspace_path}
    end
  end

  def prepare_workspace(_repository, _session_id), do: {:error, :invalid_repository}

  @spec materialize_workspace(repository_spec() | String.t(), Path.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def materialize_workspace(repository, workspace_path, opts \\ [])

  def materialize_workspace(repository, workspace_path, opts)
      when is_binary(repository) and is_binary(workspace_path) do
    materialize_workspace(%{"url" => repository}, workspace_path, opts)
  end

  def materialize_workspace(%{"url" => url} = repository, workspace_path, opts)
      when is_binary(url) and is_binary(workspace_path) do
    method = Keyword.get(opts, :method, :clone)
    repo_cache_root = Keyword.get(opts, :repo_cache_root)

    with_repo_cache_root(repo_cache_root, fn ->
      with :ok <- ensure_git_available(),
           {:ok, normalized_url} <- normalize_repository_url(url),
           repo_id <- repo_id(safe_locator(normalized_url)),
           {:ok, credential} <- RepositoryCredential.resolve(repository),
           {:ok, cache_result} <-
             ensure_mirror_cache(repository, normalized_url, repo_id, credential),
           {:ok, checkout_ms, materialization_method} <-
             create_workspace_from_cache(cache_result.cache_path, repository, workspace_path, method),
           :ok <-
             record_workspace_metadata(
               workspace_path,
               cache_result,
               repository,
               checkout_ms,
               materialization_method
             ),
           :ok <- touch_registry(cache_result, checkout_ms) do
        {:ok,
         %{
           repo_id: cache_result.repo_id,
           cache_path: cache_result.cache_path,
           ref: Map.get(repository, "ref"),
           cache_hit: cache_result.cache_hit,
           materialization_method: materialization_method,
           checkout_ms: checkout_ms
         }}
      end
    end)
  end

  def materialize_workspace(_repository, _workspace_path, _opts), do: {:error, :invalid_repository}

  @spec prepare_resources([repository_spec()], String.t()) ::
          {:ok, Path.t(), [materialized_resource()]} | {:error, term()}
  def prepare_resources(resources, session_id)
      when is_list(resources) and is_binary(session_id) do
    with :ok <- ensure_git_available(),
         {:ok, normalized_resources} <- normalize_resources(resources),
         {:ok, workspace_path} <- create_resource_workspace(normalized_resources, session_id) do
      workspace_path
      |> materialize_resources(normalized_resources)
      |> case do
        {:ok, statuses} ->
          {:ok, workspace_path, statuses}

        {:error, reason} ->
          File.rm_rf!(workspace_path)
          {:error, reason}
      end
    end
  end

  def prepare_resources(_resources, _session_id), do: {:error, :invalid_resources}

  @spec cleanup_workspace(Path.t()) :: :ok | {:error, term()}
  def cleanup_workspace(workspace_path) when is_binary(workspace_path) do
    with :ok <- assert_child_path(workspace_path, session_root()) do
      metadata = Metadata.workspace_metadata(workspace_path)
      started_at = System.monotonic_time()

      result =
        case File.rm_rf(workspace_path) do
          {:ok, _removed} -> :ok
          {:error, reason, path} -> {:error, {:workspace_cleanup_failed, path, reason}}
        end

      RuntimeLog.log(result_level(result), :repo_workspace_cleanup, %{
        repo_id: Map.get(metadata, "repo_id"),
        cache_path: Map.get(metadata, "cache_path"),
        workspace_path: workspace_path,
        cleanup_duration_ms: duration_ms_since(started_at),
        mirror_preserved: cache_path_present?(Map.get(metadata, "cache_path")),
        error_code: error_code(result)
      })

      result
    end
  end

  def cleanup_workspace(_workspace_path), do: {:error, :invalid_workspace_path}

  @spec active_workspaces() :: [map()]
  def active_workspaces do
    sessions = session_root()

    case File.ls(sessions) do
      {:ok, entries} ->
        entries
        |> Enum.map(&Path.join(sessions, &1))
        |> Enum.filter(&File.dir?/1)
        |> Enum.flat_map(&Metadata.workspace_snapshot/1)
        |> Enum.sort_by(&Map.get(&1, "workspace_path"))

      {:error, :enoent} ->
        []

      {:error, _reason} ->
        []
    end
  end

  @spec root_dir() :: Path.t()
  def root_dir do
    Application.get_env(:symphony_elixir, :worker_bridge_root) ||
      System.get_env("SYMPHONY_WORKER_BRIDGE_ROOT") ||
      Path.join(System.tmp_dir!(), "symphony_worker_bridge")
  end

  @spec repo_cache_root() :: Path.t()
  def repo_cache_root do
    configured_repo_cache_root() || Path.join(root_dir(), "repo-cache")
  end

  @spec session_root() :: Path.t()
  def session_root do
    Path.join(root_dir(), "sessions")
  end

  @spec repo_id(String.t() | repository_spec()) :: String.t()
  def repo_id(%{"url" => url}) when is_binary(url) do
    {:ok, normalized_url} = normalize_repository_url(url)
    repo_id(safe_locator(normalized_url))
  end

  def repo_id(url) when is_binary(url) do
    slug = slugify(url)
    short_hash = :crypto.hash(:sha256, url) |> Base.encode16(case: :lower) |> binary_part(0, 12)
    "#{slug}-#{short_hash}"
  end

  defp ensure_git_available do
    case System.find_executable("git") do
      nil -> {:error, :git_not_found}
      _ -> :ok
    end
  end

  defp normalize_repository_url(url) when is_binary(url) do
    normalized =
      url
      |> String.trim()
      |> case do
        "" -> ""
        value -> normalize_repository_value(value)
      end

    if normalized == "", do: {:error, :empty_repository_url}, else: {:ok, normalized}
  end

  defp normalize_repository_value(value) do
    cond do
      local_path?(value) ->
        value
        |> Path.expand()
        |> String.trim_trailing("/")

      true ->
        value
        |> String.trim_trailing("/")
        |> String.replace(~r/\.git$/, "")
    end
  end

  defp local_path?(value) do
    not String.contains?(value, "://") and
      not String.starts_with?(value, "git@")
  end

  defp ensure_mirror_cache(repository, normalized_url, repo_id, credential) do
    File.mkdir_p!(repo_cache_root())
    cache_path = cache_path(repo_id)

    with_mirror_lock(repo_id, fn ->
      case mirror_state(cache_path, normalized_url) do
        :ready ->
          refresh_mirror(cache_path, normalized_url, repo_id, credential, repository)

        :missing ->
          bootstrap_mirror(cache_path, normalized_url, repo_id, credential, repository)

        {:corrupt, reason} ->
          Logger.warning("Worker bridge mirror cache corrupt repo_id=#{repo_id} path=#{cache_path} reason=#{inspect(reason)}")

          rebuild_mirror(cache_path, normalized_url, repo_id, credential, repository, reason)
      end
    end)
  end

  defp mirror_state(cache_path, normalized_url) do
    cond do
      not File.exists?(cache_path) ->
        :missing

      not File.dir?(cache_path) ->
        {:corrupt, :not_a_directory}

      true ->
        with :ok <- assert_bare_repository(cache_path),
             :ok <- assert_origin_url(cache_path, normalized_url) do
          :ready
        else
          {:error, reason} -> {:corrupt, reason}
        end
    end
  end

  defp assert_bare_repository(cache_path) do
    case git(["--git-dir", cache_path, "rev-parse", "--is-bare-repository"]) do
      {:ok, output} ->
        if String.trim(output) == "true",
          do: :ok,
          else: {:error, {:not_bare_repository, String.trim(output)}}

      {:error, reason} ->
        {:error, {:invalid_repository, reason}}
    end
  end

  defp assert_origin_url(cache_path, normalized_url) do
    case git(["--git-dir", cache_path, "remote", "get-url", "origin"]) do
      {:ok, output} ->
        case normalize_repository_url(output) do
          {:ok, ^normalized_url} -> :ok
          {:ok, other} -> {:error, {:origin_mismatch, other}}
          {:error, reason} -> {:error, {:invalid_origin_url, reason}}
        end

      {:error, reason} ->
        {:error, {:missing_origin, reason}}
    end
  end

  defp bootstrap_mirror(cache_path, normalized_url, repo_id, credential, repository) do
    File.rm_rf!(cache_path)

    {fetch_ms, result} =
      timed(fn -> git(["clone", "--mirror", normalized_url, cache_path], credential) end)

    with {:ok, _output} <- result,
         {:ok, cache_result} <-
           record_cache_metadata(cache_path, normalized_url, repo_id, repository, credential, %{
             cache_event: "miss",
             cache_hit: false,
             fetch_ms: fetch_ms
           }) do
      log_cache_event("bootstrapped", repo_id, cache_path, cache_result.revision, fetch_ms)
      log_structured_cache_event(cache_result, "bootstrapped")
      {:ok, cache_result}
    else
      {:error, reason} ->
        File.rm_rf!(cache_path)
        {:error, {:repository_clone_failed, safe_locator(normalized_url), reason}}
    end
  end

  defp refresh_mirror(cache_path, normalized_url, repo_id, credential, repository) do
    {fetch_ms, result} =
      timed(fn ->
        git(["--git-dir", cache_path, "remote", "update", "--prune"], credential)
      end)

    with {:ok, _output} <- result,
         {:ok, cache_result} <-
           record_cache_metadata(cache_path, normalized_url, repo_id, repository, credential, %{
             cache_event: "hit",
             cache_hit: true,
             fetch_ms: fetch_ms
           }) do
      log_cache_event("refreshed", repo_id, cache_path, cache_result.revision, fetch_ms)
      log_structured_cache_event(cache_result, "refreshed")
      {:ok, cache_result}
    else
      {:error, reason} ->
        {:error, {:repository_fetch_failed, cache_path, reason}}
    end
  end

  defp rebuild_mirror(cache_path, normalized_url, repo_id, credential, repository, reason) do
    File.rm_rf!(cache_path)

    {fetch_ms, result} =
      timed(fn -> git(["clone", "--mirror", normalized_url, cache_path], credential) end)

    with {:ok, _output} <- result,
         {:ok, cache_result} <-
           record_cache_metadata(cache_path, normalized_url, repo_id, repository, credential, %{
             cache_event: "rebuild",
             cache_hit: false,
             fetch_ms: fetch_ms,
             rebuild_reason: inspect(reason)
           }) do
      Logger.info("Worker bridge mirror cache rebuilt repo_id=#{repo_id} path=#{cache_path} reason=#{inspect(reason)} fetch_ms=#{fetch_ms}")

      log_structured_cache_event(cache_result, "rebuilt")
      {:ok, cache_result}
    else
      {:error, clone_reason} ->
        File.rm_rf!(cache_path)
        {:error, {:repository_clone_failed, normalized_url, clone_reason}}
    end
  end

  defp record_cache_metadata(cache_path, normalized_url, repo_id, repository, credential, telemetry) do
    fetched_at = DateTime.utc_now() |> DateTime.truncate(:second)
    revision = mirror_revision(cache_path)

    metadata =
      %{
        "repo_id" => repo_id,
        "repo_url" => safe_locator(normalized_url),
        "cache_kind" => "mirror",
        "last_fetched_at" => DateTime.to_iso8601(fetched_at),
        "last_fetched_revision" => revision,
        "last_cache_event" => telemetry.cache_event,
        "last_cache_hit" => telemetry.cache_hit,
        "last_fetch_ms" => telemetry.fetch_ms,
        "rebuild_count" => rebuild_count(cache_path, telemetry.cache_event),
        "lock_strategy" => "efs_lock_dir"
      }
      |> Map.merge(resource_metadata(repository))
      |> Map.merge(credential_metadata(credential))
      |> maybe_put("last_rebuild_reason", telemetry[:rebuild_reason])

    with :ok <- Metadata.write_cache_metadata(cache_path, metadata) do
      {:ok,
       %{
         repo_id: repo_id,
         repo_url: normalized_url,
         cache_path: cache_path,
         cache_kind: "mirror",
         fetched_at: fetched_at,
         revision: revision,
         cache_event: telemetry.cache_event,
         cache_hit: telemetry.cache_hit,
         fetch_ms: telemetry.fetch_ms,
         rebuild_reason: telemetry[:rebuild_reason],
         metadata: metadata
       }}
    end
  end

  defp mirror_revision(cache_path) do
    case git(["--git-dir", cache_path, "rev-parse", "--verify", "HEAD"]) do
      {:ok, output} -> String.trim(output)
      {:error, _reason} -> nil
    end
  end

  defp create_session_workspace(cache_path, repository, session_id, repo_id) do
    File.mkdir_p!(session_root())
    workspace_path = Path.join(session_root(), session_slug(repo_id, session_id))

    case create_workspace_from_cache(cache_path, repository, workspace_path, :clone) do
      {:ok, checkout_ms, materialization_method} ->
        {:ok, workspace_path, checkout_ms, materialization_method}

      {:error, reason} ->
        {:error, {:workspace_prepare_failed, workspace_path, reason}}
    end
  end

  defp create_workspace_from_cache(cache_path, repository, workspace_path, method) do
    File.mkdir_p!(Path.dirname(workspace_path))
    File.rm_rf!(workspace_path)

    {checkout_ms, result} =
      timed(fn -> materialize_checkout(cache_path, workspace_path, repository, method) end)

    case result do
      {:ok, materialization_method} ->
        {:ok, checkout_ms, materialization_method}

      {:error, reason} ->
        File.rm_rf!(workspace_path)
        {:error, reason}
    end
  end

  defp materialize_checkout(cache_path, workspace_path, repository, :worktree) do
    case worktree_checkout(cache_path, workspace_path, repository) do
      :ok ->
        {:ok, "worktree"}

      {:error, _reason} ->
        File.rm_rf!(workspace_path)
        clone_checkout(cache_path, workspace_path, repository)
    end
  end

  defp materialize_checkout(cache_path, workspace_path, repository, _method) do
    clone_checkout(cache_path, workspace_path, repository)
  end

  defp clone_checkout(cache_path, workspace_path, repository) do
    with {:ok, _output} <- git(["clone", cache_path, workspace_path]),
         :ok <- maybe_checkout_ref(workspace_path, repository) do
      {:ok, "clone"}
    end
  end

  defp worktree_checkout(cache_path, workspace_path, repository) do
    ref = repository_ref(repository)

    with {:ok, _output} <-
           git(["--git-dir", cache_path, "worktree", "add", "--detach", workspace_path, ref]),
         :ok <- maybe_checkout_ref(workspace_path, repository) do
      :ok
    end
  end

  defp normalize_resources([]), do: {:error, :invalid_resources}

  defp normalize_resources(resources) do
    resources
    |> Enum.reduce_while({:ok, [], MapSet.new()}, fn resource, {:ok, acc, aliases} ->
      with {:ok, normalized} <- normalize_resource(resource),
           alias_value = normalized["alias"],
           false <- MapSet.member?(aliases, alias_value) do
        {:cont, {:ok, [normalized | acc], MapSet.put(aliases, alias_value)}}
      else
        true -> {:halt, {:error, {:duplicate_resource_alias, Map.get(resource, "alias")}}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, normalized, _aliases} -> {:ok, Enum.reverse(normalized)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp normalize_resource(%{"url" => url, "alias" => alias_value} = resource)
       when is_binary(url) and is_binary(alias_value) do
    with {:ok, normalized_url} <- normalize_repository_url(url),
         {:ok, alias_value} <- normalize_alias(alias_value) do
      {:ok,
       resource
       |> Map.put("url", normalized_url)
       |> Map.put("alias", alias_value)
       |> Map.put_new("required", true)}
    end
  end

  defp normalize_resource(_resource), do: {:error, :invalid_resource}

  defp normalize_alias(alias_value) when is_binary(alias_value) do
    alias_value = String.trim(alias_value)

    if String.match?(alias_value, @alias_pattern),
      do: {:ok, alias_value},
      else: {:error, {:invalid_resource_alias, alias_value}}
  end

  defp create_resource_workspace(resources, session_id) do
    File.mkdir_p!(session_root())
    workspace_path = Path.join(session_root(), session_slug("resources", session_id))
    resources_path = Path.join(workspace_path, "resources")
    File.rm_rf!(workspace_path)
    File.mkdir_p!(resources_path)

    resources
    |> Enum.map(&Path.join(resources_path, &1["alias"]))
    |> Enum.reduce_while(:ok, fn path, :ok ->
      case assert_child_path(path, resources_path) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      :ok -> {:ok, workspace_path}
      {:error, reason} -> {:error, reason}
    end
  end

  defp materialize_resources(workspace_path, resources) do
    resources_root = Path.join(workspace_path, "resources")

    resources
    |> Enum.reduce_while({:ok, []}, fn resource, {:ok, statuses} ->
      status = materialize_resource(resources_root, resource)
      updated_statuses = [status | statuses]

      cond do
        status["status"] == "available" ->
          {:cont, {:ok, updated_statuses}}

        resource_required?(resource) ->
          {:halt, {:error, {:required_resource_unavailable, resource["alias"], status["error"], Enum.reverse(updated_statuses)}}}

        true ->
          {:cont, {:ok, updated_statuses}}
      end
    end)
    |> case do
      {:ok, statuses} -> {:ok, Enum.reverse(statuses)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp materialize_resource(resources_root, resource) do
    alias_value = resource["alias"]
    target_path = Path.join(resources_root, alias_value)
    sanitized_url = sanitize_url(resource["url"])

    base_status = %{
      "resource_id" => Map.get(resource, "resource_id") || Map.get(resource, "id"),
      "grant_id" => Map.get(resource, "grant_id") || get_in(resource, ["grant", "id"]),
      "alias" => alias_value,
      "path" => target_path,
      "kind" => Map.get(resource, "kind", "repository"),
      "provider" => Map.get(resource, "provider", "git"),
      "locator" => sanitized_url,
      "ref" => Map.get(resource, "ref"),
      "required" => resource_required?(resource),
      "credential_ref" => Map.get(resource, "credential_ref") || get_in(resource, ["grant", "credential_ref"])
    }

    with :ok <- assert_child_path(target_path, resources_root),
         repo_id <- repo_id(sanitized_url),
         {:ok, credential} <- RepositoryCredential.resolve(resource),
         {:ok, cache_result} <-
           ensure_mirror_cache(resource, resource["url"], repo_id, credential),
         {:ok, _materialization_method} <-
           clone_checkout(cache_result.cache_path, target_path, resource) do
      Map.merge(base_status, %{
        "status" => "available",
        "commit" => workspace_revision(target_path),
        "error" => nil
      })
    else
      {:error, reason} ->
        Map.merge(base_status, %{
          "status" => "unavailable",
          "commit" => nil,
          "error" => Metadata.safe_error(reason, resource["url"])
        })
    end
  end

  @doc """
  Removes any embedded basic-auth credentials from a URL so the resulting
  string is safe to expose in logs, status maps, or child-process env vars.

  Falls back to a regex-based stripper for inputs that `URI.parse/1` cannot
  faithfully round-trip (e.g. bare `git@` SSH URLs or non-URL strings).
  """
  @spec sanitize_url(any()) :: any()
  def sanitize_url(url) when is_binary(url) do
    Metadata.sanitize_url(url)
  end

  def sanitize_url(other), do: other

  defp safe_locator(locator) when is_binary(locator) do
    Metadata.safe_locator(locator)
  end

  defp safe_locator(locator), do: locator

  defp resource_required?(%{"required" => false}), do: false
  defp resource_required?(%{"required" => "false"}), do: false
  defp resource_required?(_resource), do: true

  defp workspace_revision(workspace_path) do
    case git(["-C", workspace_path, "rev-parse", "--verify", "HEAD"]) do
      {:ok, output} -> String.trim(output)
      {:error, _reason} -> nil
    end
  end

  defp assert_child_path(path, root) do
    expanded_path = Path.expand(path)
    expanded_root = Path.expand(root)

    if String.starts_with?(expanded_path <> "/", expanded_root <> "/"),
      do: :ok,
      else: {:error, {:resource_path_outside_workspace, expanded_path, expanded_root}}
  end

  defp maybe_checkout_ref(_workspace_path, %{"ref" => ref}) when ref in [nil, ""], do: :ok

  defp maybe_checkout_ref(_workspace_path, %{} = repository)
       when not is_map_key(repository, "ref"), do: :ok

  defp maybe_checkout_ref(workspace_path, %{"ref" => ref}) when is_binary(ref) do
    case git(["-C", workspace_path, "checkout", ref]) do
      {:ok, _output} ->
        :ok

      {:error, _reason} ->
        checkout_remote_branch(workspace_path, ref)
    end
  end

  defp checkout_remote_branch(workspace_path, ref) do
    with {:ok, _output} <- git(["-C", workspace_path, "fetch", "--all", "--prune"]),
         {:ok, _output} <- git(["-C", workspace_path, "checkout", "-B", ref, "origin/#{ref}"]) do
      :ok
    else
      {:error, reason} -> {:error, {:repository_checkout_failed, ref, reason}}
    end
  end

  defp repository_ref(%{"ref" => ref}) when is_binary(ref) and ref != "", do: ref
  defp repository_ref(_repository), do: "HEAD"

  defp cache_path(repo_id) do
    Path.join(repo_cache_root(), repo_id)
  end

  defp session_slug(repo_id, session_id) do
    "#{repo_id}-#{session_id}"
  end

  defp slugify(value) do
    value
    |> String.downcase()
    |> String.replace(~r/^https?:\/\//, "")
    |> String.replace(~r/^ssh:\/\//, "")
    |> String.replace(~r/[^a-z0-9._-]+/, "-")
    |> String.trim("-")
    |> case do
      "" -> "repo"
      slug -> slug
    end
  end

  defp log_cache_event(action, repo_id, cache_path, revision, fetch_ms) do
    Logger.info("Worker bridge mirror cache #{action} repo_id=#{repo_id} path=#{cache_path} revision=#{revision || "unknown"} fetch_ms=#{fetch_ms}")
  end

  defp log_structured_cache_event(cache_result, action) do
    RuntimeLog.log(:info, :repo_cache_event, %{
      repo_id: cache_result.repo_id,
      cache_path: cache_result.cache_path,
      cache_kind: cache_result.cache_kind,
      cache_event: cache_result.cache_event,
      cache_hit: cache_result.cache_hit,
      fetch_duration_ms: cache_result.fetch_ms,
      revision: cache_result.revision,
      action: action
    })
  end

  defp resource_metadata(repository) when is_map(repository) do
    %{
      "resource_id" => Map.get(repository, "resource_id"),
      "resource_type" => Map.get(repository, "resource_type"),
      "resource_grant_id" => Map.get(repository, "grant_id") || get_in(repository, ["resource_grant", "id"])
    }
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end

  defp credential_metadata(nil), do: %{}

  defp credential_metadata(%RepositoryCredential{} = credential) do
    %{
      "credential_source" => credential.source,
      "credential_ref" => credential.ref
    }
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end

  defp git(args, credential \\ nil) when is_list(args) do
    cmd_opts =
      [stderr_to_stdout: true]
      |> maybe_put_git_credential_env(credential)

    case System.cmd("git", args, cmd_opts) do
      {output, 0} ->
        {:ok, output}

      {output, status} ->
        sanitized = output |> redact_credential_output(credential) |> String.slice(0, 1000)
        Logger.warning("Worker bridge git command failed status=#{status} output=#{inspect(sanitized)}")
        {:error, {:git_failed, status, redact_credential_output(output, credential)}}
    end
  end

  defp maybe_put_git_credential_env(opts, nil), do: opts

  defp maybe_put_git_credential_env(opts, %RepositoryCredential{} = credential) do
    Keyword.put(opts, :env, [
      {"GIT_ASKPASS", askpass_path!()},
      {"GIT_TERMINAL_PROMPT", "0"},
      {"SYMPHONY_GIT_USERNAME", credential.username},
      {"SYMPHONY_GIT_PASSWORD", credential.token}
    ])
  end

  defp askpass_path! do
    File.mkdir_p!(root_dir())
    path = Path.join(root_dir(), @askpass_filename)

    unless File.exists?(path) do
      File.write!(path, askpass_script())
      File.chmod!(path, 0o700)
    end

    path
  end

  defp askpass_script do
    """
    #!/bin/sh
    case "$1" in
      *Username*) printf '%s\\n' "$SYMPHONY_GIT_USERNAME" ;;
      *Password*) printf '%s\\n' "$SYMPHONY_GIT_PASSWORD" ;;
      *) printf '%s\\n' "$SYMPHONY_GIT_PASSWORD" ;;
    esac
    """
  end

  defp redact_credential_output(output, nil), do: output || ""

  defp redact_credential_output(output, %RepositoryCredential{token: token}) do
    output = output || ""

    if is_binary(token) and token != "" do
      String.replace(output, token, "[REDACTED]")
    else
      output
    end
  end

  defp configured_repo_cache_root do
    Process.get(:symphony_worker_bridge_repo_cache_root) ||
      Application.get_env(:symphony_elixir, :worker_bridge_repo_cache_root) ||
      System.get_env("SYMPHONY_WORKER_BRIDGE_REPO_CACHE_ROOT") ||
      System.get_env("SYMPHONY_REPO_CACHE_ROOT")
  end

  defp with_repo_cache_root(nil, fun), do: fun.()

  defp with_repo_cache_root(repo_cache_root, fun) when is_binary(repo_cache_root) and is_function(fun, 0) do
    previous = Process.get(:symphony_worker_bridge_repo_cache_root)
    Process.put(:symphony_worker_bridge_repo_cache_root, repo_cache_root)

    try do
      fun.()
    after
      case previous do
        nil -> Process.delete(:symphony_worker_bridge_repo_cache_root)
        value -> Process.put(:symphony_worker_bridge_repo_cache_root, value)
      end
    end
  end

  defp lock_root do
    Path.join(repo_cache_root(), ".locks")
  end

  defp with_mirror_lock(repo_id, fun) when is_function(fun, 0) do
    MirrorLock.with_lock(lock_root(), repo_id, lock_timeout_ms(), fun)
  end

  defp lock_timeout_ms do
    Application.get_env(:symphony_elixir, :mirror_lock_timeout_ms, @default_lock_timeout_ms)
  end

  defp rebuild_count(cache_path, "rebuild") do
    Metadata.previous_cache_metadata(cache_path)
    |> Map.get("rebuild_count", 0)
    |> case do
      count when is_integer(count) -> count + 1
      _ -> 1
    end
  end

  defp rebuild_count(cache_path, _event) do
    Metadata.previous_cache_metadata(cache_path)
    |> Map.get("rebuild_count", 0)
    |> case do
      count when is_integer(count) -> count
      _ -> 0
    end
  end

  defp record_workspace_metadata(
         workspace_path,
         cache_result,
         repository,
         checkout_ms,
         materialization_method
       ) do
    metadata =
      %{
        "repo_id" => cache_result.repo_id,
        "repo_url" => cache_result.repo_url,
        "cache_path" => cache_result.cache_path,
        "cache_kind" => cache_result.cache_kind,
        "cache_event" => cache_result.cache_event,
        "cache_hit" => cache_result.cache_hit,
        "fetch_ms" => cache_result.fetch_ms,
        "checkout_ms" => checkout_ms,
        "checkout_duration_ms" => checkout_ms,
        "materialization_method" => materialization_method,
        "ref" => Map.get(repository, "ref"),
        "revision" => workspace_revision(workspace_path),
        "recorded_at" => DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
      }
      |> maybe_put("rebuild_reason", cache_result.rebuild_reason)

    Metadata.write_workspace_metadata(workspace_path, metadata)
  end

  defp cache_path_present?(cache_path) when is_binary(cache_path), do: File.dir?(cache_path)
  defp cache_path_present?(_cache_path), do: nil

  defp touch_registry(cache_result, checkout_ms) do
    case Process.whereis(SymphonyElixir.RepoCache.Registry) do
      nil ->
        :ok

      _pid ->
        _ =
          SymphonyElixir.RepoCache.Registry.upsert_repository(%{
            repo_id: cache_result.repo_id,
            repo_url: cache_result.repo_url,
            cache_path: cache_result.cache_path,
            cache_kind: cache_result.cache_kind,
            last_fetched_at: cache_result.fetched_at,
            last_used_at: DateTime.utc_now(),
            refresh_state: "ready",
            metadata:
              Map.merge(cache_result.metadata, %{
                "last_checkout_ms" => checkout_ms
              })
          })

        :ok
    end
  end

  defp timed(fun) when is_function(fun, 0) do
    started = System.monotonic_time(:millisecond)
    result = fun.()
    {System.monotonic_time(:millisecond) - started, result}
  end

  defp duration_ms_since(started_at) do
    System.convert_time_unit(System.monotonic_time() - started_at, :native, :millisecond)
  end

  defp result_level(:ok), do: :info
  defp result_level({:error, _reason}), do: :error

  defp error_code(:ok), do: nil
  defp error_code({:error, reason}), do: inspect(reason, limit: 10)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
