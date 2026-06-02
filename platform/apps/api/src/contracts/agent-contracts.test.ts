import { describe, expect, it } from "vitest";

import {
  AgentObservationResponseSchema,
  AgentTypeSchema,
  StoredAgentListResponseSchema,
  normalizeAgentType,
} from "../../../../contracts/agents.js";
import { StoredAgentCreateRequestSchema } from "../../../../contracts/stored-agent-management.js";
import { DefaultAgentRoleSchema, SetupAuthStateSchema, SetupResponseSchema } from "../../../../contracts/setup.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const managerAgentId = "55555555-5555-4555-8555-555555555555";

describe("agent type contracts", () => {
  it("round-trips manager stored agents without coercing them to coding", () => {
    expect(AgentTypeSchema.parse("manager")).toBe("manager");
    expect(normalizeAgentType("manager")).toBe("manager");
    expect(normalizeAgentType("legacy-unknown")).toBe("coding");

    const parsed = StoredAgentListResponseSchema.parse({
      agents: [
        {
          id: managerAgentId,
          name: "Manager Agent",
          workspaceId,
          agentType: "manager",
          model: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          hasCredentials: false,
          isResolved: false,
          planningDestination: null,
          customTarget: null,
        },
      ],
    });

    expect(parsed.agents[0]?.agentType).toBe("manager");
  });

  it("accepts manager in setup-facing agent payloads", () => {
    const setup = SetupResponseSchema.parse({
      agent: {
        id: managerAgentId,
        workspaceId,
        name: "Manager Agent",
        status: "active",
        type: "manager",
        modelSettings: { primary: "anthropic/claude-sonnet-4-6" },
        toolPolicy: {},
        createdByUserId: userId,
        updatedAt: "2026-04-27T12:00:00.000Z",
      },
      engine: null,
      runtimeHealth: null,
      gatewayConfig: null,
      gatewayConfigState: null,
      requirements: {
        configured: false,
        missing: ["credential", "gateway_config", "runner"],
      },
    });

    expect(setup.agent.type).toBe("manager");

    const authState = SetupAuthStateSchema.parse({
      ready: true,
      userId,
      resolvedAgentId: managerAgentId,
      workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: "Personal Workspace",
          ownerUserId: userId,
          createdAt: "2026-04-27T12:00:00.000Z",
        },
      ],
      agents: [setup.agent],
    });

    expect(authState.agents[0]?.type).toBe("manager");
  });

  it("keeps manager out of default-agent role contracts", () => {
    expect(DefaultAgentRoleSchema.safeParse("manager").success).toBe(false);
  });

  it("accepts manager in stored-agent mutation and observation contracts", () => {
    expect(
      StoredAgentCreateRequestSchema.parse({
        name: "Manager Agent",
        workspaceId,
        type: "manager",
        model: "anthropic/claude-sonnet-4-6",
      }).type,
    ).toBe("manager");

    const observed = AgentObservationResponseSchema.parse({
      observerAgentId: null,
      targetAgent: {
        id: managerAgentId,
        name: "Manager Agent",
        workspaceId,
        agentType: "manager",
      },
      health: {
        status: "unknown",
        config: {
          status: null,
          error: null,
          checkedAt: null,
        },
        runtime: {
          status: null,
          lastHeartbeatAt: null,
          instanceId: null,
        },
        launcher: {
          reachable: false,
          status: null,
          error: null,
        },
        latestRun: null,
        lastFailure: null,
      },
      events: [],
    });

    expect(observed.targetAgent.agentType).toBe("manager");
  });
});
