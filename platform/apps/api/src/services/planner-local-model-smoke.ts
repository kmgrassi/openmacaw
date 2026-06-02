import {
  PlannerLocalModelSmokeResponseSchema,
  type PlannerLocalModelSmokeResponse,
} from "../../../../contracts/planner-local-model-smoke.js";

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /secret/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

type PlannerLocalModelSmokeInput = {
  model?: string;
  observedMs?: string;
};

function cleanModel(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate || SECRET_PATTERNS.some((pattern) => pattern.test(candidate))) {
    return "qwen2.5-coder:7b";
  }
  return candidate;
}

function cleanObservedMs(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18_000;
}

function assertNoSecrets(payload: PlannerLocalModelSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`Planner local-model smoke payload contains secret-like text: ${leaked}`);
  }
}

export function buildPlannerLocalModelSmokeHarness(
  input: PlannerLocalModelSmokeInput = {},
): PlannerLocalModelSmokeResponse {
  const model = cleanModel(input.model);
  const observedMs = cleanObservedMs(input.observedMs);

  const response = PlannerLocalModelSmokeResponseSchema.parse({
    scenario: "planner-local-model-end-to-end",
    liveProviderCalls: false,
    profile: {
      role: "planning",
      runnerKind: "local_relay",
      provider: "local",
      model,
      credentialRef: null,
      toolProfile: "planning",
      capabilities: {
        streaming: true,
        toolCalls: false,
        workspaceWrite: false,
        structuredOutput: false,
        interrupt: false,
      },
    },
    diagnostic: {
      endpoint: "/api/diagnostic/agents/planning-agent-smoke?workspaceId=workspace-smoke-planner",
      resolved: true,
      localRuntime: {
        isLocal: true,
        expectedRunnerKind: "local_relay",
        helperConnectivityRequired: true,
      },
    },
    plannerOutput: {
      planId: "plan-local-planner-smoke",
      taskIds: ["task-local-planner-smoke"],
      workItem: {
        id: "work-item-local-planner-smoke",
        source: "planner",
        state: "ready",
        title: "Verify planner local-model smoke fixture",
      },
    },
    latency: {
      observedMs,
      followUp: "Track local planner latency against runtime PR8 after native planner local relay lands.",
    },
    toolCalls: [
      {
        id: "tool-call-plan-create",
        toolSlug: "plan.create",
        status: "completed",
        arguments: {
          name: "Local planner smoke plan",
          workspaceId: "workspace-smoke-planner",
        },
        result: {
          planId: "plan-local-planner-smoke",
        },
      },
      {
        id: "tool-call-task-create",
        toolSlug: "task.create",
        status: "completed",
        arguments: {
          planId: "plan-local-planner-smoke",
          title: "Verify planner local-model smoke fixture",
        },
        result: {
          taskId: "task-local-planner-smoke",
          workItemId: "work-item-local-planner-smoke",
          workItemSource: "planner",
        },
      },
    ],
    events: [
      {
        phase: "demo_planner_profile_seeded",
        source: "platform",
        message: `Demo planning agent resolves to local/${model}.`,
      },
      {
        phase: "diagnostic_verified_local_route",
        source: "platform",
        message: "Diagnostic output reports a resolved local_relay planning profile and local runtime section.",
      },
      {
        phase: "runtime_dispatch_accepted",
        source: "runtime",
        message: "Runtime accepted the local planner relay dispatch.",
      },
      {
        phase: "planner_tool_bundle_loaded",
        source: "runtime",
        message: "Planner run loaded the planning tool bundle.",
      },
      {
        phase: "plan_created",
        source: "tool",
        message: "Planner created a plan through plan.create.",
      },
      {
        phase: "tasks_created",
        source: "tool",
        message: "Planner created a task through task.create.",
      },
      {
        phase: "work_item_created",
        source: "database",
        message: "Task projection produced a ready work item with source planner.",
      },
      {
        phase: "latency_recorded",
        source: "platform",
        message: `Observed planner local-model smoke latency was ${observedMs}ms.`,
      },
    ],
    localFlow: [
      "Start Ollama or another local model endpoint with qwen2.5-coder:7b available.",
      "Start parallel-agent-runtime with runtime PR8 local planner relay support.",
      "Start this platform with NODE_ENV=development and pnpm run dev.",
      "Log in with dev credentials so setup bootstraps the demo planning agent.",
      "Open the diagnostic endpoint for the planning agent and verify local_relay/local routing.",
      "Run the Browser Login And Planner Work Item Smoke and verify a work_items row with source planner.",
    ],
  });

  assertNoSecrets(response);
  return response;
}
