defmodule SymphonyElixir.TimeTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Time, as: Timestamp

  describe "parse_iso8601/1" do
    test "parses valid ISO8601 datetimes" do
      assert %DateTime{} = datetime = Timestamp.parse_iso8601("2026-04-27T10:11:12Z")
      assert datetime.year == 2026
      assert datetime.month == 4
      assert datetime.day == 27
    end

    test "returns nil for nil, invalid, and unsupported values" do
      assert Timestamp.parse_iso8601(nil) == nil
      assert Timestamp.parse_iso8601("not a timestamp") == nil
      assert Timestamp.parse_iso8601(%{}) == nil
    end

    test "passes DateTime values through unchanged" do
      datetime = ~U[2026-04-27 10:11:12Z]

      assert Timestamp.parse_iso8601(datetime) == datetime
    end
  end

  describe "to_iso8601/1" do
    test "formats DateTime values" do
      datetime = ~U[2026-04-27 10:11:12Z]

      assert Timestamp.to_iso8601(datetime) == "2026-04-27T10:11:12Z"
    end

    test "passes strings through and returns nil for unsupported values" do
      assert Timestamp.to_iso8601("2026-04-27T10:11:12Z") == "2026-04-27T10:11:12Z"
      assert Timestamp.to_iso8601(nil) == nil
      assert Timestamp.to_iso8601(:now) == nil
    end

    test "supports optional truncation for DateTime values" do
      datetime = ~U[2026-04-27 10:11:12.987654Z]

      assert Timestamp.to_iso8601(datetime, truncate: :second) == "2026-04-27T10:11:12Z"
    end
  end

  describe "now_iso8601/1" do
    test "supports second truncation" do
      assert {:ok, datetime, 0} = Timestamp.now_iso8601(truncate: :second) |> DateTime.from_iso8601()
      assert datetime.microsecond == {0, 0}
    end
  end
end
