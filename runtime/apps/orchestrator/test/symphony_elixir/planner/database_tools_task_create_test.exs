defmodule SymphonyElixir.Planner.DatabaseToolsTaskCreateTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  alias SymphonyElixir.Schema.ExecutionProfile

  test "task.create inherits plan default_repository into metadata when task does not override repository" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/plan"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "workspace_id" => "workspace-1",
                "default_runner_kind" => "codex",
                "metadata" => %{"default_repository" => "parallel-agent-runtime"}
              }
            ])
          )

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert %{
                   "plan_id" => "plan-1",
                   "runner_kind" => "codex",
                   "repository" => "parallel-agent-runtime",
                   "metadata" => %{
                     "runner_kind" => "codex",
                     "repository" => "parallel-agent-runtime",
                     "created_via" => "planner_task_tool",
                     "planner_tool" => "task.create"
                   }
                 } = Jason.decode!(body)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
      end
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "name" => "Draft implementation"
             })
  end

  test "task.create preserves explicit task metadata repository over plan default_repository" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/plan"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "workspace_id" => "workspace-1",
                "metadata" => %{"default_repository" => "parallel-agent-runtime"}
              }
            ])
          )

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)
          assert get_in(payload, ["metadata", "repository"]) == "parallel-agent-platform"
          assert payload["repository"] == "parallel-agent-platform"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
      end
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "name" => "Draft implementation",
               "metadata" => %{"repository" => "parallel-agent-platform"}
             })
  end

  test "task.create applies repository and runner defaults from tool context without a plan" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert %{
               "runner_kind" => "codex",
               "repository" => "parallel-agent-runtime",
               "metadata" => %{
                 "runner_kind" => "codex",
                 "repository" => "parallel-agent-runtime",
                 "created_via" => "planner_task_tool",
                 "planner_tool" => "task.create"
               }
             } = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute(
               "task.create",
               %{"workspace_id" => "workspace-1", "name" => "Draft implementation"},
               default_repository: "parallel-agent-runtime",
               default_runner_kind: "codex"
             )
  end

  test "task.create top-level repository and runner kind override context defaults" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert get_in(Jason.decode!(body), ["metadata", "runner_kind"]) == "local_relay"
      assert get_in(Jason.decode!(body), ["metadata", "repository"]) == "parallel-agent-platform"
      assert Jason.decode!(body)["runner_kind"] == "local_relay"
      assert Jason.decode!(body)["repository"] == "parallel-agent-platform"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Draft implementation",
                 "runner_kind" => "local_relay",
                 "repository" => "parallel-agent-platform"
               },
               default_repository: "parallel-agent-runtime",
               default_runner_kind: "codex"
             )
  end

  test "task.create derives a missing name from description and reports validation feedback" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload["title"] == "Implement auth timeout handling"
      assert payload["instructions"] == "Implement auth timeout handling. Keep the change focused."

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, task} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "description" => "Implement auth timeout handling. Keep the change focused."
               },
               default_runner_kind: "codex"
             )

    assert %{
             "code" => "defaulted_name",
             "field" => "name",
             "recoverable" => true,
             "suggested_default" => "Implement auth timeout handling",
             "ask_user" => false
           } = List.first(task["validation_feedback"])

    assert task["dispatch"]["reason"] == "ready"
  end

  test "task.create truncates derived names on UTF-8 boundaries" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert String.valid?(payload["title"])
      assert String.length(payload["title"]) == 80
      assert String.ends_with?(payload["title"], "é")

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"validation_feedback" => [%{"code" => "defaulted_name"}]}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "description" => String.duplicate("é", 90)
               },
               default_runner_kind: "codex"
             )
  end

  test "task.create returns ask-user validation feedback when repository defaults are ambiguous" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when repository is ambiguous")
    end)

    assert {:error, {:validation_failed, feedback}} =
             DatabaseTools.execute(
               "task.create",
               %{"workspace_id" => "workspace-1", "name" => "Update repo docs"},
               repository_candidates: ["repo-one", "repo-two"]
             )

    assert %{
             "code" => "ambiguous_repository",
             "field" => "repository",
             "recoverable" => true,
             "ask_user" => true
           } = feedback
  end

  test "task.create returns ask-user validation feedback when name cannot be defaulted" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when task name cannot be defaulted")
    end)

    assert {:error, {:validation_failed, feedback}} =
             DatabaseTools.execute("task.create", %{"workspace_id" => "workspace-1"})

    assert %{
             "code" => "missing_name",
             "field" => "name",
             "recoverable" => true,
             "suggested_default" => nil,
             "ask_user" => true
           } = feedback
  end

  test "task.create rejects conflicting top-level and routing runner kinds before posting" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when routing conflicts with runner_kind")
    end)

    assert {:error, {:validation_failed, feedback}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Route conflict",
               "runner_kind" => "codex",
               "routing" => %{"runner_kind" => "manager"}
             })

    assert %{
             "code" => "conflicting_runner_kind",
             "field" => "runner_kind",
             "recoverable" => false,
             "suggested_default" => "codex",
             "ask_user" => false
           } = feedback
  end

  test "task.create verifies supplied plan_id is in the same workspace before inserting" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/plan"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.plan-1",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}])
          )

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "workspace_id" => "workspace-1",
                   "plan_id" => "plan-1",
                   "title" => "Draft implementation",
                   "description" => "Write code",
                   "instructions" => "Implement the runtime change",
                   "state" => "todo",
                   "source" => "planner",
                   "runner_kind" => "codex",
                   "priority" => "high",
                   "labels" => ["runtime"],
                   "next_poll_at" => "2026-05-01T12:00:00Z",
                   "poll_cadence_seconds" => 3600,
                   "manager_runner_id" => "00000000-0000-0000-0000-000000000001",
                   "scheduled_reason" => "manager pickup test",
                   "metadata" => %{
                     "created_via" => "planner_task_tool",
                     "planner_tool" => "task.create",
                     "runner_kind" => "codex",
                     "source" => "planner",
                     "evidence" => [
                       %{"path" => "lib/app.ex", "line" => 12, "snippet" => "def run"}
                     ]
                   }
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "plan_id" => "plan-1",
                "workspace_id" => "workspace-1",
                "title" => "Draft implementation",
                "description" => "Write code",
                "metadata" => %{
                  "evidence" => [%{"path" => "lib/app.ex", "line" => 12, "snippet" => "def run"}]
                }
              }
            ])
          )
      end
    end)

    assert {:ok, task} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "name" => "Draft implementation",
               "description" => "Write code",
               "instructions" => "Implement the runtime change",
               "priority" => "high",
               "labels" => ["runtime"],
               "next_poll_at" => "2026-05-01T12:00:00Z",
               "poll_cadence_seconds" => 3600,
               "manager_runner_id" => "00000000-0000-0000-0000-000000000001",
               "scheduled_reason" => "manager pickup test",
               "metadata" => %{
                 "source" => "planner",
                 "evidence" => [%{"path" => "lib/app.ex", "line" => 12, "snippet" => "def run"}]
               }
             })

    assert %{"id" => "work-item-1", "plan_id" => "plan-1"} = task

    assert [
             %{
               "type" => "planner.task.created",
               "payload" => %{
                 "task_id" => "work-item-1",
                 "plan_id" => "plan-1",
                 "workspace_id" => "workspace-1",
                 "name" => "Draft implementation",
                 "description" => "Write code",
                 "evidence" => [%{"path" => "lib/app.ex", "line" => 12, "snippet" => "def run"}]
               }
             }
           ] = task["_review_events"]
  end

  test "task.create stores structured routing guidance in metadata" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert %{
               "metadata" => %{
                 "created_via" => "planner_task_tool",
                 "planner_tool" => "task.create",
                 "routing" => %{
                   "runner_family" => "workspace_coding",
                   "execution_location" => "local",
                   "transport" => "local_relay",
                   "runner_kind" => "local_model_coding",
                   "intent" => "implement",
                   "rationale" => "Needs repo write access and shell tools on the user's machine."
                 }
               }
             } = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Implement local runner",
               "routing" => %{
                 "runner_family" => "workspace_coding",
                 "execution_location" => "local",
                 "transport" => "local_relay",
                 "runner_kind" => "local_model_coding",
                 "intent" => "implement",
                 "rationale" => "Needs repo write access and shell tools on the user's machine."
               }
             })
  end

  test "task.create stores canonical runner and repository routing fields as columns and metadata" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert %{
               "runner_kind" => "codex",
               "repository" => "parallel-agent-platform",
               "metadata" => %{
                 "created_via" => "planner_task_tool",
                 "planner_tool" => "task.create",
                 "runner_kind" => "codex",
                 "repository" => "parallel-agent-platform"
               }
             } = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Refactor login",
               "runner_kind" => "codex",
               "repository" => "parallel-agent-platform"
             })
  end

  test "task.create resolves planner-local author dependencies before inserting" do
    {:ok, planner_state} = Agent.start_link(fn -> %{author_task_ids: %{}} end)
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)
      send(test_pid, {:work_item_insert, payload})

      id =
        case payload["metadata"]["author_task_id"] do
          "A" -> "work-item-a"
          "B" -> "work-item-b"
        end

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => id, "metadata" => payload["metadata"]}]))
    end)

    assert {:ok, %{"id" => "work-item-a"}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Task A",
                 "author_task_id" => "A"
               },
               planner_state: planner_state
             )

    assert {:ok, %{"id" => "work-item-b"}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Task B",
                 "author_task_id" => "B",
                 "depends_on_author_ids" => ["A"]
               },
               planner_state: planner_state
             )

    assert_received {:work_item_insert,
                     %{
                       "title" => "Task A",
                       "metadata" => %{"author_task_id" => "A"}
                     }}

    assert_received {:work_item_insert,
                     %{
                       "title" => "Task B",
                       "depends_on" => ["work-item-a"],
                       "metadata" => %{"author_task_id" => "B"}
                     }}
  end

  test "task.create merges resolved author dependencies with canonical depends_on values" do
    {:ok, planner_state} = Agent.start_link(fn -> %{author_task_ids: %{"A" => "work-item-a"}} end)

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert %{
               "depends_on" => ["canonical-1", "work-item-a"],
               "metadata" => %{"author_task_id" => "B"}
             } = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-b"}]))
    end)

    assert {:ok, %{"id" => "work-item-b"}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Task B",
                 "author_task_id" => "B",
                 "depends_on" => ["canonical-1", "work-item-a"],
                 "depends_on_author_ids" => ["A"]
               },
               planner_state: planner_state
             )
  end

  test "task.create rejects unknown author dependencies before inserting" do
    {:ok, planner_state} = Agent.start_link(fn -> %{author_task_ids: %{}} end)

    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when author dependencies are unknown")
    end)

    assert {:error, {:unknown_author_task_ids, ["A"]}} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Task B",
                 "depends_on_author_ids" => ["A"]
               },
               planner_state: planner_state
             )
  end

  test "task.create rejects unsupported runner kind before posting" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when runner_kind is invalid")
    end)

    assert {:error, {:invalid_argument, "runner_kind", "must be a supported runner kind"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Bad runner",
               "runner_kind" => "local_runtime"
             })
  end

  test "task.create schema exposes canonical runner kind and repository fields" do
    properties = DatabaseTools.tool_spec("task.create")["inputSchema"]["properties"]

    assert properties["runner_kind"]["enum"] == ExecutionProfile.supported_runner_kinds() ++ [nil]
    assert properties["repository"]["type"] == ["string", "null"]
    assert properties["author_task_id"]["type"] == ["string", "null"]
    assert properties["depends_on_author_ids"]["type"] == ["array", "null"]
    assert properties["when"]["properties"]["mode"]["enum"] == ["planned", "now", "at"]
    assert "implement" in properties["routing"]["properties"]["intent"]["enum"]
    assert "address_review" in properties["routing"]["properties"]["intent"]["enum"]
    assert properties["routing"]["properties"]["runner_kind"]["enum"] == ExecutionProfile.supported_runner_kinds() ++ [nil]
    assert DatabaseTools.tool_spec("task.create")["inputSchema"]["required"] == []
  end

  test "task.create when at atomically sets manager pickup state and next_poll_at" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload["state"] == "awaiting_review"
      assert payload["next_poll_at"] == "2026-05-01T12:00:00Z"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "work-item-1")]))
    end)

    assert {:ok, %{"id" => "work-item-1", "state" => "awaiting_review"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Manager pickup",
               "routing" => %{"intent" => "follow_up"},
               "when" => %{
                 "mode" => "at",
                 "at" => "2026-05-01T12:00:00Z",
                 "state" => "awaiting_review"
               }
             })
  end

  test "task.create returns dispatch readiness summaries for dependency and future-poll blockers" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "work-item-1")]))
    end)

    assert {:ok, blocked} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Blocked task",
                 "runner_kind" => "codex",
                 "depends_on" => ["work-item-0"]
               }
             )

    assert blocked["dispatch"] == %{
             "eligible" => false,
             "reason" => "blocked_by_dependencies",
             "blocked_by" => ["work-item-0"],
             "runner_kind" => "codex",
             "repository" => nil
           }

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "work-item-2")]))
    end)

    assert {:ok, waiting} =
             DatabaseTools.execute(
               "task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "name" => "Future task",
                 "runner_kind" => "codex",
                 "next_poll_at" => "2099-05-01T12:00:00Z"
               }
             )

    assert waiting["dispatch"]["reason"] == "waiting_until_next_poll_at"
    refute waiting["dispatch"]["eligible"]
  end

  test "task.create omits nil poll cadence instead of posting null" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload["next_poll_at"] == "2026-05-01T12:00:00Z"
      refute Map.has_key?(payload, "poll_cadence_seconds")

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Manager pickup",
               "state" => "running",
               "next_poll_at" => "2026-05-01T12:00:00Z",
               "poll_cadence_seconds" => nil
             })
  end

  test "task.create rejects non-object routing guidance" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when routing is invalid")
    end)

    assert {:error, {:invalid_argument, "routing", "must be an object"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Bad route",
               "routing" => "codex"
             })
  end

  test "task.create rejects a plan_id that does not resolve inside the workspace" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/plan"
      assert URI.decode_query(conn.query_string)["workspace_id"] == "eq.workspace-1"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([]))
    end)

    assert {:error, {:plan_not_found, "plan-2", "workspace-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-2",
               "name" => "Draft implementation"
             })
  end

  test "task.create omits blank plan_id instead of posting an empty UUID" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/work_items"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert Jason.decode!(body) == %{
               "workspace_id" => "workspace-1",
               "title" => "Draft implementation",
               "instructions" => "Draft implementation",
               "state" => "todo",
               "source" => "planner",
               "runner_kind" => "codex",
               "metadata" => %{
                 "created_via" => "planner_task_tool",
                 "planner_tool" => "task.create",
                 "runner_kind" => "codex"
               }
             }

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "work-item-1"}]))
    end)

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.create", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "",
               "name" => "Draft implementation"
             })
  end
end
