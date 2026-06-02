import type { PlanBody } from "../../../../contracts/plans.js";
import {
  PlanBodySchema,
  type PlanDraftFromPromptRequest,
  type PlanDraftFromPromptResponse,
} from "../../../../contracts/plans.js";
import { ApiRouteError } from "../http.js";
import { getDefaultAgentStatusForWorkspace, listSetupAuthState } from "./setup.js";
import { redactOutboundPromptForWorkspace } from "./prompt-redaction.js";
import { resolveRuntimeTargetForAgent } from "./runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "./upstream.js";

type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

type DraftPlanOptions = {
  accessToken: string;
  userId: string;
  request: PlanDraftFromPromptRequest;
  launcherRequest: LauncherRequest;
  requestTimeoutMs: number;
};

export type PlanValidationError = {
  path: string;
  message: string;
  code?: string;
};

export class PlanDraftValidationError extends Error {
  readonly errors: PlanValidationError[];

  constructor(errors: PlanValidationError[], message = "Planner produced an invalid plan draft") {
    super(message);
    this.name = "PlanDraftValidationError";
    this.errors = errors;
  }
}

function toValidationErrors(error: { issues: Array<{ path: PropertyKey[]; message: string; code: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/",
    message: issue.message,
    code: issue.code,
  }));
}

function extractRuntimeValidationErrors(body: unknown): PlanValidationError[] | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as { errors?: unknown; error?: { details?: unknown } };
  const errors = Array.isArray(candidate.errors)
    ? candidate.errors
    : Array.isArray(candidate.error?.details)
      ? candidate.error.details
      : null;
  if (!errors) return null;

  return errors.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return { path: "/", message: String(entry) };
    }
    const record = entry as Record<string, unknown>;
    return {
      path:
        typeof record.path === "string"
          ? record.path
          : typeof record.instancePath === "string"
            ? record.instancePath
            : "/",
      message: typeof record.message === "string" ? record.message : "Invalid plan draft",
      code:
        typeof record.code === "string" ? record.code : typeof record.keyword === "string" ? record.keyword : undefined,
    };
  });
}

function extractDraftPlan(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if ("draft" in record) return record.draft;
  if ("plan" in record) return record.plan;
  if (record.data && typeof record.data === "object" && "draft" in record.data) {
    return (record.data as Record<string, unknown>).draft;
  }
  if (record.data && typeof record.data === "object" && "plan" in record.data) {
    return (record.data as Record<string, unknown>).plan;
  }
  return body;
}

function validateDraftPlan(candidate: unknown): PlanBody {
  const parsed = PlanBodySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanDraftValidationError(toValidationErrors(parsed.error));
  }
  return parsed.data;
}

export async function createPlanDraftFromPrompt({
  accessToken,
  userId,
  request,
  launcherRequest,
  requestTimeoutMs,
}: DraftPlanOptions): Promise<PlanDraftFromPromptResponse> {
  const authState = await listSetupAuthState(accessToken, userId);
  const workspace = authState.workspaces.find((candidate) => candidate.id === request.workspaceId) ?? null;
  if (!workspace) {
    throw new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user");
  }

  const planningAgent = await getDefaultAgentStatusForWorkspace(accessToken, userId, request.workspaceId, "planning");
  if (!planningAgent?.agentId || !planningAgent.configured) {
    throw new ApiRouteError(409, "planning_agent_unconfigured", "A configured default planning agent is required", {
      missing: planningAgent?.missing ?? ["agent"],
    });
  }

  const planningAgentId = planningAgent.agentId;
  let redactedPrompt: string;
  try {
    redactedPrompt = (
      await redactOutboundPromptForWorkspace({
        prompt: request.prompt,
        planningAgentId,
        workspaceId: request.workspaceId,
        userId,
      })
    ).prompt;
  } catch (error) {
    throw new ApiRouteError(
      502,
      "credential_redaction_failed",
      "Could not prepare prompt for planner runtime",
      error instanceof Error ? error.message : String(error),
    );
  }

  const target = await resolveRuntimeTargetForAgent(planningAgentId, launcherRequest);
  const runtimeRequest = createUpstreamRequester(target.baseUrl, requestTimeoutMs);
  const response = await runtimeRequest("/api/v1/plans/draft-from-prompt", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      workspace_id: request.workspaceId,
      prompt: redactedPrompt,
      default_runner: request.defaultRunner,
      default_model: request.defaultModel,
      dry_run: true,
    }),
  });

  if (response.status === 422) {
    throw new PlanDraftValidationError(
      extractRuntimeValidationErrors(response.body) ?? [
        { path: "/", message: "Planner produced an invalid plan draft" },
      ],
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiRouteError(
      response.status >= 500 ? 502 : response.status,
      "planner_runtime_failed",
      "Planner runtime failed",
      {
        runtime_status: response.status,
        runtime_error: response.body,
      },
    );
  }

  return {
    draft: validateDraftPlan(extractDraftPlan(response.body)),
  };
}
