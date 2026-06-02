defmodule SymphonyElixir.MapUtilsTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.MapUtils

  describe "put_present/4" do
    test "keeps nil out by default" do
      assert MapUtils.put_present(%{a: 1}, :b, nil) == %{a: 1}
      assert MapUtils.put_present(%{a: 1}, :b, "") == %{a: 1, b: ""}
    end

    test "accepts caller-specific empty values" do
      assert MapUtils.put_present(%{}, :items, [], empty_values: [nil, []]) == %{}
      assert MapUtils.put_present(%{}, :items, ["one"], empty_values: [nil, []]) == %{items: ["one"]}
    end
  end

  test "drop_nil_values/1 removes only nil values" do
    assert MapUtils.drop_nil_values(%{a: nil, b: false, c: "", d: []}) == %{b: false, c: "", d: []}
  end

  describe "fetch_required/3" do
    test "checks atom and string key variants" do
      assert MapUtils.fetch_required(%{"id" => "123"}, :id) == {:ok, "123"}
      assert MapUtils.fetch_required(%{id: "123"}, "id") == {:ok, "123"}
    end

    test "returns a tagged error for missing or empty values" do
      assert MapUtils.fetch_required(%{}, :id) == {:error, {:missing_required, :id}}
      assert MapUtils.fetch_required(%{id: ""}, :id) == {:error, {:missing_required, :id}}
    end
  end

  test "stringify/1 handles common payload values" do
    assert MapUtils.stringify(nil) == nil
    assert MapUtils.stringify("ready") == "ready"
    assert MapUtils.stringify(:ready) == "ready"
    assert MapUtils.stringify(%{status: :ready}) == "%{status: :ready}"
  end

  test "to_map/1 normalizes map-like values" do
    assert MapUtils.to_map(nil) == %{}
    assert MapUtils.to_map(%{a: 1}) == %{a: 1}
    assert MapUtils.to_map(a: 1) == %{a: 1}
    assert MapUtils.to_map(["not", "pairs"]) == %{}
    assert MapUtils.to_map("not a map") == %{}
  end

  test "atom_or_string_get/2 checks atom and string key variants" do
    assert MapUtils.atom_or_string_get(%{"id" => 1}, :id) == 1
    assert MapUtils.atom_or_string_get(%{id: 2}, "id") == 2
    assert MapUtils.atom_or_string_get(%{enabled: false}, "enabled") == false
    assert MapUtils.atom_or_string_get(%{"id" => "123", id: nil}, :id) == "123"
    assert MapUtils.atom_or_string_get(%{"enabled" => true, enabled: false}, "enabled") == true
  end

  test "trimmed_string/2 checks key variants and normalizes blanks" do
    assert MapUtils.trimmed_string(%{"name" => "  draft  "}, :name) == "draft"
    assert MapUtils.trimmed_string(%{name: "  runtime  "}, "name") == "runtime"
    assert MapUtils.trimmed_string(%{"name" => "   ", name: "fallback"}, :name) == "fallback"
    assert MapUtils.trimmed_string(%{"name" => 123}, :name) == nil
    assert MapUtils.trimmed_string(%{}, :name) == nil
  end
end
