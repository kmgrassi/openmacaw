import { describe, expect, it } from "vitest";

import { formatStatusLabel } from "./status-labels";

describe("formatStatusLabel", () => {
  it("normalizes underscored and hyphenated values", () => {
    expect(formatStatusLabel("approval_required")).toBe("Approval required");
    expect(formatStatusLabel("runtime-bridge-startup-failed")).toBe(
      "Runtime bridge startup failed",
    );
  });

  it("trims and lowercases the remaining content", () => {
    expect(formatStatusLabel("  RUNNING_PARTIAL  ")).toBe("Running partial");
  });

  it("falls back to Unknown for empty values", () => {
    expect(formatStatusLabel("   ")).toBe("Unknown");
    expect(formatStatusLabel(null)).toBe("Unknown");
    expect(formatStatusLabel(undefined)).toBe("Unknown");
  });
});
