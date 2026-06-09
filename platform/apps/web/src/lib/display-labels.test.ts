import { describe, expect, it } from "vitest";

import { formatDisplayLabel, normalizeDisplayLabel } from "./display-labels";

describe("normalizeDisplayLabel", () => {
  it("collapses underscores, hyphens, and repeated whitespace", () => {
    expect(normalizeDisplayLabel(" runtime-bridge_startup   failed ")).toBe(
      "runtime bridge startup failed",
    );
  });

  it("returns an empty string for blank values", () => {
    expect(normalizeDisplayLabel("   ")).toBe("");
    expect(normalizeDisplayLabel(null)).toBe("");
    expect(normalizeDisplayLabel(undefined)).toBe("");
  });
});

describe("formatDisplayLabel", () => {
  it("sentence-cases normalized labels by default", () => {
    expect(formatDisplayLabel("approval_required")).toBe("Approval required");
  });

  it("optionally lowercases the remainder for inconsistent inputs", () => {
    expect(
      formatDisplayLabel("  RUNNING_PARTIAL  ", { lowercaseRemainder: true }),
    ).toBe("Running partial");
  });

  it("preserves the remainder when lowercasing is not requested", () => {
    expect(formatDisplayLabel("turn.Completed")).toBe("Turn.Completed");
  });

  it("uses the configured fallback for blank values", () => {
    expect(formatDisplayLabel("   ", { fallback: "" })).toBe("");
    expect(formatDisplayLabel(undefined)).toBe("Unknown");
  });
});
