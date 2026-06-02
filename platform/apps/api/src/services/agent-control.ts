import {
  type AgentControlMessageKind,
  AgentControlMessageRowSchema,
  AgentControlMessageSchema,
  type AgentControlMessageRow,
  type AgentRemediationAction,
} from "../../../../contracts/agent-control.js";
import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";

type AgentIdentityRow = {
  id: string;
  workspace_id: string;
};

async function findAgentIdentity(agentId: string): Promise<AgentIdentityRow | null> {
  const rows = await executeSupabaseRows<AgentIdentityRow>(
    "agent query",
    getServiceRoleSupabase().from("agent").select("id,workspace_id").eq("id", agentId).limit(1),
  );

  const row = rows[0];
  if (!row?.id || !row.workspace_id) return null;

  return {
    id: row.id,
    workspace_id: row.workspace_id,
  };
}

export async function assertAgentControlAccess(input: {
  userId: string;
  workspaceId: string;
  targetAgentId: string;
  observerAgentId: string;
}) {
  await assertWorkspaceMembership(input.userId, input.workspaceId);

  const [target, observer] = await Promise.all([
    findAgentIdentity(input.targetAgentId),
    findAgentIdentity(input.observerAgentId),
  ]);

  if (!target || target.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Target agent was not found in the requested workspace");
  }

  if (!observer || observer.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(404, "observer_agent_not_found", "Observer agent was not found in the requested workspace");
  }
}

export async function createAgentControlMessage(_input: {
  workspaceId: string;
  targetAgentId: string;
  observerAgentId: string;
  kind: AgentControlMessageKind;
  subject: string | null;
  body: string | null;
  metadata: Record<string, unknown>;
  status?: string;
  dispatchStatus?: string | null;
  createdByUserId: string;
}): Promise<AgentControlMessageRow> {
  throw new Error("Agent control messages are not available in the generated Supabase schema");
}

export async function createAgentRemediation(_input: {
  workspaceId: string;
  targetAgentId: string;
  observerAgentId: string;
  action: AgentRemediationAction;
  reason: string | null;
  metadata: Record<string, unknown>;
  status?: string;
  dispatchStatus?: string | null;
  createdByUserId: string;
}): Promise<AgentControlMessageRow> {
  throw new Error("Agent control messages are not available in the generated Supabase schema");
}

export async function updateAgentControlMessageDispatchStatus(_input: {
  messageId: string;
  dispatchStatus: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentControlMessageRow | null> {
  return null;
}

export function mapAgentControlMessage(row: unknown) {
  const parsed = AgentControlMessageRowSchema.parse(row);
  return AgentControlMessageSchema.parse({
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    targetAgentId: parsed.target_agent_id,
    observerAgentId: parsed.observer_agent_id,
    kind: parsed.kind,
    action: parsed.action,
    subject: parsed.subject,
    body: parsed.body,
    metadata: parsed.metadata,
    status: parsed.status,
    dispatchStatus: parsed.dispatch_status,
    createdByUserId: parsed.created_by_user_id,
    createdAt: parsed.created_at,
  });
}

export function logAgentRemediationRequested(input: {
  workspaceId: string;
  targetAgentId: string;
  observerAgentId: string;
  action: AgentRemediationAction;
  remediationId?: string;
  dispatchStatus?: string | null;
}) {
  process.stdout.write(
    `${JSON.stringify({
      event: "manager_remediation_requested",
      workspace_id: input.workspaceId,
      target_agent_id: input.targetAgentId,
      observer_agent_id: input.observerAgentId,
      action: input.action,
      remediation_id: input.remediationId ?? null,
      dispatch_status: input.dispatchStatus ?? null,
    })}\n`,
  );
}
