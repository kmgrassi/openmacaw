import { describe, expect, it } from "vitest";

import { runtimeErrorFix } from "./runtime-error-fix";

describe("runtimeErrorFix", () => {
  it("maps local_runtime_not_supported to the local runtimes setup page", () => {
    expect(runtimeErrorFix("local_runtime_not_supported")).toEqual({
      label: "Set up local runtime",
      to: "/settings/local-runtimes",
    });
  });

  it("returns the first recognized code when several are passed", () => {
    expect(
      runtimeErrorFix(undefined, "unknown_code", "local_runtime_not_supported"),
    ).toEqual({
      label: "Set up local runtime",
      to: "/settings/local-runtimes",
    });
  });

  it("returns null for unknown or empty codes", () => {
    expect(runtimeErrorFix()).toBeNull();
    expect(runtimeErrorFix(null, undefined, "")).toBeNull();
    expect(runtimeErrorFix("some_other_error")).toBeNull();
    // runtime_unreachable is intentionally not mapped — it is not specific to
    // local runtimes (any runtime/orchestrator outage produces it).
    expect(runtimeErrorFix("runtime_unreachable")).toBeNull();
    // Guard against prototype keys leaking through the lookup.
    expect(runtimeErrorFix("toString")).toBeNull();
    expect(runtimeErrorFix("constructor")).toBeNull();
  });
});
