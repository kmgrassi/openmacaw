defmodule SymphonyElixir.Integration.PlannerLocalSmokeTest do
  @moduledoc """
  End-to-end smoke for the planner-on-local path.

  Stubs the local-relay registry plus a PostgREST endpoint so the
  planner can dispatch a turn through `LocalRelay`, round-trip a
  `task.create` tool call, and complete — all in-process. Catches wire
  regressions on the planner-local path without needing a real helper
  binary or network. See `docs/local-model-readiness-runtime-prs.md`
  PR4.
  """

  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Orchestrator
  alias SymphonyElixir.Runner.Planner
  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.WorkItem

  setup do
    Req.Test.set_req_test_to_shared(%{})

    Application.put_env(:symphony_elixir, :planner_responses_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :planner_database_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :planner_database_tools_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :database_tracker_req_options, plug: {Req.Test, __MODULE__})

    Registry.reset!()

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :planner_responses_req_options)
      Application.delete_env(:symphony_elixir, :planner_database_tools)
      Application.delete_env(:symphony_elixir, :planner_database_tools_req_options)
      Application.delete_env(:symphony_elixir, :database_tracker_req_options)
      Registry.reset!()
    end)

    :ok
  end

  test "dispatches a planner turn, round-trips task.create, and emits turn events" do
    test_pid = self()
    helper = start_planner_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "local", model: "qwen"}]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"GET", "/rest/v1/plan"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}]))

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:work_items_post, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              %{
                "id" => "work-item-smoke",
                "workspace_id" => "workspace-1",
                "plan_id" => "plan-1",
                "title" => "Planner local smoke task"
              }
            ])
          )
      end
    end)

    on_message = fn message -> send(test_pid, {:planner_event, message}) end

    {:ok, session} =
      Planner.start_session(
        %{
          "execution_profile" => %{"provider" => "local", "model" => "qwen"},
          "model" => "qwen",
          "agent" => %{
            id: "agent-1",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          },
          on_message: on_message
        },
        nil
      )

    assert session.model_client == SymphonyElixir.Planner.ModelClient.LocalRelay

    work_item = %WorkItem{id: "work-1", identifier: "PLAN-1", title: "Plan work"}

    assert {:ok, %{"output_text" => "Created the task locally."}} =
             Planner.run_turn(session, "Create one task", work_item)

    # Helper received the dispatch frame in provider format.
    assert_received {:planner_dispatch,
                     %{
                       "runner_kind" => "planner",
                       "target_runner_kind" => "openai_compatible",
                       "provider" => "local",
                       "tool_calling_mode" => "cloud_managed",
                       "provider_tool_specs" => provider_tool_specs
                     }}

    provider_names = Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"]))
    assert "task_create" in provider_names

    # task.create round-tripped through the runtime tool executor.
    assert_received {:work_items_post,
                     %{
                       "workspace_id" => "workspace-1",
                       "plan_id" => "plan-1",
                       "title" => "Planner local smoke task",
                       "source" => "planner"
                     }}

    # Continuation frame carried the tool result back to the helper.
    assert_received {:planner_continuation, %{"messages" => messages, "tool_call_iteration" => 1}}
    assert Enum.any?(messages, &match?(%{"role" => "tool", "name" => "task.create"}, &1))

    # The planner's tool-calling loop emitted lifecycle events.
    assert_received {:planner_event, %{event: :turn_started}}
    assert_received {:planner_event, %{event: :tool_call_started, payload: %{"tool_name" => "task.create"}}}
    assert_received {:planner_event, %{event: :tool_call_completed, payload: %{"tool_name" => "task.create"}}}
    assert_received {:planner_event, %{event: :turn_completed, message: "Created the task locally."}}
  end

  test "local relay dispatch omits tools removed from effective grants" do
    test_pid = self()
    helper = start_planner_complete_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "local", model: "qwen"}]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    effective_tool_names =
      ToolRegistry.planner_tool_specs()
      |> Enum.map(& &1["name"])
      |> Kernel.--(["task.create"])

    {:ok, session} =
      Planner.start_session(
        %{
          "execution_profile" => %{"provider" => "local", "model" => "qwen"},
          "model" => "qwen",
          "tool_definitions" => ToolRegistry.specs(effective_tool_names),
          "agent" => %{
            id: "agent-1",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          }
        },
        nil
      )

    assert {:ok, %{"output_text" => "Grant-scoped dispatch completed."}} =
             Planner.run_turn(session, "Create one task", %WorkItem{id: "work-1", identifier: "PLAN-1"})

    assert_received {:planner_dispatch,
                     %{
                       "tool_definitions" => tool_definitions,
                       "provider_tool_specs" => provider_tool_specs
                     }}

    refute "task.create" in Enum.map(tool_definitions, & &1["name"])
    refute "task_create" in Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"]))
    assert "plan_create" in Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"]))
  end

  test "returns retryable local_runtime_offline when no helper is registered" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    {:ok, session} =
      Planner.start_session(
        %{
          "execution_profile" => %{"provider" => "local", "model" => "qwen"},
          "model" => "qwen",
          "agent" => %{
            id: "agent-1",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          }
        },
        nil
      )

    assert session.model_client == SymphonyElixir.Planner.ModelClient.LocalRelay

    work_item = %WorkItem{id: "work-1", identifier: "PLAN-1", title: "Plan work"}

    assert {:error, {:retryable, :local_runtime_offline}} =
             Planner.run_turn(session, "Create one task", work_item)
  end

  test "planner-created multi-repo work items are polled and dispatched to declared local runners" do
    test_pid = self()
    rows = start_supervised!({Agent, fn -> %{plans: %{}, work_items: %{}, refresh_counts: %{}} end})

    write_workflow_file!(
      Application.get_env(:symphony_elixir, :workflow_file_path),
      tracker_kind: "database",
      tracker_endpoint: "https://test.supabase.co/rest/v1",
      tracker_api_token: "test-api-key",
      tracker_table: "work_items",
      tracker_workspace_id: "workspace-1",
      tracker_active_states: ["todo"],
      tracker_terminal_states: ["done"],
      poll_interval_ms: 50,
      max_concurrent_agents: 3,
      max_turns: 1
    )

    helper = start_dispatch_probe_helper(test_pid, 3)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      max_dispatches: 3,
      runners: [
        %{runner_kind: "codex", provider: "local", model: "qwen"},
        %{runner_kind: "openclaw", provider: "local", model: "qwen"},
        %{runner_kind: "local_model_coding", provider: "local", model: "qwen"}
      ]
    })

    Req.Test.stub(__MODULE__, postgrest_stub(rows, test_pid))

    planner_helper = start_multi_repo_planner_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "planner-machine",
      pid: planner_helper,
      runners: [%{runner_kind: "openai_compatible", provider: "local", model: "qwen"}]
    })

    {:ok, session} =
      Planner.start_session(
        %{
          "execution_profile" => %{"provider" => "local", "model" => "qwen"},
          "model" => "qwen",
          "agent" => %{
            id: "planner-agent",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          }
        },
        nil
      )

    assert {:ok, %{"output_text" => "Created a multi-repo plan."}} =
             Planner.run_turn(session, "Create the multi-repo routing smoke plan", work_item())

    assert_received {:plan_post, %{"workspace_id" => "workspace-1", "name" => "Multi Repo Smoke"}}

    assert_task_created("repo-a", "codex")
    assert_task_created("repo-b", "openclaw")
    assert_task_created("repo-c", "local_model_coding")

    workflow_file = Application.fetch_env!(:symphony_elixir, :workflow_file_path)

    dispatches =
      [
        {"repo-a", "codex"},
        {"repo-b", "openclaw"},
        {"repo-c", "local_model_coding"}
      ]
      |> Enum.reduce(%{}, fn {repository_id, runner_kind}, acc ->
        write_workflow_file!(
          workflow_file,
          tracker_kind: "database",
          tracker_endpoint: "https://test.supabase.co/rest/v1",
          tracker_api_token: "test-api-key",
          tracker_table: "work_items",
          tracker_workspace_id: "workspace-1",
          tracker_repository: repository_id,
          tracker_active_states: ["todo"],
          tracker_terminal_states: ["done"],
          poll_interval_ms: 50,
          max_concurrent_agents: 3,
          max_turns: 1
        )

        orchestrator_name = String.to_atom("runtime5-orchestrator-#{repository_id}")

        {:ok, orchestrator} =
          start_supervised(%{
            id: {:orchestrator, repository_id},
            start: {Orchestrator, :start_link, [[name: orchestrator_name]]}
          })

        repo_dispatch = collect_dispatches(%{}, 1, 3_000)
        GenServer.stop(orchestrator)

        assert %{^repository_id => ^runner_kind} = repo_dispatch
        Map.merge(acc, repo_dispatch)
      end)

    assert dispatches == %{
             "repo-a" => "codex",
             "repo-b" => "openclaw",
             "repo-c" => "local_model_coding"
           }
  end

  test "next local planner start uses the changed effective grant tool set" do
    test_pid = self()
    helper = start_completion_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "local", model: "qwen"}]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    {:ok, first_session} =
      Planner.start_session(planner_config(ToolRegistry.specs(["task.create"])), nil)

    assert {:ok, %{"output_text" => "completed"}} =
             Planner.run_turn(first_session, "Use current grants", work_item())

    assert_received {:planner_dispatch, first_frame}
    assert provider_tool_names(first_frame) == ["task_create"]

    {:ok, second_session} =
      Planner.start_session(planner_config(ToolRegistry.specs(["plan.create"])), nil)

    assert {:ok, %{"output_text" => "completed"}} =
             Planner.run_turn(second_session, "Use changed grants", work_item())

    assert_received {:planner_dispatch, second_frame}
    assert provider_tool_names(second_frame) == ["plan_create"]
  end

  defp start_planner_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:planner_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-task",
                "name" => "task_create",
                "arguments" => %{
                  "plan_id" => "plan-1",
                  "name" => "Planner local smoke task"
                }
              }
            ]
          })

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:planner_continuation, continuation})
              Registry.complete(correlation_id, %{"output_text" => "Created the task locally."})
          end
      end
    end)
  end

  defp start_multi_repo_planner_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:planner_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-plan",
                "name" => "plan_create",
                "arguments" => %{
                  "name" => "Multi Repo Smoke",
                  "description" => "Planner canonical routing smoke"
                }
              },
              task_tool_call("call-task-a", "repo-a", "codex"),
              task_tool_call("call-task-b", "repo-b", "openclaw"),
              task_tool_call("call-task-c", "repo-c", "local_model_coding")
            ]
          })

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:planner_continuation, continuation})
              Registry.complete(correlation_id, %{"output_text" => "Created a multi-repo plan."})
          end
      end
    end)
  end

  defp task_tool_call(id, repository_id, runner_kind) do
    %{
      "id" => id,
      "name" => "task_create",
      "arguments" => %{
        "plan_id" => "plan-runtime-5",
        "name" => "Implement #{repository_id}",
        "routing" => %{
          "runner_kind" => runner_kind,
          "intent" => "implement",
          "rationale" => "runtime smoke"
        },
        "metadata" => %{
          "repository_id" => repository_id,
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_relay",
            "provider" => "local",
            "model" => "qwen",
            "adapter_config" => %{
              "workspace_id" => "workspace-1",
              "target_runner_kind" => runner_kind
            },
            "source_metadata" => %{"source" => "planner_routing_smoke"}
          }
        }
      }
    }
  end

  defp start_dispatch_probe_helper(parent, expected_count) do
    spawn_link(fn -> dispatch_probe_loop(parent, expected_count) end)
  end

  defp dispatch_probe_loop(_parent, 0), do: :ok

  defp dispatch_probe_loop(parent, remaining) do
    receive do
      {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
        send(parent, {:worker_dispatch, frame})
        Registry.complete(correlation_id, %{"output_text" => "done"})
        dispatch_probe_loop(parent, remaining - 1)
    end
  end

  defp postgrest_stub(rows, parent) do
    fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          json(conn, 200, [])

        {"POST", "/rest/v1/plan"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)
          send(parent, {:plan_post, payload})

          plan =
            payload
            |> Map.put("id", "plan-runtime-5")
            |> Map.put_new("workspace_id", "workspace-1")

          Agent.update(rows, &put_in(&1, [:plans, plan["id"]], plan))
          json(conn, 201, [plan])

        {"GET", "/rest/v1/plan"} ->
          query = URI.decode_query(conn.query_string)
          id = eq_value(query["id"])
          workspace_id = eq_value(query["workspace_id"])

          plans =
            rows
            |> Agent.get(&Map.values(&1.plans))
            |> Enum.filter(&(&1["id"] == id and &1["workspace_id"] == workspace_id))

          json(conn, 200, plans)

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)
          route = get_in(payload, ["metadata", "routing"]) || %{}
          repository_id = get_in(payload, ["metadata", "repository_id"])
          runner_kind = Map.get(route, "runner_kind")
          send(parent, {:work_item_post, repository_id, runner_kind, payload})

          row =
            payload
            |> Map.put("id", "work-item-#{repository_id}")
            |> Map.put("identifier", "WI-#{repository_id}")
            |> Map.put_new("state", "todo")
            |> Map.put("created_at", "2026-05-19T00:00:00Z")
            |> Map.put("updated_at", "2026-05-19T00:00:00Z")

          Agent.update(rows, &put_in(&1, [:work_items, row["id"]], row))
          json(conn, 201, [row])

        {"GET", "/rest/v1/work_items"} ->
          query = URI.decode_query(conn.query_string)
          rows_for_query = Agent.get(rows, &Map.values(&1.work_items))

          response =
            cond do
              Map.has_key?(query, "id") ->
                ids = in_values(query["id"])

                Enum.map(ids, fn id ->
                  Agent.get_and_update(rows, fn state ->
                    row = Map.fetch!(state.work_items, id)
                    refresh_count = Map.get(state.refresh_counts, id, 0)
                    row_state = if refresh_count == 0, do: "todo", else: "done"

                    {
                      Map.put(row, "state", row_state),
                      put_in(state, [:refresh_counts, id], refresh_count + 1)
                    }
                  end)
                end)

              true ->
                workspace_id = eq_value(query["workspace_id"])

                Enum.filter(rows_for_query, fn row ->
                  row["workspace_id"] == workspace_id and row["state"] == "todo"
                end)
            end

          json(conn, 200, response)
      end
    end
  end

  defp assert_task_created(repository_id, runner_kind) do
    assert_received {:work_item_post, ^repository_id, ^runner_kind,
                     %{
                       "metadata" => %{
                         "execution_profile" => %{
                           "runner_kind" => "local_relay",
                           "adapter_config" => %{"target_runner_kind" => ^runner_kind}
                         },
                         "routing" => %{"runner_kind" => ^runner_kind}
                       }
                     }}
  end

  defp collect_dispatches(dispatches, expected_count, timeout_ms)

  defp collect_dispatches(dispatches, expected_count, _timeout_ms)
       when map_size(dispatches) == expected_count,
       do: dispatches

  defp collect_dispatches(dispatches, expected_count, timeout_ms) do
    receive do
      {:worker_dispatch,
       %{
         "target_runner_kind" => runner_kind,
         "work_item" => %{"metadata" => %{"repository_id" => repository_id}}
       }} ->
        dispatches
        |> Map.put(repository_id, runner_kind)
        |> collect_dispatches(expected_count, timeout_ms)
    after
      timeout_ms ->
        dispatches
    end
  end

  defp eq_value("eq." <> value), do: value
  defp eq_value(_value), do: nil

  defp in_values("in.(" <> rest) do
    rest
    |> String.trim_trailing(")")
    |> String.split(",", trim: true)
  end

  defp in_values(_value), do: []

  defp json(conn, status, payload) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(payload))
  end

  defp start_planner_complete_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:planner_dispatch, frame})
          Registry.complete(correlation_id, %{"output_text" => "Grant-scoped dispatch completed."})
      end
    end)
  end

  defp start_completion_helper(parent) do
    spawn_link(fn -> completion_helper_loop(parent) end)
  end

  defp completion_helper_loop(parent) do
    receive do
      {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
        send(parent, {:planner_dispatch, frame})
        Registry.complete(correlation_id, %{"output_text" => "completed"})
        completion_helper_loop(parent)
    end
  end

  defp planner_config(tool_definitions) do
    %{
      "execution_profile" => %{"provider" => "local", "model" => "qwen"},
      "model" => "qwen",
      "tool_definitions" => tool_definitions,
      "agent" => %{
        id: "agent-1",
        workspace_id: "workspace-1",
        type: "planning",
        tool_policy: %{}
      }
    }
  end

  defp provider_tool_names(frame) do
    frame
    |> Map.fetch!("provider_tool_specs")
    |> Enum.map(&get_in(&1, ["function", "name"]))
  end

  defp work_item, do: %WorkItem{id: "work-1", identifier: "PLAN-1", title: "Plan work"}
end
