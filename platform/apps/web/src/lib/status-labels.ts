export function formatStatusLabel(status: string | null | undefined): string {
  const normalized = status?.trim().replace(/[_-]+/g, " ");
  if (!normalized) return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}
