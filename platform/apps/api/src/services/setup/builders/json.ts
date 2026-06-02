import { createHash } from "node:crypto";

import type { Json } from "@kmgrassi/supabase-schema";

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

export function hashConfig(config: unknown) {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

export function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
