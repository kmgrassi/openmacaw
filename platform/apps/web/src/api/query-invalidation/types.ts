import type { QueryKey } from "@tanstack/react-query";

export type QueryFamilyKey = QueryKey;

export type QueryInvalidationScope = {
  workspaceId?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  planId?: string | null;
  workItemId?: string | null;
};

export type QueryInvalidationReason =
  | "auth"
  | "agent"
  | "setup"
  | "health"
  | "dashboard"
  | "message"
  | "session"
  | "tool"
  | "local_runtime"
  | "plan"
  | "work_item"
  | "manager"
  | "scheduled_task"
  | "credential"
  | "model_catalog"
  | "runtime_diagnostic";

export type QueryInvalidationTarget = {
  key: QueryKey;
  exact?: boolean;
};
