import { randomUUID } from "node:crypto";

import type {
  GitHubWebhookEnvelope,
  LinearWebhookEnvelope,
  NormalizedWorkItemInput,
  WorkspaceRoutingConfig,
} from "./types.js";
import {
  asRecord,
  asString,
  asStringArray,
  ensureWorkspaceId,
  normalizePriority,
  normalizeState,
  toJsonObject,
} from "./validation.js";

function githubStateFromPayload(action: string | null, item: Record<string, unknown>): string {
  const state = asString(item.state)?.toLowerCase();
  const isPullRequest = Boolean(asRecord(item.pull_request) || asString(item.html_url)?.includes("/pull/"));
  const merged = item.merged === true;

  if (action === "closed") {
    if (isPullRequest && !merged) return "cancelled";
    return "done";
  }
  if (action === "reopened") return "todo";
  if (state === "closed") {
    if (!isPullRequest) return "done";
    return merged ? "done" : "cancelled";
  }
  return "todo";
}

function linearStateFromPayload(issue: Record<string, unknown>, action: string | null): string {
  if (action === "remove") return "cancelled";

  const stateRecord = asRecord(issue.state);
  const stateType = asString(stateRecord?.type);
  const stateName = asString(stateRecord?.name);
  return normalizeState(stateType ?? stateName ?? null);
}

function linearLabelsFromPayload(issue: Record<string, unknown>): string[] {
  const labelContainers = [issue.labels, asRecord(issue.labels)?.nodes, asRecord(issue.labelIds)];

  for (const value of labelContainers) {
    const labels = asStringArray(value);
    if (labels.length > 0) return labels;
  }

  return [];
}

export function normalizeManualWorkItem(input: {
  workspaceId: string;
  title: string;
  description?: string | null;
  planId?: string | null;
  priority?: string | null;
  labels?: string[];
  metadata?: Record<string, unknown>;
  state?: string;
}): NormalizedWorkItemInput {
  return {
    workspaceId: input.workspaceId,
    source: "api",
    externalId: `api:${randomUUID()}`,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    state: normalizeState(input.state ?? "todo"),
    priority: normalizePriority(input.priority),
    labels: (input.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0),
    metadata: toJsonObject({
      ...(input.metadata ?? {}),
      created_via: "api",
    }),
    planId: input.planId?.trim() || null,
  };
}

export function normalizeGitHubWebhook(
  envelope: GitHubWebhookEnvelope,
  routing: WorkspaceRoutingConfig,
): NormalizedWorkItemInput | null {
  if (!["issues", "pull_request"].includes(envelope.eventName)) {
    return null;
  }

  const payload = envelope.payload;
  const repository = asRecord(payload.repository);
  const item = asRecord(envelope.eventName === "issues" ? payload.issue : payload.pull_request);

  if (!repository || !item) {
    return null;
  }

  const repoFullName =
    asString(repository.full_name) ??
    [asString(asRecord(repository.owner)?.login), asString(repository.name)].filter(Boolean).join("/");
  const number = typeof item.number === "number" ? item.number : null;
  const title = asString(item.title);
  if (!repoFullName || number === null || !title) {
    return null;
  }

  const workspaceId = ensureWorkspaceId(
    routing.githubRepoWorkspaceMap[repoFullName] ?? routing.defaultWorkspaceId,
    `GitHub repository ${repoFullName}`,
  );
  const labels = asStringArray(item.labels);
  const url = asString(item.html_url);
  const itemKind = envelope.eventName === "issues" ? "issue" : "pull_request";

  return {
    workspaceId,
    source: "github",
    externalId: `${repoFullName}:${itemKind}:${number}`,
    title,
    description: asString(item.body),
    state: githubStateFromPayload(envelope.action, item),
    priority: null,
    labels,
    metadata: toJsonObject({
      action: envelope.action,
      delivery_id: envelope.deliveryId,
      event_name: envelope.eventName,
      item_kind: itemKind,
      number,
      repo: repoFullName,
      url,
      github_id: asString(item.node_id) ?? asString(item.id),
      repository_url: asString(repository.html_url),
      draft: item.draft === true ? true : undefined,
      merged: item.merged === true ? true : undefined,
      state: asString(item.state),
    }),
  };
}

export function normalizeLinearWebhook(
  envelope: LinearWebhookEnvelope,
  routing: WorkspaceRoutingConfig,
): NormalizedWorkItemInput | null {
  const action = asString(envelope.payload.action);
  const type = asString(envelope.payload.type);
  const issue = asRecord(envelope.payload.data);

  if (type !== "Issue" || !issue) {
    return null;
  }

  const issueId = asString(issue.id);
  const title = asString(issue.title);
  if (!issueId || !title) {
    return null;
  }

  const project = asRecord(issue.project);
  const team = asRecord(issue.team);
  const projectId = asString(project?.id);
  const teamId = asString(team?.id);
  const workspaceId = ensureWorkspaceId(
    (projectId ? routing.linearProjectWorkspaceMap[projectId] : null) ??
      (teamId ? routing.linearTeamWorkspaceMap[teamId] : null) ??
      routing.defaultWorkspaceId,
    `Linear issue ${issueId}`,
  );

  return {
    workspaceId,
    source: "linear",
    externalId: `issue:${issueId}`,
    title,
    description: asString(issue.description),
    state: linearStateFromPayload(issue, action),
    priority: normalizePriority(issue.priorityLabel ?? issue.priority),
    labels: linearLabelsFromPayload(issue),
    metadata: toJsonObject({
      action,
      delivery_id: envelope.deliveryId,
      event_name: envelope.eventName,
      identifier: asString(issue.identifier),
      issue_id: issueId,
      project_id: asString(project?.id),
      project_name: asString(project?.name),
      team_id: asString(team?.id),
      team_key: asString(team?.key),
      team_name: asString(team?.name),
      url: asString(envelope.payload.url) ?? asString(issue.url),
    }),
  };
}
