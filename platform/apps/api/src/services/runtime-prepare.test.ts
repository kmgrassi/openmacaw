import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionProfile, ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { ApiRouteError } from "../http.js";

vi.mock("./execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));
vi.mock("./ensure-gateway-config.js", () => ({
  ensureGatewayConfigExists: vi.fn(),
}));
vi.mock("./local-coding-execution-target.js", () => ({
  resolveLocalCodingExecutionTarget: vi.fn(),
}));

const { resolveExecutionProfile } = vi.mocked(await import("./execution-profile-resolver.js"));
const { ensureGatewayConfigExists } = vi.mocked(await import("./ensure-gateway-config.js"));
const { resolveLocalCodingExecutionTarget } = vi.mocked(await import("./local-coding-execution-target.js"));
const { assertRuntimePrepareSupported } = await import("./runtime-prepare.js");

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const accessToken = "test-access-token";
const userId = "33333333-3333-4333-8333-333333333333";

function profile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    agentId,
    workspaceId,
    role: "coding",
    runnerKind: "codex",
    provider: "openai",
    model: "openai/gpt-5.2",
    credentialRef: { type: "credential_id", value: "cred-123" },
    toolProfile: "coding",
    capabilities: {
      streaming: true,
      toolCalls: true,
      workspaceWrite: true,
      structuredOutput: false,
      interrupt: true,
    },
    ...overrides,
  };
}

