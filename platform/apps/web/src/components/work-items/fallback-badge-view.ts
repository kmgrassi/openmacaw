import type { ProviderCutover } from "../../api/provider-cutovers";

export type CutoverDetail = {
  id: string;
  transition: string;
  trigger: string;
  outcome: string;
  triggeredAt: string;
  elapsed: string;
};

export type CutoverBadgeView = {
  label: string;
  title: string;
  description: string;
  details: CutoverDetail[];
};

const outcomeLabels: Record<ProviderCutover["outcome"], string> = {
  fallback_succeeded: "Fallback succeeded",
  fallback_failed: "Fallback failed",
  escalated_floor: "Escalated by floor",
  escalated_exhausted: "Fallbacks exhausted",
  skipped_no_adapter: "Skipped adapter",
};

function modelLabel(
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  if (!provider && !model) return "No fallback";
  if (!provider) return model ?? "Unknown model";
  if (!model) return provider;
  return `${provider}/${model}`;
}

function triggerLabel(cutover: ProviderCutover) {
  return cutover.triggerStatusCode
    ? `${cutover.triggerErrorCode} (${cutover.triggerStatusCode})`
    : cutover.triggerErrorCode;
}

export function buildCutoverBadgeView(
  cutovers: readonly ProviderCutover[],
): CutoverBadgeView | null {
  if (cutovers.length === 0) return null;

  const sorted = [...cutovers].sort(
    (left, right) =>
      Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt),
  );
  const latest = sorted[0];
  if (!latest) return null;
  const latestTransition = `${modelLabel(
    latest.fromProvider,
    latest.fromModel,
  )} -> ${modelLabel(latest.toProvider, latest.toModel)}`;

  return {
    label: "Ran on fallback",
    title:
      sorted.length === 1
        ? "1 provider cutover"
        : `${sorted.length} provider cutovers`,
    description: `${latestTransition} after ${triggerLabel(latest)}`,
    details: sorted.map((cutover) => ({
      id: cutover.id,
      transition: `${modelLabel(cutover.fromProvider, cutover.fromModel)} -> ${modelLabel(
        cutover.toProvider,
        cutover.toModel,
      )}`,
      trigger: triggerLabel(cutover),
      outcome: outcomeLabels[cutover.outcome],
      triggeredAt: cutover.triggeredAt,
      elapsed: `${cutover.elapsedMs} ms`,
    })),
  };
}
