defmodule SymphonyElixir.Planner.PlanDraftTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Planner.PlanDraft

  defmodule TestAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    def list_agents, do: {:ok, []}

    def get_agent("planner-1") do
      {:ok,
       %Agent{
         id: "planner-1",
         type: "planning",
         model_settings: %{"model" => "gpt-runtime"}
       }}
    end

    def get_agent("planner-atom-model") do
      {:ok,
       %Agent{
         id: "planner-atom-model",
         type: "planning",
         model_settings: %{model: "  gpt-atom  "}
       }}
    end

    def get_agent(_agent_id), do: {:error, :not_found}

    def list_credentials(_agent_id), do: {:ok, []}
  end

  setup do
    previous_openai_api_key = System.get_env("OPENAI_API_KEY")

    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :planner_plan_draft_req_options, plug: {Req.Test, __MODULE__})
    System.put_env("OPENAI_API_KEY", "test-key")

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :planner_plan_draft_req_options)
      restore_env("OPENAI_API_KEY", previous_openai_api_key)
    end)

    :ok
  end

  test "uses planning agent model for Responses API while preserving requested plan default model" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/v1/responses"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      input_text = get_in(request, ["input", Access.at(0), "content", Access.at(0), "text"])

      send(test_pid, {:responses_request, request, input_text})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "output" => [
            %{
              "type" => "message",
              "content" => [
                %{
                  "type" => "output_text",
                  "text" =>
                    Jason.encode!(%{
                      "schema_version" => "1",
                      "title" => "Draft",
                      "intent" => "Test draft",
                      "default_runner" => "openclaw",
                      "default_model" => "claude-3-5-sonnet",
                      "tasks" => [
                        %{
                          "id" => "t-01",
                          "title" => "Implement",
                          "instructions" => "Do the work",
                          "labels" => %{},
                          "depends_on" => [],
                          "completion_gates" => ["tests"]
                        }
                      ]
                    })
                }
              ]
            }
          ]
        })
      )
    end)

    assert {:ok, %{"draft" => draft}} =
             PlanDraft.draft_for_agent("planner-1", %{
               "workspace_id" => "workspace-1",
               "prompt" => "Plan a change",
               "default_runner" => "openclaw",
               "default_model" => "claude-3-5-sonnet"
             })

    assert draft["default_model"] == "claude-3-5-sonnet"

    assert_received {:responses_request, request, input_text}
    assert request["model"] == "gpt-runtime"
    assert input_text =~ "Preferred model: claude-3-5-sonnet"
  end

  test "accepts atom-keyed request params and trims strings before sending the Responses request" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      input_text = get_in(request, ["input", Access.at(0), "content", Access.at(0), "text"])

      send(test_pid, {:trimmed_request, request, input_text})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "output" => [
            %{
              "type" => "message",
              "content" => [
                %{
                  "type" => "output_text",
                  "text" =>
                    Jason.encode!(%{
                      "schema_version" => "1",
                      "title" => " Draft ",
                      "intent" => " Test draft ",
                      "default_runner" => " openclaw ",
                      "default_model" => " claude-3-5-sonnet ",
                      "tasks" => [
                        %{
                          "id" => "t-01",
                          "title" => " Implement ",
                          "instructions" => " Do the work ",
                          "labels" => %{},
                          "depends_on" => [],
                          "completion_gates" => ["tests"]
                        }
                      ]
                    })
                }
              ]
            }
          ]
        })
      )
    end)

    assert {:ok, %{"draft" => draft}} =
             PlanDraft.draft_for_agent("planner-atom-model", %{
               workspace_id: " workspace-1 ",
               prompt: " Plan a change ",
               default_runner: " openclaw ",
               default_model: " claude-3-5-sonnet "
             })

    assert_received {:trimmed_request, request, input_text}
    assert request["model"] == "gpt-atom"
    assert input_text =~ "Workspace ID: workspace-1"
    assert input_text =~ "Preferred runner: openclaw"
    assert input_text =~ "Preferred model: claude-3-5-sonnet"
    assert input_text =~ "Plan a change"

    assert draft["title"] == "Draft"
    assert draft["intent"] == "Test draft"
    assert draft["default_runner"] == "openclaw"
    assert draft["default_model"] == "claude-3-5-sonnet"
    assert hd(draft["tasks"])["title"] == "Implement"
    assert hd(draft["tasks"])["instructions"] == "Do the work"
  end
end