function completeResolution(overrides: Partial<ExecutionProfileResolution> = {}): ExecutionProfileResolution {
  const resolvedProfile = profile(overrides.profile ?? {});

  return {
    agent: {
      agentId: resolvedProfile.agentId,
      workspaceId: resolvedProfile.workspaceId,
      role: resolvedProfile.role,
    },
    profile: resolvedProfile,
    missing: [],
    source: {
      routingRuleId: "rule-1",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
    ...overrides,
  };
}

function localRuntimeResolution(): ExecutionProfileResolution {
  return completeResolution({
    agent: { agentId, workspaceId, role: "coding" },
    profile: profile({
      role: "coding",
      runnerKind: "local_runtime",
      provider: "local",
      model: "llama3",
      credentialRef: null,
      capabilities: {
        streaming: true,
        toolCalls: false,
        workspaceWrite: false,
        structuredOutput: false,
        interrupt: false,
      },
    }),
    source: {
      routingRuleId: "rule-local",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  });
}

function localRelayResolution(): ExecutionProfileResolution {
  return completeResolution({
    agent: { agentId, workspaceId, role: "manager" },
    profile: profile({
      role: "manager",
      runnerKind: "local_relay",
      provider: "local",
      model: "qwen3-coder:30b",
      credentialRef: null,
      toolProfile: "manager",
      capabilities: {
        streaming: true,
        toolCalls: false,
        workspaceWrite: false,
        structuredOutput: false,
        interrupt: false,
      },
    }),
    source: {
      routingRuleId: "rule-local-relay",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  });
}

describe("assertRuntimePrepareSupported", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("short-circuits custom agents before credential preflight", async () => {
    resolveExecutionProfile.mockResolvedValueOnce(
      completeResolution({
        agent: { agentId, role: "custom", workspaceId },
        profile: profile({
          role: "custom",
          runnerKind: "openclaw_ws",
        }),
      }),
    );

    await expect(assertRuntimePrepareSupported(accessToken, userId, agentId)).rejects.toMatchObject({
      status: 422,
      code: "custom_runtime_unsupported",
    });

    expect(resolveExecutionProfile).toHaveBeenCalledTimes(1);
    expect(resolveExecutionProfile).toHaveBeenCalledWith({
      accessToken,
      requesterUserId: userId,
      agentId,
      skipCredentialCheck: true,
    });
  });

  it("keeps the custom-runtime error when a custom profile is incomplete", async () => {
    resolveExecutionProfile.mockResolvedValueOnce(
      completeResolution({
        agent: { agentId, role: "custom", workspaceId },
        profile: null,
        missing: ["model"],
      }),
    );

    await expect(assertRuntimePrepareSupported(accessToken, userId, agentId)).rejects.toMatchObject({
      status: 422,
      code: "custom_runtime_unsupported",
    });

    expect(resolveExecutionProfile).toHaveBeenCalledTimes(1);
  });

  it("planning agent with credentials resolves successfully", async () => {
    const resolution = completeResolution({
      agent: { agentId, workspaceId, role: "planning" },
      profile: profile({
        role: "planning",
        runnerKind: "llm_tool_runner",
        toolProfile: "planning",
        capabilities: {
          streaming: true,
          toolCalls: true,
          workspaceWrite: false,
          structuredOutput: true,
          interrupt: false,
        },
      }),
    });
    resolveExecutionProfile.mockResolvedValue(resolution);

    const result = await assertRuntimePrepareSupported(accessToken, userId, agentId);

    expect(result).toEqual({
      agentId,
      agentType: "planning",
      workspaceId,
      localRuntime: false,
    });
    expect(resolveExecutionProfile).toHaveBeenLastCalledWith({ accessToken, requesterUserId: userId, agentId });
  });

  it("planning agent without credentials returns 422", async () => {
    const initialResolution = completeResolution({
      agent: { agentId, workspaceId, role: "planning" },
      profile: profile({ role: "planning" }),
    });
    const missingCredentialResolution: ExecutionProfileResolution = {
      agent: { agentId, workspaceId, role: "planning" },
      profile: null,
      missing: ["credential"],
      source: {
        routingRuleId: "rule-1",
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    };
    resolveExecutionProfile.mockResolvedValueOnce(initialResolution).mockResolvedValueOnce(missingCredentialResolution);

    await expect(assertRuntimePrepareSupported(accessToken, userId, agentId)).rejects.toThrow(
      expect.objectContaining({
        status: 422,
        code: "agent_runtime_unconfigured",
      }),
    );
  });

  it("creates a missing default gateway config before resolving launcher runtime", async () => {
    const missingGatewayConfigResolution: ExecutionProfileResolution = {
      agent: { agentId, workspaceId, role: "coding" },
      profile: null,
      missing: ["runner", "gateway_config"],
      source: {
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: true,
        legacyGatewayConfigUsed: false,
      },
    };
    const healedResolution = completeResolution();
    resolveExecutionProfile
      .mockResolvedValueOnce(missingGatewayConfigResolution)
      .mockResolvedValueOnce(healedResolution);

    const result = await assertRuntimePrepareSupported(accessToken, userId, agentId);

    expect(ensureGatewayConfigExists).toHaveBeenCalledWith({
      agentId,
      role: "coding",
    });
    expect(result).toEqual({
      agentId,
      agentType: "coding",
      workspaceId,
      localRuntime: false,
    });
  });

  it("local_model_coding agents require a registered helper before startup", async () => {
    resolveExecutionProfile.mockResolvedValueOnce(
      completeResolution({
        agent: { agentId, workspaceId, role: "coding" },
        profile: profile({
          role: "coding",
          runnerKind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credentialRef: null,
          capabilities: {
            streaming: true,
            toolCalls: true,
            workspaceWrite: true,
            structuredOutput: true,
            interrupt: true,
          },
        }),
      }),
    );
    resolveLocalCodingExecutionTarget.mockResolvedValueOnce({
      kind: "local_helper",
      workspaceId,
      runnerKind: "local_model_coding",
      machineId: "machine-1",
      workspaceRootRef: "local_runtime_machine:machine-1",
    });
    resolveExecutionProfile.mockResolvedValueOnce(
      completeResolution({
        agent: { agentId, workspaceId, role: "coding" },
        profile: profile({
          role: "coding",
          runnerKind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credentialRef: null,
        }),
      }),
    );

    const result = await assertRuntimePrepareSupported(accessToken, userId, agentId);

    expect(result).toEqual({
      agentId,
      agentType: "coding",
      workspaceId,
      localRuntime: true,
    });
    expect(resolveLocalCodingExecutionTarget).toHaveBeenCalledWith({ workspaceId });
  });

  it("local_runtime agent bypasses launcher in development", async () => {
    process.env.NODE_ENV = "development";

    const resolution = localRuntimeResolution();
    resolveExecutionProfile.mockResolvedValue(resolution);

    const result = await assertRuntimePrepareSupported(accessToken, userId, agentId);

    expect(result).toEqual({
      agentId,
      agentType: "coding",
      workspaceId,
      localRuntime: true,
    });
  });

  it("local_runtime bypass is blocked in production", async () => {
    process.env.NODE_ENV = "production";

    const resolution = localRuntimeResolution();
    resolveExecutionProfile.mockResolvedValue(resolution);

    const error = await assertRuntimePrepareSupported(accessToken, userId, agentId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).status).toBe(422);
    expect((error as ApiRouteError).code).toBe("local_runtime_not_supported");
  });

  it("local_relay agent uses launcher startup in production", async () => {
    process.env.NODE_ENV = "production";

    const resolution = localRelayResolution();
    resolveExecutionProfile.mockResolvedValue(resolution);

    const result = await assertRuntimePrepareSupported(accessToken, userId, agentId);

    expect(result).toEqual({
      agentId,
      agentType: "manager",
      workspaceId,
      localRuntime: false,
    });
  });

  it("local_runtime bypass is blocked when NODE_ENV is not development", async () => {
    process.env.NODE_ENV = "test";

    const resolution = localRuntimeResolution();
    resolveExecutionProfile.mockResolvedValue(resolution);

    await expect(assertRuntimePrepareSupported(accessToken, userId, agentId)).rejects.toThrow(
      expect.objectContaining({
        status: 422,
        code: "local_runtime_not_supported",
      }),
    );
  });

  it("agent with no routing rule and no gateway config returns 422 with all missing requirements", async () => {
    const initialResolution = completeResolution();
    const unconfiguredResolution: ExecutionProfileResolution = {
      agent: { agentId, workspaceId, role: "coding" },
      profile: null,
      missing: ["runner", "provider", "model", "credential", "gateway_config"],
      source: {
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: true,
        legacyGatewayConfigUsed: false,
      },
    };
    resolveExecutionProfile.mockResolvedValueOnce(initialResolution).mockResolvedValueOnce(unconfiguredResolution);

    const error = await assertRuntimePrepareSupported(accessToken, userId, agentId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).status).toBe(422);
    expect((error as ApiRouteError).code).toBe("agent_runtime_unconfigured");
    expect((error as ApiRouteError).details).toMatchObject({
      missing: expect.arrayContaining(["runner", "provider", "model", "credential", "gateway_config"]),
      configured: false,
      checklist: expect.arrayContaining([
        {
          step: "routing_rule",
          status: "fail",
          label: "Routing rule required",
          action: "configure_routing",
          actionUrl: `/settings/agents/${agentId}`,
        },
        {
          step: "credential_configured",
          status: "fail",
          label: "API key required",
          action: "add_credential",
          actionUrl: `/settings/agents/${agentId}`,
        },
        {
          step: "gateway_config",
          status: "fail",
          label: "Gateway config missing",
          action: "configure_runtime",
          actionUrl: `/settings/agents/${agentId}`,
        },
        {
          step: "runner_configured",
          status: "fail",
          label: "Runtime not configured",
          action: "configure_runtime",
          actionUrl: `/settings/agents/${agentId}`,
        },
      ]),
    });
  });

  it("agent not found returns 404", async () => {
    const resolution: ExecutionProfileResolution = {
      agent: null,
      profile: null,
      missing: ["agent"],
      source: {
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    };
    resolveExecutionProfile.mockResolvedValue(resolution);

    const error = await assertRuntimePrepareSupported(accessToken, userId, agentId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).status).toBe(404);
    expect((error as ApiRouteError).code).toBe("agent_not_found");
  });
});
