import { z } from "zod";

export const WorkerBridgeSessionRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  status: z.string(),
  started_at: z.string(),
  stopped_at: z.string().nullable(),
  exit_status: z.number().nullable(),
  env_keys: z.array(z.string()),
  credential_keys: z.array(z.string()),
  agent_id: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
  credential_id: z.string().nullable().optional(),
});

export const WorkerBridgeSessionRowResponseSchema = z.object({
  data: WorkerBridgeSessionRowSchema.optional(),
});

export const WorkerBridgeSessionRowListResponseSchema = z.object({
  data: z.array(WorkerBridgeSessionRowSchema).optional(),
});

export const WorkerBridgeSessionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  status: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().nullable(),
  exitStatus: z.number().nullable(),
  envKeys: z.array(z.string()),
  credentialKeys: z.array(z.string()),
  agentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  credentialId: z.string().nullable().optional(),
});

export const WorkerBridgeSessionResponseSchema = z.object({
  data: WorkerBridgeSessionSchema.optional(),
});

export const WorkerBridgeSessionListResponseSchema = z.object({
  data: z.array(WorkerBridgeSessionSchema).optional(),
});

export type WorkerBridgeSessionRow = z.infer<typeof WorkerBridgeSessionRowSchema>;
export type WorkerBridgeSessionRowResponse = z.infer<typeof WorkerBridgeSessionRowResponseSchema>;
export type WorkerBridgeSessionRowListResponse = z.infer<typeof WorkerBridgeSessionRowListResponseSchema>;
export type WorkerBridgeSession = z.infer<typeof WorkerBridgeSessionSchema>;
export type WorkerBridgeSessionResponse = z.infer<typeof WorkerBridgeSessionResponseSchema>;
export type WorkerBridgeSessionListResponse = z.infer<typeof WorkerBridgeSessionListResponseSchema>;
