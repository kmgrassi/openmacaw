defmodule SymphonyElixir.Planner.DatabaseToolSpecsTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Planner.DatabaseToolSpecs
  alias SymphonyElixir.Orchestrator.IntentVocabulary

  test "tool_names match the available specs" do
    assert DatabaseToolSpecs.tool_names() == Enum.map(DatabaseToolSpecs.tool_specs(), & &1["name"])
  end

  test "tool_spec raises for unknown tools" do
    assert_raise ArgumentError, ~r/unknown planner database tool/, fn ->
      DatabaseToolSpecs.tool_spec("unknown.tool")
    end
  end

  test "task.create descriptions include the shared dispatch intent vocabulary" do
    spec = DatabaseToolSpecs.tool_spec("task.create")
    routing_intent = spec["inputSchema"]["properties"]["routing"]["properties"]["intent"]

    assert spec["description"] =~ IntentVocabulary.tool_description()
    assert routing_intent["description"] =~ IntentVocabulary.tool_description()
  end
end
