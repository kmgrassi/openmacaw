defmodule SymphonyElixir.Planning.ToolPolicyTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planning.ToolPolicy

  test "database is the default planner destination" do
    assert ToolPolicy.destination(%{}) == "database"
    assert ToolPolicy.destination(%{"planning" => %{"destination" => "unknown"}}) == "database"
  end

  test "linear destination requires explicit Linear config" do
    assert ToolPolicy.destination(%{"planning" => %{"destination" => "linear"}}) == "linear"

    assert {:error, :missing_linear_api_token} =
             ToolPolicy.linear_config(%{"planning" => %{"destination" => "linear"}})
  end

  test "linear_config normalizes policy config" do
    assert {:ok,
            %{
              api_key: "lin_api_key",
              endpoint: "https://linear.test/graphql",
              team_id: "team-1",
              label_ids: ["bug", "planner"]
            }} =
             ToolPolicy.linear_config(%{
               "planning" => %{
                 "destination" => "linear",
                 "linear" => %{
                   "api_key" => "lin_api_key",
                   "endpoint" => "https://linear.test/graphql",
                   "team_id" => "team-1",
                   "label_ids" => ["bug", "", "planner"]
                 }
               }
             })
  end

  test "linear_config trims api key and defaults blank endpoint" do
    assert {:ok,
            %{
              api_key: "lin_api_key",
              endpoint: "https://api.linear.app/graphql"
            }} =
             ToolPolicy.linear_config(%{
               "planning" => %{
                 "destination" => "linear",
                 "linear" => %{
                   "api_key" => "  lin_api_key  ",
                   "endpoint" => "   "
                 }
               }
             })
  end
end
