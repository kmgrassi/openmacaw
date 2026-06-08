import { describe, expect, it } from "vitest";

import { runtimeErrorFix } from "./runtime-error-fix";

describe("runtimeErrorFix", () => {
  it("maps runtime_unreachable to the local runtimes setup page", () => {
    expect(runtimeErrorFix("runtime_unreachable")).toEqual({
      label: "Check local runtime",
      to: "/settings/local-runtimes",
    });
  });

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
    // Guard against prototype keys leaking through the lookup.
    expect(runtimeErrorFix("toString")).toBeNull();
    expect(runtimeErrorFix("constructor")).toBeNull();
  });
});
