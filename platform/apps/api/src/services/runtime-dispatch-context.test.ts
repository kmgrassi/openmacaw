import { describe, expect, it } from "vitest";

import { resolveRoutedExecutionTargetKind } from "./runtime-dispatch-context.js";
import type { ToolExecutionConfig } from "../config.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";

function config(
  override: Partial<ToolExecutionConfig["containerExecutionRouting"]> = {},
): Pick<ToolExecutionConfig, "localCodingExecutionTargetKind" | "containerExecutionRouting"> {
  return {
    localCodingExecutionTargetKind: "local_helper",
    containerExecutionRouting: {
      mode: "local_helper_default",
      allowlistWorkspaceIds: [],
      percentage: 0,
      ...override,
    },
  };
}

describe("resolveRoutedExecutionTargetKind", () => {
  it("fails closed to local helper when rollout routing is disabled", () => {
    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config(),
      }),
    ).toBe("local_helper");

    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {
          executionTarget: {
            kind: "container",
          },
        },
        workspaceId,
        config: config(),
      }),
    ).toBe("local_helper");
  });

  it("routes allowlisted workspaces to containers", () => {
    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config({
          mode: "allowlist",
          allowlistWorkspaceIds: [workspaceId],
        }),
      }),
    ).toBe("container");

    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId: otherWorkspaceId,
        config: config({
          mode: "allowlist",
          allowlistWorkspaceIds: [workspaceId],
        }),
      }),
    ).toBe("local_helper");
  });

  it("uses the configured percentage as a deterministic workspace rollout", () => {
    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config({
          mode: "percentage",
          percentage: 0,
        }),
      }),
    ).toBe("local_helper");

    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config({
          mode: "percentage",
          percentage: 100,
        }),
      }),
    ).toBe("container");
  });

  it("keeps allowlisted workspaces on containers during percentage rollout", () => {
    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config({
          mode: "percentage",
          allowlistWorkspaceIds: [workspaceId],
          percentage: 0,
        }),
      }),
    ).toBe("container");
  });

  it("makes container the default while preserving explicit local-helper opt-in", () => {
    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {},
        workspaceId,
        config: config({ mode: "container_default" }),
      }),
    ).toBe("container");

    expect(
      resolveRoutedExecutionTargetKind({
        agentToolPolicy: {
          executionTarget: {
            kind: "local_helper",
          },
        },
        workspaceId,
        config: config({ mode: "container_default" }),
      }),
    ).toBe("local_helper");
  });
});
