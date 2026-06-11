defmodule SymphonyElixir.ScheduledTask.NextRun do
  @moduledoc """
  Calculates the next runtime-owned occurrence for persisted scheduled tasks.

  Platform owns initial `next_run_at` on create/update. Runtime also uses this
  module after a terminal delivery attempt, so the schedule cannot stay pinned
  to a claimed occurrence.
  """

  @type schedule :: map()
  @supported_units ~w(hour day week)

  @spec first_after(schedule(), DateTime.t(), String.t() | nil) ::
          {:ok, DateTime.t()} | {:error, term()}
  def first_after(schedule, now, timezone \\ nil)

  def first_after(%{} = schedule, %DateTime{} = now, timezone) do
    cond do
      Map.has_key?(schedule, "at") and not Map.has_key?(schedule, "every") ->
        one_shot_at(schedule)

      Map.get(schedule, "kind") == "at" ->
        one_shot_at(schedule)

      Map.has_key?(schedule, "at") ->
        with {:ok, unit} when unit in ["day", "week"] <- every_unit(schedule),
             {:ok, time} <- optional_time(schedule) do
          next_wall_time_after(now, timezone, time, recurrence_days(unit))
        else
          {:ok, "hour"} -> {:error, {:missing_argument, "next_run_at"}}
          {:error, _reason} = error -> error
        end

      true ->
        {:error, {:missing_argument, "next_run_at"}}
    end
  end

  def first_after(_schedule, _now, _timezone), do: {:error, :invalid_schedule}

  @spec next_after(schedule(), DateTime.t(), String.t() | nil) ::
          {:ok, DateTime.t() | nil} | {:error, term()}
  def next_after(schedule, scheduled_for, timezone \\ nil)

  def next_after(%{} = schedule, %DateTime{} = scheduled_for, timezone) do
    cond do
      Map.has_key?(schedule, "at") and not Map.has_key?(schedule, "every") ->
        with {:ok, _datetime} <- one_shot_at(schedule), do: {:ok, nil}

      Map.get(schedule, "kind") == "at" ->
        with {:ok, _datetime} <- one_shot_at(schedule), do: {:ok, nil}

      true ->
        case every_unit(schedule) do
          {:ok, "hour"} -> {:ok, add_utc_seconds(scheduled_for, 3600)}
          {:ok, "day"} -> next_daily(schedule, scheduled_for, timezone)
          {:ok, "week"} -> next_weekly(schedule, scheduled_for, timezone)
          {:error, _reason} = error -> error
        end
    end
  end

  def next_after(_schedule, _scheduled_for, _timezone), do: {:error, :invalid_schedule}

  @spec validate(schedule()) :: :ok | {:error, term()}
  def validate(%{} = schedule) do
    with {:ok, _next} <-
           next_after(schedule, ~U[2026-01-01 00:00:00Z], Map.get(schedule, "timezone")) do
      :ok
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def validate(_schedule), do: {:error, :invalid_schedule}

  defp every_unit(%{"every" => unit}) when unit in @supported_units, do: {:ok, unit}

  defp every_unit(%{"every" => %{"unit" => unit, "interval" => 1}}) when unit in @supported_units,
    do: {:ok, unit}

  defp every_unit(%{"kind" => "every", "unit" => unit, "interval" => 1}) when unit in @supported_units,
    do: {:ok, unit}

  defp every_unit(%{"every" => unit}) when is_binary(unit),
    do: unsupported_unit(unit)

  defp every_unit(%{"every" => %{"unit" => unit, "interval" => interval}})
       when is_binary(unit) and is_integer(interval),
       do: unsupported_interval(unit, interval)

  defp every_unit(%{"kind" => "every", "unit" => unit, "interval" => interval})
       when is_binary(unit) and is_integer(interval),
       do: unsupported_interval(unit, interval)

  defp every_unit(_schedule), do: {:error, :unsupported_schedule}

  defp one_shot_at(%{"at" => value}) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> {:ok, datetime}
      {:error, _reason} -> {:error, {:invalid_schedule_datetime, value}}
    end
  end

  defp one_shot_at(%{"kind" => "at", "runAt" => value}) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> {:ok, datetime}
      {:error, _reason} -> {:error, {:invalid_schedule_datetime, value}}
    end
  end

  defp one_shot_at(%{"at" => value}), do: {:error, {:invalid_schedule_datetime, value}}
  defp one_shot_at(%{"kind" => "at", "runAt" => value}), do: {:error, {:invalid_schedule_datetime, value}}

  defp next_daily(schedule, scheduled_for, timezone) do
    with {:ok, time} <- optional_time(schedule) do
      if time do
        shift_wall_time(scheduled_for, timezone, 1, time)
      else
        {:ok, add_utc_seconds(scheduled_for, 86_400)}
      end
    end
  end

  defp next_weekly(schedule, scheduled_for, timezone) do
    with {:ok, time} <- optional_time(schedule) do
      if time do
        shift_wall_time(scheduled_for, timezone, 7, time)
      else
        {:ok, add_utc_seconds(scheduled_for, 7 * 86_400)}
      end
    end
  end

  defp optional_time(%{"at" => value}) when is_binary(value) do
    case Time.from_iso8601(value) do
      {:ok, time} -> {:ok, time}
      {:error, _reason} -> {:error, {:invalid_schedule_time, value}}
    end
  end

  defp optional_time(%{"at" => value}), do: {:error, {:invalid_schedule_time, value}}

  defp optional_time(_schedule), do: {:ok, nil}

  defp recurrence_days("day"), do: 1
  defp recurrence_days("week"), do: 7

  defp next_wall_time_after(now, timezone, time, interval_days) do
    timezone = timezone || "Etc/UTC"
    local_now = DateTime.shift_zone!(now, timezone)
    date = DateTime.to_date(local_now)
    candidate = DateTime.from_naive!(NaiveDateTime.new!(date, time), timezone)

    candidate =
      if DateTime.compare(candidate, local_now) == :gt do
        candidate
      else
        DateTime.from_naive!(NaiveDateTime.new!(Date.add(date, interval_days), time), timezone)
      end

    candidate
    |> DateTime.shift_zone!("Etc/UTC")
    |> then(&{:ok, &1})
  rescue
    _error in ArgumentError -> {:error, :invalid_timezone}
  end

  defp shift_wall_time(scheduled_for, timezone, days, time) do
    timezone = timezone || "Etc/UTC"
    local = DateTime.shift_zone!(scheduled_for, timezone)
    date = Date.add(DateTime.to_date(local), days)
    naive = NaiveDateTime.new!(date, time)

    naive
    |> DateTime.from_naive!(timezone)
    |> DateTime.shift_zone!("Etc/UTC")
    |> then(&{:ok, &1})
  rescue
    _error in ArgumentError -> {:error, :invalid_timezone}
  end

  defp add_utc_seconds(%DateTime{} = datetime, seconds) do
    DateTime.add(datetime, seconds, :second, Calendar.UTCOnlyTimeZoneDatabase)
  end

  defp unsupported_unit(unit) do
    {:error,
     {:unsupported_schedule_unit, unit,
      "scheduled_task recurring schedules only support hour, day, or week; 30-minute/minute schedules are not supported. Use {\"every\":\"hour\"} with next_run_at for the first occurrence."}}
  end

  defp unsupported_interval(unit, interval) do
    if unit in @supported_units and interval != 1 do
      {:error,
       {:unsupported_schedule_interval, interval, unit,
        "scheduled_task recurring schedules only support interval 1 for hour, day, or week; use {\"every\":\"hour\"} with next_run_at for hourly checks."}}
    else
      unsupported_unit(unit)
    end
  end
end
