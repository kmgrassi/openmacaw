import {
  WorkerBridgeSessionListResponseSchema,
  WorkerBridgeSessionResponseSchema,
  type WorkerBridgeSession,
} from "../../../../contracts/worker-bridge";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type WorkerCredentialSpec =
  | string
  | {
      source: "inline" | "env";
      value?: string;
      name?: string;
    };

export type { WorkerBridgeSession } from "../../../../contracts/worker-bridge";

export type StartWorkerBridgeSessionParams = {
  kind: "codex";
  cwd: string;
  env?: Record<string, string>;
  credentials: Record<string, WorkerCredentialSpec>;
};

export async function startWorkerBridgeSession(
  params: StartWorkerBridgeSessionParams,
): Promise<WorkerBridgeSession> {
  const body = await apiFetch(ROUTES.workerBridgeSessions, {
    method: "POST",
    body: params,
    schema: WorkerBridgeSessionResponseSchema,
    defaultErrorMessage: (status) => `worker bridge request failed (${status})`,
  });

  if (!body.data?.id) {
    throw new Error("Worker bridge session creation returned no session ID");
  }

  return body.data;
}

export async function listWorkerBridgeSessions(): Promise<WorkerBridgeSession[]> {
  const body = await apiFetch(ROUTES.workerBridgeSessions, {
    method: "GET",
    schema: WorkerBridgeSessionListResponseSchema,
    defaultErrorMessage: (status) => `worker bridge request failed (${status})`,
  });
  return body.data ?? [];
}

export async function getWorkerBridgeSession(id: string): Promise<WorkerBridgeSession> {
  const body = await apiFetch(ROUTES.workerBridgeSession(id), {
    method: "GET",
    schema: WorkerBridgeSessionResponseSchema,
    defaultErrorMessage: (status) => `worker bridge request failed (${status})`,
  });

  if (!body.data?.id) {
    throw new Error("Worker bridge session lookup returned no session");
  }

  return body.data;
}

export async function stopWorkerBridgeSession(id: string): Promise<WorkerBridgeSession | null> {
  const body = await apiFetch(ROUTES.workerBridgeSession(id), {
    method: "DELETE",
    schema: WorkerBridgeSessionResponseSchema,
    defaultErrorMessage: (status) => `worker bridge request failed (${status})`,
  });
  return body.data ?? null;
}
