import { describe, expect, it } from "vitest";

import { buildLocalExecution } from "./config-snippet.js";

describe("buildLocalExecution", () => {
  it("derives online status from a fresh heartbeat", () => {
    const lastSeenAt = new Date().toISOString();

    expect(
      buildLocalExecution({
        machine: {
          id: "machine-1",
          display_name: "coder box",
          last_seen_at: lastSeenAt,
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
        },
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      status: "online",
      helperOnline: true,
    });
  });
});
