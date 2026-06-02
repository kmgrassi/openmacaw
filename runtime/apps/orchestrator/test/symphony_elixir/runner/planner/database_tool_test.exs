defmodule SymphonyElixir.Runner.Planner.DatabaseToolTest do
  use SymphonyElixir.Runner.PlannerTestSupport

  test "keeps planner tools available after plan creation so tasks can be created in the same turn" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/rest/v1/plan"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:plan_payload, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              %{"id" => "plan-1", "workspace_id" => "workspace-1", "name" => "Task plan"}
            ])
          )

        {"GET", "/rest/v1/plan"} ->
          send(test_pid, {:plan_lookup, URI.decode_query(conn.query_string)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}])
          )

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:task_payload, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "plan_id" => "plan-1",
                "title" => "Task one"
              }
            ])
          )

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-plan",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-plan",
                      "name" => "plan_create",
                      "arguments" => Jason.encode!(%{"name" => "Task plan"})
                    }
                  ]
                })
              )

            "resp-plan" ->
              send(test_pid, {:task_follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-task",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-task",
                      "name" => "task_create",
                      "arguments" =>
                        Jason.encode!(%{
                          "workspace_id" => "workspace",
                          "plan_id" => "plan-1",
                          "name" => "Task one"
                        })
                    }
                  ]
                })
              )

            "resp-task" ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-done",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [
                        %{"type" => "output_text", "text" => "Created the plan and task."}
                      ]
                    }
                  ]
                })
              )
          end
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert {:ok, %{"response_id" => "resp-done", "output_text" => "Created the plan and task."}} =
             Planner.run_turn(session, "Create a plan with a task", %WorkItem{
               id: "work-1",
               identifier: "PLAN-1",
               title: "Plan work"
             })

    assert_received {:plan_payload, %{"workspace_id" => "workspace-1", "name" => "Task plan"}}

    assert_received {:task_follow_up_request, task_follow_up_request}
    assert "task_create" in Enum.map(task_follow_up_request["tools"], & &1["name"])

    assert_received {:plan_lookup, %{"id" => "eq.plan-1", "workspace_id" => "eq.workspace-1", "limit" => "1"}}

    assert_received {:task_payload,
                     %{
                       "workspace_id" => "workspace-1",
                       "plan_id" => "plan-1",
                       "title" => "Task one",
                       "instructions" => "Task one",
                       "state" => "todo",
                       "source" => "planner",
                       "metadata" => %{
                         "created_via" => "planner_task_tool",
                         "planner_tool" => "task.create"
                       }
                     }}
  end

  test "executes provider task_schedule tool calls through task.schedule" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"PATCH", "/rest/v1/work_items"} ->
          send(test_pid, {:schedule_query, URI.decode_query(conn.query_string)})

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:schedule_payload, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "next_poll_at" => "2026-05-01T12:00:00Z",
                "poll_cadence_seconds" => 3600
              }
            ])
          )

        {"POST", "/rest/v1/event_log"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:schedule_event, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
              send(test_pid, {:schedule_first_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-schedule",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-schedule",
                      "name" => "task_schedule",
                      "arguments" =>
                        Jason.encode!(%{
                          "workspace_id" => "guessed-workspace",
                          "task_id" => "work-item-1",
                          "next_poll_at" => "2026-05-01T12:00:00Z",
                          "poll_cadence_seconds" => 3600,
                          "reason" => "start when ready"
                        })
                    }
                  ]
                })
              )

            "resp-schedule" ->
              send(test_pid, {:schedule_follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-done",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [
                        %{"type" => "output_text", "text" => "Scheduled the task."}
                      ]
                    }
                  ]
                })
              )
          end
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert {:ok, %{"response_id" => "resp-done", "output_text" => "Scheduled the task."}} =
             Planner.run_turn(session, "Schedule this task for tomorrow", %WorkItem{
               id: "work-1",
               identifier: "PLAN-1",
               title: "Plan work"
             })

    assert_received {:schedule_first_request, first_request}
    assert "task_schedule" in Enum.map(first_request["tools"], & &1["name"])

    assert_received {:schedule_query, %{"id" => "eq.work-item-1", "workspace_id" => "eq.workspace-1", "limit" => "1"}}

    assert_received {:schedule_payload,
                     %{
                       "next_poll_at" => "2026-05-01T12:00:00Z",
                       "poll_cadence_seconds" => 3600
                     }}

    assert_received {:schedule_event,
                     %{
                       "workspace_id" => "workspace-1",
                       "work_item_id" => "work-item-1",
                       "kind" => "work_item.timing_updated",
                       "source" => "planner_tool",
                       "payload" => %{
                         "next_poll_at" => "2026-05-01T12:00:00Z",
                         "poll_cadence_seconds" => 3600,
                         "reason" => "start when ready"
                       }
                     }}

    assert_received {:schedule_follow_up_request,
                     %{
                       "input" => [
                         %{
                           "type" => "function_call_output",
                           "call_id" => "call-schedule",
                           "output" => output
                         }
                       ]
                     }}

    assert output =~ ~s("workspace_id": "workspace-1")
    assert output =~ ~s("next_poll_at": "2026-05-01T12:00:00Z")
  end

  test "uses stored agent workspace when planner database tool omits or guesses workspace_id and falls back when final text is empty" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/rest/v1/plan"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:plan_payload, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "workspace_id" => "workspace-from-agent",
                "name" => "Injected workspace plan"
              }
            ])
          )

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-plan",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-plan",
                      "name" => "plan_create",
                      "arguments" =>
                        Jason.encode!(%{
                          "workspace_id" => "workspace",
                          "name" => "Injected workspace plan"
                        })
                    }
                  ]
                })
              )

            "resp-plan" ->
              send(test_pid, {:follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-done",
                  "status" => "completed",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [%{"type" => "output_text", "text" => ""}]
                    }
                  ]
                })
              )
          end
      end
    end)

    on_message = fn message -> send(test_pid, {:planner_event, message}) end

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "stored_agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-from-agent",
                   type: "planning",
                   tool_policy: %{}
                 },
                 on_message: on_message
               },
               nil
             )

    assert {:ok,
            %{
              "response_id" => "resp-done",
              "output_text" => "Created plan \"Injected workspace plan\". [Open plan](/plans/plan-1)."
            }} =
             Planner.run_turn(session, "Create a plan", %WorkItem{
               id: "work-1",
               identifier: "PLAN-1",
               title: "Plan work"
             })

    assert_received {:plan_payload,
                     %{
                       "workspace_id" => "workspace-from-agent",
                       "name" => "Injected workspace plan"
                     }}

    assert_received {:follow_up_request,
                     %{
                       "input" => [
                         %{
                           "type" => "function_call_output",
                           "call_id" => "call-plan",
                           "output" => output
                         }
                       ]
                     }}

    assert output =~ ~s("workspace_id": "workspace-from-agent")

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{
                           "textDelta" => "Created plan \"Injected workspace plan\". [Open plan](/plans/plan-1)."
                         }
                       }
                     }}
  end
end
