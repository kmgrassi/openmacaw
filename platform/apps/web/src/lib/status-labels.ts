import { formatDisplayLabel } from "./display-labels";

export function formatStatusLabel(status: string | null | undefined): string {
  return formatDisplayLabel(status, { lowercaseRemainder: true });
}
