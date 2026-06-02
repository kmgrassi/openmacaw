import { describe, expect, it } from "vitest";

import {
  DiagnosticErrorCodeSchema,
  WorkspaceAgentDiagnosticResponseSchema,
  WorkspaceAgentDiagnosticRuntimeResponseSchema,
} from "../../../../contracts/agent-health.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

describe("agent health contracts", () => {
  it("validates the runtime workspace diagnostic row shape", () => {
    const runtime = WorkspaceAgentDiagnosticRuntimeResponseSchema.parse({
      workspace_id: workspaceId,
      agents: [
        {
          agent_id: agentId,
          runner_kind: "codex",
          status: "not_ready",
          reason: "runner_spawn_failed",
          details: {
            stage: "bash_port_dead",
            binary: "codex",
            container_inventory: { codex: false, bash: true },
          },
        },
      ],
    });

    expect(runtime.agents[0]?.reason).toBe("runner_spawn_failed");
  });

  it("validates the platform workspace diagnostic response shape", () => {
    const response = WorkspaceAgentDiagnosticResponseSchema.parse({
      ok: true,
      workspaceId,
      agents: [
        {
          agentId,
          runnerKind: "codex",
          status: "error",
          errorCode: "runner_spawn_failed",
          errorDetails: {
            stage: "bash_port_dead",
            binary: "codex",
            containerInventory: { codex: false, bash: true },
          },
        },
      ],
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.agents[0]?.status).toBe("error");
    }
  });

  it("keeps diagnostic error codes explicit for future drift checks", () => {
    expect(DiagnosticErrorCodeSchema.options).toEqual([
      "gateway_config_missing",
      "execution_profile_unresolved",
      "credential_missing",
      "runner_spawn_failed",
      "cleanup_failed",
      "timeout",
    ]);
  });
});
