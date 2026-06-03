import type { ScheduledTaskSchedule } from "../../../../../contracts/scheduled-tasks.js";
import { ScheduledTaskScheduleSchema } from "../../../../../contracts/scheduled-tasks.js";
import { ApiRouteError } from "../../http.js";

const DEFAULT_TIMEZONE = "Etc/UTC";
const CRON_SEARCH_LIMIT_MINUTES = 60 * 24 * 366 * 5;

function parseTimeOfDay(value: string) {
  const [hour = "0", minute = "0"] = value.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayByLabel: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayByLabel[parts.weekday ?? "Sun"] ?? 0,
  };
}

function zonedTimeToUtc(
  timezone: string,
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
) {
  let utcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(new Date(utcMs), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const desiredAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
    const diff = actualAsUtc - desiredAsUtc;
    if (diff === 0) break;
    utcMs -= diff;
  }
  return new Date(utcMs);
}

function addUtc(date: Date, interval: number, unit: "minute" | "hour" | "day" | "week" | "month") {
  const next = new Date(date);
  if (unit === "minute") next.setUTCMinutes(next.getUTCMinutes() + interval);
  if (unit === "hour") next.setUTCHours(next.getUTCHours() + interval);
  if (unit === "day") next.setUTCDate(next.getUTCDate() + interval);
  if (unit === "week") next.setUTCDate(next.getUTCDate() + interval * 7);
  if (unit === "month") next.setUTCMonth(next.getUTCMonth() + interval);
  return next;
}

function addLocalDate(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  interval: number,
  unit: "day" | "week" | "month",
) {
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0));
  if (unit === "day") next.setUTCDate(next.getUTCDate() + interval);
  if (unit === "week") next.setUTCDate(next.getUTCDate() + interval * 7);
  if (unit === "month") next.setUTCMonth(next.getUTCMonth() + interval);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
  };
}

function everyScheduleNextRunAt(
  schedule: Extract<ScheduledTaskSchedule, { kind: "every" }>,
  timezone: string,
  from: Date,
) {
  if (!schedule.at) return addUtc(from, schedule.interval, schedule.unit);
  if (schedule.unit !== "day" && schedule.unit !== "week" && schedule.unit !== "month") {
    throw new ApiRouteError(
      400,
      "invalid_schedule",
      "The at field is only supported for day, week, and month schedules",
    );
  }

  const time = parseTimeOfDay(schedule.at);
  const fromLocal = localParts(from, timezone);
  let candidateLocal = {
    year: fromLocal.year,
    month: fromLocal.month,
    day: fromLocal.day,
    hour: time.hour,
    minute: time.minute,
  };
  let candidate = zonedTimeToUtc(timezone, candidateLocal);
  if (candidate.getTime() <= from.getTime()) {
    candidateLocal = addLocalDate(candidateLocal, schedule.interval, schedule.unit);
    candidate = zonedTimeToUtc(timezone, candidateLocal);
  }
  return candidate;
}

function cronFieldMatches(value: number, expression: string, min: number, max: number) {
  if (expression === "*") return true;
  return expression.split(",").some((part) => {
    const [rangePart = "", stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return false;
    const [startText, endText] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
    const start = Number(startText);
    const end = Number(endText ?? startText);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

function validCronField(expression: string, min: number, max: number) {
  if (!expression) return false;
  return expression.split(",").every((part) => {
    const [rangePart = "", stepPart] = part.split("/");
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) return false;
    }
    if (rangePart === "*") return true;
    const [startText = "", endText] = rangePart.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
  });
}

function cronWeekdayMatches(weekday: number, expression: string) {
  if (expression === "*") return true;
  return expression.split(",").some((part) => {
    const normalized = part === "7" ? "0" : part.replace(/-7$/, "-6");
    return cronFieldMatches(weekday, normalized, 0, 6);
  });
}

function cronNextRunAt(
  schedule: Extract<ScheduledTaskSchedule, { kind: "cron" }>,
  fallbackTimezone: string,
  from: Date,
) {
  const fields = schedule.expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ApiRouteError(400, "invalid_schedule", "Cron schedules must use five fields");
  }
  const validFields =
    validCronField(fields[0] ?? "", 0, 59) &&
    validCronField(fields[1] ?? "", 0, 23) &&
    validCronField(fields[2] ?? "", 1, 31) &&
    validCronField(fields[3] ?? "", 1, 12) &&
    validCronField(fields[4] ?? "", 0, 7);
  if (!validFields) {
    throw new ApiRouteError(400, "invalid_schedule", "Cron schedule contains invalid field values");
  }
  const timezone = schedule.timezone ?? fallbackTimezone;
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  for (let offset = 0; offset < CRON_SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = localParts(candidate, timezone);
    const matches =
      cronFieldMatches(parts.minute, fields[0] ?? "*", 0, 59) &&
      cronFieldMatches(parts.hour, fields[1] ?? "*", 0, 23) &&
      cronFieldMatches(parts.day, fields[2] ?? "*", 1, 31) &&
      cronFieldMatches(parts.month, fields[3] ?? "*", 1, 12) &&
      cronWeekdayMatches(parts.weekday, fields[4] ?? "*");
    if (matches) return candidate;
  }

  throw new ApiRouteError(400, "invalid_schedule", "Cron schedule did not produce a run within five years");
}

export function computeScheduledTaskNextRunAt(
  schedule: ScheduledTaskSchedule,
  timezone = DEFAULT_TIMEZONE,
  from = new Date(),
) {
  const parsed = ScheduledTaskScheduleSchema.parse(schedule);
  if (parsed.kind === "at") return new Date(parsed.runAt).toISOString();
  if (parsed.kind === "every") return everyScheduleNextRunAt(parsed, timezone, from).toISOString();
  return cronNextRunAt(parsed, timezone, from).toISOString();
}
