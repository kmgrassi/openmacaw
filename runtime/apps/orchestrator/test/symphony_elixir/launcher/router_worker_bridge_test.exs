defmodule SymphonyElixir.Launcher.RouterWorkerBridgeTest do
  use SymphonyElixir.Launcher.RouterTestSupport

  test "POST /worker-bridge/sessions launches codex session from kind payload" do
    cwd =
      Path.join(
        SymphonyElixir.Config.settings!().workspace.root,
        "worker-bridge-cwd-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(cwd) end)

    conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "cwd" => cwd,
        "credentials" => %{
          "OPENAI_API_KEY" => %{
            "source" => "inline",
            "value" => "test-key"
          }
        }
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert {:ok, canonical_cwd} = PathSafety.canonicalize(cwd)
    assert body["data"]["id"] =~ ~r/^worker_/
    assert body["data"]["kind"] == "codex"
    assert body["data"]["command"] == SymphonyElixir.Config.settings!().codex.command
    assert body["data"]["cwd"] == canonical_cwd
    assert body["data"]["credential_keys"] == ["OPENAI_API_KEY"]
    assert body["data"]["env_keys"] == ["OPENAI_API_KEY"]
    assert body["data"]["status"] == "running"
  end

  test "POST /worker-bridge/sessions accepts repository intent" do
    repo_path =
      Path.join(
        System.tmp_dir!(),
        "worker_bridge_router_repo_#{System.unique_integer([:positive])}"
      )

    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, "README.md"), "# router\n")
    git!(["add", "README.md"], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    on_exit(fn ->
      File.rm_rf!(repo_path)
    end)

    conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "repository" => %{"url" => repo_path, "ref" => "main"},
        "command" => "test -f README.md && sleep 5"
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["cwd"] =~ "worker_"
  end

  test "POST /worker-bridge/sessions launches from agent identity" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1"
      }
    ])

    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-1:OPENAI_API_KEY",
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        env_var: "OPENAI_API_KEY",
        launchable_kind: "codex",
        has_secret: true,
        secret_value: "sk-test"
      }
    ])

    conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "agent_id" => "agent-1",
        "workspace_id" => "workspace-1",
        "credential_id" => "cred-1:OPENAI_API_KEY"
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["agent_id"] == "agent-1"
    assert body["data"]["workspace_id"] == "workspace-1"
    assert body["data"]["credential_id"] == "cred-1:OPENAI_API_KEY"
    assert body["data"]["cwd"] =~ "/workspace-1/agent-1"
    assert body["data"]["env_keys"] == ["OPENAI_API_KEY"]
  end

  test "GET /worker-bridge/sessions returns sessions" do
    cwd =
      Path.join(
        SymphonyElixir.Config.settings!().workspace.root,
        "worker-bridge-list-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(cwd) end)

    conn(:post, "/worker-bridge/sessions", %{
      "kind" => "codex",
      "cwd" => cwd,
      "command" => "sleep 5"
    })
    |> put_req_header("content-type", "application/json")
    |> call()

    conn =
      conn(:get, "/worker-bridge/sessions")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert length(body["data"]) == 1
  end

  test "DELETE /worker-bridge/sessions/:id stops a session" do
    cwd =
      Path.join(
        SymphonyElixir.Config.settings!().workspace.root,
        "worker-bridge-delete-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(cwd) end)

    create_conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "cwd" => cwd,
        "command" => "sleep 5"
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    id = Jason.decode!(create_conn.resp_body)["data"]["id"]

    conn =
      conn(:delete, "/worker-bridge/sessions/#{id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["status"] == "stopped"
  end

  test "POST /worker-bridge/sessions rejects cwd outside workspace root" do
    cwd =
      Path.join(System.tmp_dir!(), "outside-worker-bridge-#{System.unique_integer([:positive])}")

    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(cwd) end)

    conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "cwd" => cwd,
        "credentials" => %{
          "OPENAI_API_KEY" => %{
            "source" => "inline",
            "value" => "test-key"
          }
        }
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "outside_workspace_root"
  end

  test "POST /worker-bridge/sessions rejects non-string env values" do
    cwd =
      Path.join(
        SymphonyElixir.Config.settings!().workspace.root,
        "worker-bridge-env-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(cwd) end)

    conn =
      conn(:post, "/worker-bridge/sessions", %{
        "kind" => "codex",
        "cwd" => cwd,
        "env" => %{"RETRY_COUNT" => 1},
        "credentials" => %{
          "OPENAI_API_KEY" => %{
            "source" => "inline",
            "value" => "test-key"
          }
        }
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] == "invalid_env"
  end
end
