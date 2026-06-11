defmodule SymphonyElixir.ScheduledTask.NextRunTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ScheduledTask.NextRun

  test "seeds one-shot schedules from an absolute at timestamp" do
    assert {:ok, ~U[2026-05-14 12:00:00Z]} =
             NextRun.first_after(
               %{"at" => "2026-05-14T12:00:00Z"},
               ~U[2026-05-14 11:00:00Z]
             )
  end

  test "seeds one-shot schedules from v1 at schedules" do
    assert {:ok, ~U[2026-05-14 12:00:00Z]} =
             NextRun.first_after(
               %{"kind" => "at", "runAt" => "2026-05-14T12:00:00Z"},
               ~U[2026-05-14 11:00:00Z]
             )
  end

  test "rejects non-string one-shot at timestamps" do
    schedule = %{"at" => nil}

    assert {:error, {:invalid_schedule_datetime, nil}} =
             NextRun.first_after(schedule, ~U[2026-05-14 11:00:00Z])

    assert {:error, {:invalid_schedule_datetime, nil}} = NextRun.validate(schedule)
  end

  test "rejects non-string recurring wall-clock times" do
    schedule = %{"every" => "day", "at" => nil}

    assert {:error, {:invalid_schedule_time, nil}} =
             NextRun.first_after(schedule, ~U[2026-05-14 11:00:00Z])

    assert {:error, {:invalid_schedule_time, nil}} = NextRun.validate(schedule)
  end

  test "seeds recurring daily schedules from the next wall-clock occurrence" do
    schedule = %{"every" => "day", "at" => "09:00:00"}

    assert {:ok, ~U[2026-05-18 13:00:00Z]} =
             NextRun.first_after(schedule, ~U[2026-05-18 12:00:00Z], "America/New_York")

    assert {:ok, ~U[2026-05-19 13:00:00Z]} =
             NextRun.first_after(schedule, ~U[2026-05-18 14:00:00Z], "America/New_York")
  end

  test "requires explicit next_run_at for cadence-only initial recurring schedules" do
    assert {:error, {:missing_argument, "next_run_at"}} =
             NextRun.first_after(%{"every" => "hour"}, ~U[2026-05-14 12:00:00Z])
  end

  test "advances hourly schedules after the claimed occurrence" do
    assert {:ok, ~U[2026-05-14 13:00:00Z]} =
             NextRun.next_after(%{"every" => "hour"}, ~U[2026-05-14 12:00:00Z])
  end

  test "validates hourly schedules without requiring a timezone database entry" do
    assert :ok = NextRun.validate(%{"every" => "hour"})
  end

  test "rejects minute schedules with a readable unsupported schedule error" do
    assert {:error, {:unsupported_schedule_unit, "minute", message}} =
             NextRun.validate(%{"kind" => "every", "interval" => 30, "unit" => "minute"})

    assert message =~ "30-minute/minute schedules are not supported"
    assert message =~ ~s({"every":"hour"})
  end

  test "one-shot at schedules do not produce another next run" do
    assert {:ok, nil} =
             NextRun.next_after(%{"at" => "2026-05-14T12:00:00Z"}, ~U[2026-05-14 12:00:00Z])

    assert {:ok, nil} =
             NextRun.next_after(
               %{"kind" => "at", "runAt" => "2026-05-14T12:00:00Z"},
               ~U[2026-05-14 12:00:00Z]
             )
  end

  test "rejects unsupported schedule shapes" do
    assert {:error, :unsupported_schedule} =
             NextRun.next_after(%{"cron" => "* * * * *"}, ~U[2026-05-14 12:00:00Z])
  end
end
