defmodule SymphonyElixir.SupabaseSchemaTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SupabaseSchema

  test "column? reports generated table column support" do
    assert SupabaseSchema.column?("agent", "workspace_id")
    refute SupabaseSchema.column?("task", "workspace_id")
    assert SupabaseSchema.column?("work_items", "workspace_id")
    refute SupabaseSchema.column?("unknown_table", "workspace_id")
  end
end
