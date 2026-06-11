import { describe, expect, it } from "vitest";

import { LocalExecutionTargetSchema } from "../../../../../contracts/local-runtime.js";
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

  it("derives schema status from helperOnline when older mappers omit it", () => {
    expect(
      LocalExecutionTargetSchema.parse({
        machineId: "machine-1",
        machineDisplayName: "coder box",
        helperOnline: true,
        lastSeenAt: new Date().toISOString(),
        workspaceRoot: "/workspace",
        registered: true,
      }),
    ).toMatchObject({
      status: "online",
      helperOnline: true,
    });
  });
});
