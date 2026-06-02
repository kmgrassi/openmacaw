const MAX_SUMMARY_LENGTH = 2_000;
const MAX_JSON_STRING_LENGTH = 4_000;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_ARRAY_ITEMS = 50;
const MAX_JSON_OBJECT_KEYS = 100;
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|credential|password|secret|token)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[a-z0-9][a-z0-9_-]{8,}|[a-z0-9._%+-]+:[a-z0-9._%+-]+@[a-z0-9.-]+)\b/gi;

export function latestTimestamp(...values: Array<string | null | undefined>) {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time);

  return timestamps[0]?.value ?? null;
}

export function normalizePage(value: number | undefined) {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

export function redactAndTruncateText(value: string, maxLength = MAX_JSON_STRING_LENGTH) {
  const redacted = value.replace(SECRET_VALUE_PATTERN, "[redacted]");
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}... [truncated ${redacted.length - maxLength} chars]`;
}

export function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactAndTruncateText(value);
  if (value === undefined) return null;
  if (depth >= MAX_JSON_DEPTH) return "[truncated: max depth]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_JSON_ARRAY_ITEMS).map((item) => sanitizeJsonValue(item, depth + 1));
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_JSON_ARRAY_ITEMS} items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entryValue] of entries.slice(0, MAX_JSON_OBJECT_KEYS)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeJsonValue(entryValue, depth + 1);
    }
    if (entries.length > MAX_JSON_OBJECT_KEYS) {
      output.__truncatedKeys = entries.length - MAX_JSON_OBJECT_KEYS;
    }
    return output;
  }

  return String(value);
}

export function sanitizeRecord(value: Record<string, unknown>) {
  const sanitized = sanitizeJsonValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

export function sanitizeRecordArray(values: Array<Record<string, unknown>>) {
  return values.slice(0, MAX_JSON_ARRAY_ITEMS).map((value) => sanitizeRecord(value));
}

export function sanitizeSummary(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? redactAndTruncateText(trimmed, MAX_SUMMARY_LENGTH) : null;
}
