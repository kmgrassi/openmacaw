import { sortValue, stableJson } from "./json.js";

export function buildChangeSummary(current: unknown, next: unknown) {
  const currentJson = sortValue(current) as Record<string, unknown>;
  const nextJson = sortValue(next) as Record<string, unknown>;
  const changedKeys = Array.from(new Set([...Object.keys(currentJson ?? {}), ...Object.keys(nextJson ?? {})])).filter(
    (key) => stableJson(currentJson?.[key]) !== stableJson(nextJson?.[key]),
  );

  return {
    changed_keys: changedKeys,
  };
}
