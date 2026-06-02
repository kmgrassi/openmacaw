import type { Json, Tables } from "@kmgrassi/supabase-schema";
import type { WorkItemSource } from "../../../../../contracts/work-items.js";

export type JsonObject = { [key: string]: Json | undefined };
export type WorkItemRow = Tables<"work_items">;

export type WorkspaceRoutingConfig = {
  defaultWorkspaceId: string | null;
  githubRepoWorkspaceMap: Record<string, string>;
  linearProjectWorkspaceMap: Record<string, string>;
  linearTeamWorkspaceMap: Record<string, string>;
};

export type NormalizedWorkItemInput = {
  workspaceId: string;
  source: WorkItemSource;
  externalId: string;
  title: string;
  description: string | null;
  state: string;
  priority: string | null;
  labels: string[];
  metadata: JsonObject;
  planId?: string | null;
};

export type GitHubWebhookEnvelope = {
  eventName: string;
  deliveryId: string | null;
  action: string | null;
  payload: Record<string, unknown>;
};

export type LinearWebhookEnvelope = {
  eventName: string;
  deliveryId: string | null;
  payload: Record<string, unknown>;
};

export type PersistedWorkItem = {
  workItem: WorkItemRow | null;
};
