defmodule SymphonyElixir.WorkerBridge.RepositoryManagerTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.RepoCache.Diagnostics, as: RepoCacheDiagnostics
  alias SymphonyElixir.WorkerBridge.RepositoryManager

  setup do
    root =
      Path.join(System.tmp_dir!(), "worker_bridge_root_#{System.unique_integer([:positive])}")

    previous_root = Application.get_env(:symphony_elixir, :worker_bridge_root)
    previous_cache_root = Application.get_env(:symphony_elixir, :worker_bridge_repo_cache_root)
    Application.put_env(:symphony_elixir, :worker_bridge_root, root)
    Application.delete_env(:symphony_elixir, :worker_bridge_repo_cache_root)

    repo_path =
      Path.join(
        System.tmp_dir!(),
        "worker_bridge_source_repo_#{System.unique_integer([:positive])}"
      )

    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, "README.md"), "# test\n")
    git!(["add", "README.md"], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    on_exit(fn ->
      if is_nil(previous_root) do
        Application.delete_env(:symphony_elixir, :worker_bridge_root)
      else
        Application.put_env(:symphony_elixir, :worker_bridge_root, previous_root)
      end

      if is_nil(previous_cache_root) do
        Application.delete_env(:symphony_elixir, :worker_bridge_repo_cache_root)
      else
        Application.put_env(:symphony_elixir, :worker_bridge_repo_cache_root, previous_cache_root)
      end

      File.rm_rf!(root)
      File.rm_rf!(repo_path)
    end)

    %{repo_path: repo_path, root: root}
  end

  test "prepares a session workspace from a local repository", %{repo_path: repo_path} do
    assert {:ok, workspace_path} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_1"
             )

    assert File.dir?(workspace_path)
    assert File.exists?(Path.join(workspace_path, ".git"))
    assert File.exists?(Path.join(workspace_path, "README.md"))
  end

  test "uses configured worker bridge root for cache and session paths", %{
    repo_path: repo_path,
    root: root
  } do
    assert {:ok, workspace_path} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_config_root"
             )

    assert String.starts_with?(RepositoryManager.root_dir(), root)
    assert String.starts_with?(RepositoryManager.repo_cache_root(), root)
    assert String.starts_with?(RepositoryManager.session_root(), root)
    assert String.starts_with?(workspace_path, RepositoryManager.session_root())
  end

  test "uses configured mirror cache root separate from per-session workspaces", %{
    repo_path: repo_path,
    root: root
  } do
    cache_root =
      Path.join(System.tmp_dir!(), "worker_bridge_efs_cache_#{System.unique_integer([:positive])}")

    Application.put_env(:symphony_elixir, :worker_bridge_repo_cache_root, cache_root)

    on_exit(fn -> File.rm_rf!(cache_root) end)

    assert {:ok, workspace_path} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_efs_cache_root"
             )

    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(cache_root, repo_id)

    assert RepositoryManager.repo_cache_root() == cache_root
    assert File.dir?(cache_path)
    assert String.starts_with?(workspace_path, Path.join(root, "sessions"))
    refute String.starts_with?(workspace_path, cache_root)
  end

  test "stores repository cache as a bare mirror and records metadata", %{repo_path: repo_path} do
    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)
    metadata_path = Path.join(cache_path, ".symphony-cache.json")

    assert {:ok, _workspace_path} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_mirror"
             )

    assert File.dir?(cache_path)
    refute File.dir?(Path.join(cache_path, ".git"))
    assert bare_repo?(cache_path)

    metadata = metadata_path |> File.read!() |> Jason.decode!()
    assert metadata["repo_id"] == repo_id
    assert metadata["repo_url"] == Path.expand(repo_path)
    assert metadata["cache_kind"] == "mirror"
    assert is_binary(metadata["last_fetched_at"])
    assert is_binary(metadata["last_fetched_revision"])
    assert metadata["last_cache_event"] == "miss"
    assert metadata["last_cache_hit"] == false
    assert is_integer(metadata["last_fetch_ms"])
    assert metadata["lock_strategy"] == "efs_lock_dir"
  end

  test "records private repository credential references without secret values", %{
    repo_path: repo_path
  } do
    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)
    metadata_path = Path.join(cache_path, ".symphony-cache.json")

    assert {:ok, _workspace_path} =
             RepositoryManager.prepare_workspace(
               %{
                 "url" => repo_path,
                 "ref" => "main",
                 "resource_id" => "repo-resource-1",
                 "resource_type" => "github_repository",
                 "resource_grant" => %{
                   "id" => "grant-1",
                   "credential_ref" => %{
                     "source" => "github_app_installation_token",
                     "id" => "installation-1",
                     "token" => "ghs_do_not_write"
                   }
                 }
               },
               "worker_test_private_metadata"
             )

    metadata_text = File.read!(metadata_path)
    refute metadata_text =~ "ghs_do_not_write"

    metadata = Jason.decode!(metadata_text)
    assert metadata["resource_id"] == "repo-resource-1"
    assert metadata["resource_type"] == "github_repository"
    assert metadata["resource_grant_id"] == "grant-1"
    assert metadata["credential_source"] == "github_app_installation_token"
    assert metadata["credential_ref"] == "installation-1"
  end

  test "refreshes an existing mirror before materializing the next workspace", %{
    repo_path: repo_path
  } do
    assert {:ok, first_workspace} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_refresh_1"
             )

    refute File.exists?(Path.join(first_workspace, "SECOND.md"))

    File.write!(Path.join(repo_path, "SECOND.md"), "new commit\n")
    git!(["add", "SECOND.md"], cd: repo_path)
    git!(["commit", "-m", "second"], cd: repo_path)

    assert {:ok, second_workspace} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_refresh_2"
             )

    assert File.exists?(Path.join(second_workspace, "SECOND.md"))

    repo_id = RepositoryManager.repo_id(repo_path)
    metadata_path = Path.join([RepositoryManager.repo_cache_root(), repo_id, ".symphony-cache.json"])
    metadata = metadata_path |> File.read!() |> Jason.decode!()

    workspace_metadata =
      second_workspace
      |> Path.join(".symphony-workspace.json")
      |> File.read!()
      |> Jason.decode!()

    assert metadata["last_cache_event"] == "hit"
    assert metadata["last_cache_hit"] == true
    assert is_integer(metadata["last_fetch_ms"])
    assert workspace_metadata["cache_hit"] == true
    assert is_integer(workspace_metadata["checkout_ms"])
  end

  test "materializes two isolated target workspaces from one durable mirror", %{
    repo_path: repo_path,
    root: root
  } do
    first_workspace = Path.join(root, "orchestrator-workspaces/issue-1")
    second_workspace = Path.join(root, "orchestrator-workspaces/issue-2")
    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)

    assert {:ok,
            %{
              repo_id: ^repo_id,
              cache_path: ^cache_path,
              cache_hit: false,
              materialization_method: "clone"
            }} =
             RepositoryManager.materialize_workspace(
               %{"url" => repo_path, "ref" => "main"},
               first_workspace
             )

    assert {:ok,
            %{
              repo_id: ^repo_id,
              cache_path: ^cache_path,
              cache_hit: true,
              materialization_method: "clone"
            }} =
             RepositoryManager.materialize_workspace(
               %{"url" => repo_path, "ref" => "main"},
               second_workspace
             )

    assert first_workspace != second_workspace
    assert File.exists?(Path.join(first_workspace, "README.md"))
    assert File.exists?(Path.join(second_workspace, "README.md"))
    assert bare_repo?(cache_path)

    first_metadata =
      first_workspace
      |> Path.join(".symphony-workspace.json")
      |> File.read!()
      |> Jason.decode!()

    second_metadata =
      second_workspace
      |> Path.join(".symphony-workspace.json")
      |> File.read!()
      |> Jason.decode!()

    assert first_metadata["repo_id"] == repo_id
    assert first_metadata["cache_path"] == cache_path
    assert first_metadata["ref"] == "main"
    assert first_metadata["cache_hit"] == false
    assert first_metadata["materialization_method"] == "clone"
    assert is_integer(first_metadata["checkout_duration_ms"])

    assert second_metadata["repo_id"] == repo_id
    assert second_metadata["cache_path"] == cache_path
    assert second_metadata["cache_hit"] == true
    assert second_metadata["materialization_method"] == "clone"
  end

  test "rebuilds a corrupted mirror cache entry", %{repo_path: repo_path} do
    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)
    head_path = Path.join(cache_path, "HEAD")

    assert {:ok, _workspace_path} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_rebuild_1"
             )

    File.rm!(head_path)

    assert {:ok, rebuilt_workspace} =
             RepositoryManager.prepare_workspace(
               %{"url" => repo_path, "ref" => "main"},
               "worker_test_rebuild_2"
             )

    assert File.exists?(head_path)
    assert File.exists?(Path.join(rebuilt_workspace, "README.md"))
    assert bare_repo?(cache_path)

    metadata = cache_path |> Path.join(".symphony-cache.json") |> File.read!() |> Jason.decode!()
    assert metadata["last_cache_event"] == "rebuild"
    assert metadata["last_cache_hit"] == false
    assert metadata["rebuild_count"] == 1
    assert is_binary(metadata["last_rebuild_reason"])
  end

  test "serializes concurrent mirror writers with an EFS-safe lock directory", %{repo_path: repo_path} do
    parent = self()

    tasks =
      Enum.map(1..4, fn index ->
        Task.async(fn ->
          send(parent, {:ready, self()})

          receive do
            :go ->
              RepositoryManager.prepare_workspace(
                %{"url" => repo_path, "ref" => "main"},
                "worker_test_concurrent_#{index}"
              )
          end
        end)
      end)

    pids =
      Enum.map(tasks, fn _task ->
        assert_receive {:ready, pid}, 1_000
        pid
      end)

    Enum.each(pids, &send(&1, :go))

    assert Enum.all?(Enum.map(tasks, &Task.await(&1, 5_000)), &match?({:ok, _}, &1))

    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)
    metadata = cache_path |> Path.join(".symphony-cache.json") |> File.read!() |> Jason.decode!()

    assert bare_repo?(cache_path)
    assert metadata["last_cache_event"] in ["miss", "hit"]
    refute File.exists?(Path.join([RepositoryManager.repo_cache_root(), ".locks", "#{repo_id}.lock"]))
  end

  test "smoke: two same-repo workspaces reuse the warm cache and remain isolated", %{
    repo_path: repo_path
  } do
    repo_id = RepositoryManager.repo_id(repo_path)
    cache_path = Path.join(RepositoryManager.repo_cache_root(), repo_id)

    log =
      capture_log(fn ->
        assert {:ok, first_workspace} =
                 RepositoryManager.prepare_workspace(
                   %{"url" => repo_path, "ref" => "main"},
                   "worker_test_smoke_1"
                 )

        assert {:ok, second_workspace} =
                 RepositoryManager.prepare_workspace(
                   %{"url" => repo_path, "ref" => "main"},
                   "worker_test_smoke_2"
                 )

        assert first_workspace != second_workspace
        assert File.dir?(first_workspace)
        assert File.dir?(second_workspace)
        assert File.dir?(cache_path)

        first_metadata =
          first_workspace
          |> Path.join(".symphony-workspace.json")
          |> File.read!()
          |> Jason.decode!()

        second_metadata =
          second_workspace
          |> Path.join(".symphony-workspace.json")
          |> File.read!()
          |> Jason.decode!()

        assert first_metadata["cache_hit"] == false
        assert second_metadata["cache_hit"] == true
        assert second_metadata["cache_path"] == cache_path
        assert second_metadata["checkout_ms"] >= 0

        snapshot = RepoCacheDiagnostics.snapshot()
        assert Enum.any?(snapshot.repositories, &(&1.repo_id == repo_id))
        assert Enum.any?(snapshot.active_workspaces, &(&1["workspace_path"] == first_workspace))
        assert Enum.any?(snapshot.active_workspaces, &(&1["workspace_path"] == second_workspace))

        assert :ok = RepositoryManager.cleanup_workspace(first_workspace)
        assert :ok = RepositoryManager.cleanup_workspace(second_workspace)

        refute File.exists?(first_workspace)
        refute File.exists?(second_workspace)
        assert File.dir?(cache_path)
      end)

    events = json_log_events(log)

    assert Enum.any?(
             events,
             &match?(
               %{
                 "event" => "repo_workspace_materialized",
                 "cache_hit" => true,
                 "checkout_method" => "clone_from_mirror",
                 "selected_slot" => "worker_bridge_local"
               },
               &1
             )
           )

    assert Enum.any?(
             events,
             &match?(
               %{
                 "event" => "repo_workspace_cleanup",
                 "mirror_preserved" => true
               },
               &1
             )
           )
  end

  test "prepares multiple repository resources under deterministic aliases", %{
    repo_path: repo_path
  } do
    second_repo = create_repo!("worker_bridge_second_repo", "SECOND.md", "second repo\n")
    first_commit = git_output!(["rev-parse", "HEAD"], cd: repo_path)
    second_commit = git_output!(["rev-parse", "HEAD"], cd: second_repo)

    on_exit(fn -> File.rm_rf!(second_repo) end)

    assert {:ok, workspace_path, resources} =
             RepositoryManager.prepare_resources(
               [
                 %{
                   "id" => "resource-1",
                   "grant_id" => "grant-1",
                   "alias" => "runtime_repo",
                   "url" => repo_path,
                   "ref" => first_commit
                 },
                 %{
                   "id" => "resource-2",
                   "grant_id" => "grant-2",
                   "alias" => "platform_repo",
                   "url" => second_repo,
                   "ref" => second_commit
                 }
               ],
               "worker_test_resources"
             )

    runtime_path = Path.join([workspace_path, "resources", "runtime_repo"])
    platform_path = Path.join([workspace_path, "resources", "platform_repo"])

    assert File.exists?(Path.join(runtime_path, "README.md"))
    assert File.exists?(Path.join(platform_path, "SECOND.md"))

    assert [
             %{
               "alias" => "runtime_repo",
               "path" => ^runtime_path,
               "status" => "available",
               "commit" => ^first_commit
             },
             %{
               "alias" => "platform_repo",
               "path" => ^platform_path,
               "status" => "available",
               "commit" => ^second_commit
             }
           ] = resources
  end

  test "rejects unsafe resource aliases", %{repo_path: repo_path} do
    assert {:error, {:invalid_resource_alias, "../outside"}} =
             RepositoryManager.prepare_resources(
               [%{"alias" => "../outside", "url" => repo_path, "ref" => "main"}],
               "worker_test_bad_alias"
             )
  end

  test "fails when a required resource is unavailable", %{repo_path: repo_path} do
    missing_repo =
      Path.join(System.tmp_dir!(), "missing_repo_#{System.unique_integer([:positive])}")

    assert {:error, {:required_resource_unavailable, "missing_repo", error, statuses}} =
             RepositoryManager.prepare_resources(
               [
                 %{"alias" => "runtime_repo", "url" => repo_path, "ref" => "main"},
                 %{
                   "alias" => "missing_repo",
                   "url" => missing_repo,
                   "ref" => "main",
                   "required" => true
                 }
               ],
               "worker_test_required_missing"
             )

    assert is_binary(error)

    assert [
             %{"alias" => "runtime_repo", "status" => "available"},
             %{"alias" => "missing_repo", "status" => "unavailable"}
           ] = statuses
  end

  test "continues when an optional resource is unavailable", %{repo_path: repo_path} do
    missing_repo =
      Path.join(System.tmp_dir!(), "missing_repo_#{System.unique_integer([:positive])}")

    assert {:ok, workspace_path, resources} =
             RepositoryManager.prepare_resources(
               [
                 %{"alias" => "runtime_repo", "url" => repo_path, "ref" => "main"},
                 %{
                   "alias" => "optional_repo",
                   "url" => missing_repo,
                   "ref" => "main",
                   "required" => false
                 }
               ],
               "worker_test_optional_missing"
             )

    assert File.exists?(Path.join([workspace_path, "resources", "runtime_repo", "README.md"]))

    assert [
             %{"alias" => "runtime_repo", "status" => "available"},
             %{"alias" => "optional_repo", "status" => "unavailable", "required" => false}
           ] = resources
  end

  describe "sanitize_url/1" do
    test "strips basic-auth credentials from absolute URLs" do
      assert RepositoryManager.sanitize_url("https://user:pass@host.example/repo.git") ==
               "https://host.example/repo.git"

      assert RepositoryManager.sanitize_url("https://token@host.example/repo") ==
               "https://host.example/repo"

      assert RepositoryManager.sanitize_url("ssh://user@host.example/repo") ==
               "ssh://host.example/repo"
    end

    test "returns URL unchanged when no userinfo is present" do
      assert RepositoryManager.sanitize_url("https://host.example/repo.git") ==
               "https://host.example/repo.git"
    end

    test "tolerates scheme-less / non-absolute inputs" do
      assert RepositoryManager.sanitize_url("/local/path/to/repo") == "/local/path/to/repo"
    end

    test "falls back to regex stripper for URI.new-rejected inputs" do
      assert RepositoryManager.sanitize_url("git@github.com:foo/bar.git") ==
               "git@github.com:foo/bar.git"

      assert RepositoryManager.sanitize_url("not a valid url at all") ==
               "not a valid url at all"
    end

    test "passes non-binary inputs through unchanged" do
      assert RepositoryManager.sanitize_url(nil) == nil
      assert RepositoryManager.sanitize_url(:not_a_url) == :not_a_url
    end
  end

  test "redacts embedded URL credentials from exported resource status" do
    private_url = "https://secret-token@/private-repo"

    assert {:ok, _workspace_path, [status]} =
             RepositoryManager.prepare_resources(
               [
                 %{
                   "alias" => "optional_repo",
                   "url" => private_url,
                   "ref" => "main",
                   "required" => false
                 }
               ],
               "worker_test_redacted_status"
             )

    assert status["status"] == "unavailable"
    assert status["locator"] == "https:///private-repo"
    refute status["locator"] =~ "secret-token"
    refute status["error"] =~ "secret-token"
  end

  test "redacts embedded URL credentials from diagnostics snapshots" do
    registry_name = :"repo-cache-registry-#{System.unique_integer([:positive])}"
    start_supervised!({SymphonyElixir.RepoCache.Registry, name: registry_name})

    private_url = "https://token@example.com/private/repo.git"
    workspace_path = Path.join(RepositoryManager.session_root(), "worker_test_private_diagnostics")
    File.mkdir_p!(workspace_path)

    File.write!(
      Path.join(workspace_path, ".symphony-workspace.json"),
      Jason.encode!(%{
        "repo_id" => "repo-private",
        "repo_url" => private_url,
        "metadata" => %{"origin_url" => private_url}
      })
    )

    assert {:ok, _repository} =
             SymphonyElixir.RepoCache.Registry.upsert_repository(registry_name, %{
               repo_id: "repo-private",
               repo_url: private_url,
               cache_kind: "mirror",
               refresh_state: "ready",
               metadata: %{"origin_url" => private_url}
             })

    snapshot = RepoCacheDiagnostics.snapshot(registry_name)

    assert [%{repo_url: "https://example.com/private/repo.git", metadata: metadata}] =
             snapshot.repositories

    refute metadata["origin_url"] =~ "token"

    assert Enum.any?(snapshot.active_workspaces, fn workspace ->
             workspace["workspace_path"] == workspace_path and
               workspace["repo_url"] == "https://example.com/private/repo.git" and
               workspace["metadata"]["origin_url"] == "https://example.com/private/repo.git"
           end)
  end

  defp bare_repo?(path) do
    case System.cmd("git", ["--git-dir", path, "rev-parse", "--is-bare-repository"], stderr_to_stdout: true) do
      {"true\n", 0} -> true
      _ -> false
    end
  end

  defp git!(args, opts) do
    case System.cmd("git", args, Keyword.merge([stderr_to_stdout: true], opts)) do
      {_output, 0} -> :ok
      {output, status} -> raise "git failed status=#{status}: #{output}"
    end
  end

  defp git_output!(args, opts) do
    case System.cmd("git", args, Keyword.merge([stderr_to_stdout: true], opts)) do
      {output, 0} -> String.trim(output)
      {output, status} -> raise "git failed status=#{status}: #{output}"
    end
  end

  defp create_repo!(prefix, filename, contents) do
    repo_path = Path.join(System.tmp_dir!(), "#{prefix}_#{System.unique_integer([:positive])}")
    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, filename), contents)
    git!(["add", filename], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    repo_path
  end

  defp json_log_events(log) do
    Regex.scan(~r/\{.*\}/, log)
    |> Enum.map(fn [line] -> Jason.decode(line) end)
    |> Enum.flat_map(fn
      {:ok, event} -> [event]
      _ -> []
    end)
  end
end
