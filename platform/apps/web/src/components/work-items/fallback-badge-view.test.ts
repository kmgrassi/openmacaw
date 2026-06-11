import { describe, expect, it } from "vitest";

import type { ProviderCutover } from "../../api/provider-cutovers";
import { buildCutoverBadgeView } from "./fallback-badge-view";

function cutover(input: Partial<ProviderCutover>): ProviderCutover {
  return {
    id: input.id ?? "cutover-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    workItemId: "work-item-1",
    triggeredAt: input.triggeredAt ?? "2026-06-11T12:00:00.000Z",
    fromProvider: input.fromProvider ?? "anthropic",
    fromModel: input.fromModel ?? "claude-opus-4-7",
    fromCredentialId: null,
    toProvider: input.toProvider === undefined ? "openai" : input.toProvider,
    toModel: input.toModel === undefined ? "gpt-4o" : input.toModel,
    toCredentialId: null,
    triggerErrorCode: input.triggerErrorCode ?? "provider_rate_limited",
    triggerStatusCode:
      input.triggerStatusCode === undefined ? 429 : input.triggerStatusCode,
    elapsedMs: input.elapsedMs ?? 1200,
    outcome: input.outcome ?? "fallback_succeeded",
  };
}

describe("buildCutoverBadgeView", () => {
  it("returns no badge view when a work item has no cutovers", () => {
    expect(buildCutoverBadgeView([])).toBeNull();
  });

  it("summarizes one cutover with transition and trigger details", () => {
    expect(buildCutoverBadgeView([cutover({})])).toMatchObject({
      label: "Ran on fallback",
      title: "1 provider cutover",
      description:
        "anthropic/claude-opus-4-7 -> openai/gpt-4o after provider_rate_limited (429)",
      details: [
        {
          transition: "anthropic/claude-opus-4-7 -> openai/gpt-4o",
          trigger: "provider_rate_limited (429)",
          outcome: "Fallback succeeded",
          elapsed: "1200 ms",
        },
      ],
    });
  });

  it("orders many cutovers newest-first and counts them", () => {
    const view = buildCutoverBadgeView([
      cutover({
        id: "older",
        triggeredAt: "2026-06-11T12:00:00.000Z",
        outcome: "fallback_failed",
      }),
      cutover({
        id: "newer",
        triggeredAt: "2026-06-11T12:05:00.000Z",
        fromProvider: "openai",
        fromModel: "gpt-4o",
        toProvider: null,
        toModel: null,
        triggerErrorCode: "provider_overloaded",
        triggerStatusCode: null,
        outcome: "escalated_exhausted",
      }),
    ]);

    expect(view?.title).toBe("2 provider cutovers");
    expect(view?.description).toBe(
      "openai/gpt-4o -> No fallback after provider_overloaded",
    );
    expect(view?.details.map((detail) => detail.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(view?.details[0]).toMatchObject({
      outcome: "Fallbacks exhausted",
      trigger: "provider_overloaded",
    });
  });
});
