type FormatDisplayLabelOptions = {
  fallback?: string;
  lowercaseRemainder?: boolean;
};

export function normalizeDisplayLabel(
  value: string | null | undefined,
): string {
  return value?.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ") ?? "";
}

export function formatDisplayLabel(
  value: string | null | undefined,
  options: FormatDisplayLabelOptions = {},
): string {
  const normalized = normalizeDisplayLabel(value);
  if (!normalized) return options.fallback ?? "Unknown";

  const remainder = options.lowercaseRemainder
    ? normalized.slice(1).toLowerCase()
    : normalized.slice(1);
  return normalized.charAt(0).toUpperCase() + remainder;
}
