defmodule SymphonyElixir.Planner.DatabaseToolSpecsTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Planner.DatabaseToolSpecs

  test "tool_names match the available specs" do
    assert DatabaseToolSpecs.tool_names() == Enum.map(DatabaseToolSpecs.tool_specs(), & &1["name"])
  end

  test "tool_spec raises for unknown tools" do
    assert_raise ArgumentError, ~r/unknown planner database tool/, fn ->
      DatabaseToolSpecs.tool_spec("unknown.tool")
    end
  end
end
