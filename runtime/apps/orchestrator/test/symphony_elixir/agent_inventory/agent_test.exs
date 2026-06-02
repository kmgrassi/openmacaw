defmodule SymphonyElixir.AgentInventory.AgentTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.AgentInventory.Agent

  test "normalizes missing and empty type to coding" do
    assert Agent.from_row(%{"id" => "agent-1"}).type == "coding"
    assert Agent.from_row(%{"id" => "agent-1", "type" => ""}).type == "coding"
    assert Agent.from_row(%{"id" => "agent-1", "type" => "  "}).type == "coding"
  end

  test "exposes canonical kind checks" do
    assert Agent.coding?(%Agent{type: nil})
    assert Agent.planning?(%Agent{type: "planning"})
    assert Agent.custom?(%Agent{type: "custom"})
    assert Agent.kind?(%Agent{type: "planning"}, " planning ")
    refute Agent.coding?(%Agent{type: "planning"})
  end

  test "public map emits the normalized type" do
    public = Agent.to_public_map(%Agent{id: "agent-1", type: nil})

    assert public.type == "coding"
  end
end
