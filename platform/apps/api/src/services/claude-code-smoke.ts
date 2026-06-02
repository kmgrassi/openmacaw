import {
  ClaudeCodeSmokeResponseSchema,
  type ClaudeCodeSmokeResponse,
} from "../../../../contracts/claude-code-smoke.js";

type ClaudeCodeSmokeInput = {
  model?: string;
};

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /secret/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

function clean(value: string | undefined, fallback: string) {
  const candidate = value?.trim();
  return candidate && !SECRET_PATTERNS.some((pattern) => pattern.test(candidate)) ? candidate : fallback;
}

function assertNoSecrets(payload: ClaudeCodeSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`Claude Code smoke payload contains secret-like text: ${leaked}`);
  }
}

export function buildClaudeCodeDispatchSmokeHarness(input: ClaudeCodeSmokeInput = {}): ClaudeCodeSmokeResponse {
  const claudeModel = clean(input.model, "sonnet");
  const planning = {
    name: "planning-agent-smoke",
    agentRole: "planning" as const,
    runnerKind: "llm_tool_runner",
    provider: "anthropic",
    model: "claude-sonnet-planner-smoke",
    credentialRef: {
      kind: "alias" as const,
      value: "anthropic/default",
    },
    toolProfile: "planning",
  };
  const coding = {
    name: "claude-code-coding-agent-smoke",
    agentRole: "coding" as const,
    runnerKind: "claude_code",
    provider: "anthropic",
    model: claudeModel,
    credentialRef: {
      kind: "alias" as const,
      value: "anthropic/default",
    },
    toolProfile: "coding",
  };
  const plan = {
    id: "plan-smoke-claude-code-dispatch",
    title: "Claude Code dispatch smoke",
    createdByProfile: planning.name,
  };
  const workItem = {
    id: "work-item-claude-code-edit",
    title: "Apply a disposable workspace edit",
    status: "completed" as const,
    assignedAgentProfile: coding.name,
  };

  const response = ClaudeCodeSmokeResponseSchema.parse({
    scenario: "planning-agent-to-claude-code-coding-dispatch",
    liveProviderCalls: false,
    profiles: { planning, coding },
    plan,
    workItem,
    dispatch: {
      planId: plan.id,
      workItemId: workItem.id,
      routedToProfile: coding.name,
      runtimeProfile: {
        role: "coding",
        runner_kind: "claude_code",
        provider: "anthropic",
        model: claudeModel,
        credential_ref: "credential_alias:anthropic/default",
        tool_profile: "coding",
      },
    },
    normalizedEvents: [
      {
        kind: "assistant_delta",
        label: "Claude Code assistant delta streamed",
        runnerKind: "claude_code",
        provider: "anthropic",
        visibleInDashboard: true,
      },
      {
        kind: "tool_started",
        label: "Workspace edit tool started",
        runnerKind: "claude_code",
        provider: "anthropic",
        visibleInDashboard: true,
      },
      {
        kind: "tool_completed",
        label: "Workspace edit tool completed",
        runnerKind: "claude_code",
        provider: "anthropic",
        visibleInDashboard: true,
      },
      {
        kind: "turn_completed",
        label: "Claude Code turn completed",
        runnerKind: "claude_code",
        provider: "anthropic",
        visibleInDashboard: true,
      },
      {
        kind: "usage_reported",
        label: "Usage reported through normalized runtime event",
        runnerKind: "claude_code",
        provider: "anthropic",
        visibleInDashboard: true,
      },
    ],
    workspaceEvidence: {
      diffSummary: "Disposable workspace contains the expected Claude Code edit.",
      logLines: [
        "dispatch runner_kind=claude_code provider=anthropic tool_profile=coding",
        `runtime_profile model=${claudeModel} credential_ref=credential_alias:anthropic/default`,
        "events assistant_delta,tool_started,tool_completed,turn_completed,usage_reported visible=true",
        "workspace diff_status=present run_status=completed",
      ],
    },
  });

  assertNoSecrets(response);
  return response;
}
