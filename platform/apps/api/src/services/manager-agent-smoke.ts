import {
  ManagerAgentSmokeResponseSchema,
  type ManagerAgentSmokeResponse,
} from "../../../../contracts/manager-agent-smoke.js";

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /secret/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

function assertNoSecrets(payload: ManagerAgentSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`Manager smoke harness payload contains secret-like text: ${leaked}`);
  }
}

export function buildManagerAgentSmokeHarness(): ManagerAgentSmokeResponse {
  const response = ManagerAgentSmokeResponseSchema.parse({
    scenario: "manager-agent-end-to-end",
    liveProviderCalls: false,
    workspace: {
      id: "workspace-smoke-manager",
      bootstrappedAgents: ["planning", "coding", "manager"],
    },
    manager: {
      agentId: "manager-agent-smoke",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-smoke",
      runnerKind: "llm_tool_runner",
      credentialRef: { type: "alias", value: "manager_provider_primary" },
    },
    workItem: {
      id: "work-item-manager-smoke",
      state: "ready",
      due: true,
    },
    statusTimeline: [
      {
        status: "idle_awaiting_credential",
        lastTickAt: null,
        lastDecisionCount: null,
        missing: ["credential"],
        error: null,
      },
      {
        status: "not_running",
        lastTickAt: null,
        lastDecisionCount: null,
        missing: [],
        error: null,
      },
      {
        status: "running",
        lastTickAt: "2026-04-27T12:00:00.000Z",
        lastDecisionCount: 1,
        missing: [],
        error: null,
      },
    ],
    events: [
      {
        phase: "login_bootstrap",
        status: "idle_awaiting_credential",
        message: "Auth bootstrap created planning, coding, and workspace manager agents.",
      },
      {
        phase: "credential_attached",
        status: "not_running",
        message: "Workspace credential alias attached to the manager execution profile.",
      },
      {
        phase: "work_item_due",
        status: "not_running",
        message: "Runtime scheduler fixture observes one due work item.",
      },
      {
        phase: "manager_turn_completed",
        status: "running",
        message: "Manager fixture records one reconciliation decision.",
      },
      {
        phase: "status_updated",
        status: "running",
        message: "Manager status reports a last tick and decision count.",
      },
    ],
    localFlow: [
      "Start Supabase, the platform API, web app, and orchestrator runtime.",
      "Open the web app and sign in to trigger /api/auth/state bootstrap.",
      "Attach or reuse a workspace credential for the Manager Agent.",
      "Create or seed one ready work item, then wait for the next manager scheduler tick.",
      "Poll the Manager Agent status from the browser and verify it reaches running with a decision count.",
    ],
  });

  assertNoSecrets(response);
  return response;
}
