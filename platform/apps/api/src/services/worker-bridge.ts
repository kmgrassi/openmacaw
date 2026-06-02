import type { WorkerBridgeSessionRow } from "../../../../contracts/worker-bridge.js";
import {
  WorkerBridgeSessionListResponseSchema,
  WorkerBridgeSessionResponseSchema,
} from "../../../../contracts/worker-bridge.js";

export function mapWorkerBridgeSession(row: WorkerBridgeSessionRow) {
  return {
    id: row.id,
    kind: row.kind,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    exitStatus: row.exit_status,
    envKeys: row.env_keys,
    credentialKeys: row.credential_keys,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    credentialId: row.credential_id,
  };
}

export function mapWorkerBridgeSessionResponse(body: { data?: WorkerBridgeSessionRow }) {
  return WorkerBridgeSessionResponseSchema.parse({
    data: body.data ? mapWorkerBridgeSession(body.data) : undefined,
  });
}

export function mapWorkerBridgeSessionListResponse(body: { data?: WorkerBridgeSessionRow[] }) {
  return WorkerBridgeSessionListResponseSchema.parse({
    data: body.data?.map(mapWorkerBridgeSession),
  });
}
