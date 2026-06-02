defmodule SymphonyElixir.Planner.ToolNameMappingTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planner.ToolNameMapping

  describe "runtime_to_provider/1" do
    test "sanitizes names and deduplicates collisions" do
      names = ["task.create", "task-create", "task create", "task_create"]

      assert ToolNameMapping.runtime_to_provider(names) == %{
               "task.create" => "task_create",
               "task-create" => "task-create",
               "task create" => "task_create_1",
               "task_create" => "task_create_2"
             }
    end

    test "truncates provider names to OpenAI Responses limits" do
      long_name = String.duplicate("a", 80)

      assert ToolNameMapping.runtime_to_provider([long_name]) == %{
               long_name => String.duplicate("a", 64)
             }
    end
  end

  test "provider_to_runtime/1 reverses the canonical map for relay tool calls" do
    assert ToolNameMapping.provider_to_runtime(["repo.list", "repo_list"]) == %{
             "repo_list" => "repo.list",
             "repo_list_1" => "repo_list"
           }
  end

  test "runtime_name/2 maps provider calls back to runtime names" do
    mapping = ToolNameMapping.runtime_to_provider(["repo.list"])

    assert ToolNameMapping.runtime_name("repo_list", mapping) == "repo.list"
    assert ToolNameMapping.runtime_name("unknown_tool", mapping) == "unknown_tool"
  end

  test "responses_tool_spec/2 normalizes supported schema field names" do
    mapping = ToolNameMapping.runtime_to_provider(["task.create"])
    schema = %{"type" => "object", "required" => ["name"]}

    assert ToolNameMapping.responses_tool_spec(
             %{name: "task.create", description: "Create task", parameters_schema: schema},
             mapping
           ) == %{
             "type" => "function",
             "name" => "task_create",
             "description" => "Create task",
             "parameters" => schema
           }

    assert ToolNameMapping.responses_tool_spec(%{"slug" => "empty"}, %{})["parameters"] == %{
             "type" => "object",
             "properties" => %{}
           }
  end

  test "responses_tool_spec/2 includes examples in descriptions" do
    mapping = ToolNameMapping.runtime_to_provider(["repo.read_file"])

    spec =
      ToolNameMapping.responses_tool_spec(
        %{
          name: "repo.read_file",
          description: "Read file",
          examples: [%{"input" => %{"path" => "README.md"}}]
        },
        mapping
      )

    assert spec["description"] =~ "Examples / usage guidance:"
    assert spec["description"] =~ "README.md"
  end

  test "put_provider_tool_name/2 rewrites both Responses and chat-style specs" do
    mapping = ToolNameMapping.runtime_to_provider(["plan.create"])

    assert ToolNameMapping.put_provider_tool_name(%{"name" => "plan.create"}, mapping) == %{
             "name" => "plan_create"
           }

    assert ToolNameMapping.put_provider_tool_name(
             %{"function" => %{"name" => "plan.create"}},
             mapping
           ) == %{
             "function" => %{"name" => "plan_create"}
           }
  end
end
