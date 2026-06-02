import {
  ModelAgnosticSmokeResponseSchema,
  type ModelAgnosticSmokeResponse,
  type SmokeExecutionProfile,
} from "../../../../contracts/model-agnostic-smoke.js";
import { codingHandoffEnv } from "./planning-handoff.js";

type SmokeProviderInput = {
  planningProvider?: string;
  planningModel?: string;
  codingProvider?: string;
  codingModel?: string;
};

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /secret/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

function clean(value: string | undefined, fallback: string) {
  const candidate = value?.trim();
  return candidate && !SECRET_PATTERNS.some((pattern) => pattern.test(candidate)) ? candidate : fallback;
}

function profile(input: {
  name: string;
  agentRole: "planning" | "coding";
  runnerKind: string;
  provider: string;
  model: string;
  credentialAlias: string;
  toolProfile: string;
  providerAdapter: string;
  toolCalls: boolean;
  structuredOutput: boolean;
}): SmokeExecutionProfile {
  return {
    name: input.name,
    agentRole: input.agentRole,
    runnerKind: input.runnerKind,
    provider: input.provider,
    model: input.model,
    credentialRef: {
      kind: "alias",
      value: input.credentialAlias,
    },
    toolProfile: input.toolProfile,
    providerAdapter: input.providerAdapter,
    capabilities: {
      toolCalls: input.toolCalls,
      structuredOutput: input.structuredOutput,
    },
  };
}

function assertNoSecrets(payload: ModelAgnosticSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`Smoke harness payload contains secret-like text: ${leaked}`);
  }
}

export function buildModelAgnosticSmokeHarness(input: SmokeProviderInput = {}): ModelAgnosticSmokeResponse {
  const planning = profile({
    name: "planning-fixture-anthropic",
    agentRole: "planning",
    runnerKind: "llm_tool_runner",
    provider: clean(input.planningProvider, "anthropic"),
    model: clean(input.planningModel, "claude-sonnet-smoke"),
    credentialAlias: "planner_provider_primary",
    toolProfile: "planner_read_create_plan",
    providerAdapter: "anthropic_messages_adapter",
    toolCalls: true,
    structuredOutput: true,
  });

  const coding = profile({
    name: "coding-fixture-codex",
    agentRole: "coding",
    runnerKind: "codex",
    provider: clean(input.codingProvider, "openai_codex"),
    model: clean(input.codingModel, "gpt-5.2-smoke"),
    credentialAlias: "coding_provider_primary",
    toolProfile: "workspace_write_pr",
    providerAdapter: "codex_app_server_adapter",
    toolCalls: true,
    structuredOutput: false,
  });

  const planDraft = {
    id: "plan-smoke-model-agnostic",
    title: "Model-agnostic handoff smoke",
    intent: "Demonstrate a planner on provider A handing selected work to a coding agent on provider B.",
    createdByProfile: planning.name,
    tasks: [
      {
        id: "task-api-fixture",
        title: "Add fixture-backed API smoke path",
        instructions: "Use deterministic test data and avoid live provider calls.",
        selectedForCoding: true,
      },
      {
        id: "task-browser-fixture",
        title: "Expose browser-visible profile evidence",
        instructions: "Show provider, model, adapter, and handoff state without sensitive values.",
        selectedForCoding: true,
      },
    ],
  };
  const taskIds = planDraft.tasks.filter((task) => task.selectedForCoding).map((task) => task.id);
  const handoff = {
    planId: planDraft.id,
    taskIds,
    env: codingHandoffEnv({ planId: planDraft.id, taskIds }),
    receivedByProfile: coding.name,
  };

  const response = ModelAgnosticSmokeResponseSchema.parse({
    scenario: "planning-provider-a-to-coding-provider-b",
    liveProviderCalls: false,
    profiles: { planning, coding },
    planDraft,
    handoff,
    events: [
      {
        phase: "planning_profile_resolved",
        agentRole: "planning",
        executionProfile: planning.name,
        providerAdapter: planning.providerAdapter,
        message: `Planning profile resolved to ${planning.provider}/${planning.model}.`,
      },
      {
        phase: "plan_created",
        agentRole: "planning",
        executionProfile: planning.name,
        providerAdapter: planning.providerAdapter,
        message: `Plan draft ${planDraft.id} created by ${planning.providerAdapter}.`,
      },
      {
        phase: "tasks_approved",
        agentRole: "planning",
        executionProfile: planning.name,
        providerAdapter: planning.providerAdapter,
        message: `Approved ${taskIds.length} selected tasks for coding handoff.`,
      },
      {
        phase: "coding_profile_resolved",
        agentRole: "coding",
        executionProfile: coding.name,
        providerAdapter: coding.providerAdapter,
        message: `Coding profile resolved to ${coding.provider}/${coding.model}.`,
      },
      {
        phase: "handoff_received",
        agentRole: "coding",
        executionProfile: coding.name,
        providerAdapter: coding.providerAdapter,
        message: `Coding agent received handoff for ${handoff.taskIds.join(",")}.`,
      },
    ],
    logs: [
      `profile=${planning.name} provider_adapter=${planning.providerAdapter} provider=${planning.provider} model=${planning.model}`,
      `profile=${coding.name} provider_adapter=${coding.providerAdapter} provider=${coding.provider} model=${coding.model}`,
      `handoff plan_id=${handoff.planId} task_count=${handoff.taskIds.length} live_provider_calls=false`,
    ],
  });

  assertNoSecrets(response);
  return response;
}
