import { normalizeAgentType } from "../../../../../contracts/agents.js";
import type { SetupResponse } from "../../../../../contracts/setup.js";
import type { ensureDefaultWorkspace, getGatewayConfigState, getLatestEngine } from "./store.js";
import type { AgentRow, DefaultAgentStatus, GatewayConfigRow } from "./types.js";

export function mapSetupAgent(row: AgentRow): SetupResponse["agent"] {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    type: normalizeAgentType(row.type),
    modelSettings: row.model_settings,
    toolPolicy: row.tool_policy,
    createdByUserId: row.created_by_user_id,
    updatedAt: row.updated_at,
  };
}

export function mapSetupEngine(row: Awaited<ReturnType<typeof getLatestEngine>>): SetupResponse["engine"] {
  if (!row) return null;
  return {
    instanceId: row.instance_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    host: row.host,
    port: row.port,
    role: row.role,
    status: row.status,
    startedAt: row.started_at,
    lastHealthAt: row.last_health_at,
    updatedAt: row.updated_at,
    wsConnectionId: row.ws_connection_id,
  };
}

export function mapGatewayConfig(row: GatewayConfigRow | null): SetupResponse["gatewayConfig"] {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    version: row.version,
    configHash: row.config_hash,
    configJson: row.config_json,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function mapGatewayConfigState(
  row: Awaited<ReturnType<typeof getGatewayConfigState>>,
): SetupResponse["gatewayConfigState"] {
  if (!row) return null;
  return {
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    syncedAt: row.synced_at,
    lastAppliedHash: row.last_applied_hash,
    lastAppliedVersion: row.last_applied_version,
    lastApplyStatus: row.last_apply_status,
    lastApplyError: row.last_apply_error,
    lastApplyAt: row.last_apply_at,
    brokerInstanceId: row.broker_instance_id,
  };
}

export function mapDefaultAgentStatus(status: DefaultAgentStatus) {
  return {
    agentId: status.agentId,
    configured: status.configured,
    missing: status.missing,
    ...(status.checklist ? { checklist: status.checklist } : {}),
    ...(status.executionProfile ? { executionProfile: status.executionProfile } : {}),
  };
}

export function mapWorkspace(row: Awaited<ReturnType<typeof ensureDefaultWorkspace>>["workspaces"][number]) {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  };
}
