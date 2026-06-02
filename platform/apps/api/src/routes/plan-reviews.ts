import type { Express, Request, Response } from "express";

import { PlanReviewListResponseSchema, type PlannerEvidence } from "../../../../contracts/plans.js";
import { errorPayload, requireRouteParam } from "../http.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isWorkspaceAuthorizationError(error: unknown) {
  return error instanceof Error && error.message.includes("not authorized");
}

function evidenceFromEntry(entry: unknown): PlannerEvidence | null {
  if (typeof entry === "string" && entry.trim()) {
    return { path: entry.trim(), line: null, snippet: null, label: null };
  }

  const record = asRecord(entry);
  if (!record) return null;

  const pathValue = record.path ?? record.file ?? record.file_path ?? record.filename;
  const path = typeof pathValue === "string" ? pathValue.trim() : "";
  if (!path) return null;

  const lineValue = record.line ?? record.line_number ?? record.start_line;
  const line = typeof lineValue === "number" && Number.isFinite(lineValue) ? lineValue : null;
  const snippetValue = record.snippet ?? record.excerpt ?? record.text;
  const labelValue = record.label ?? record.reason ?? record.symbol;

  return {
    path,
    line,
    snippet: typeof snippetValue === "string" && snippetValue.trim() ? snippetValue.trim() : null,
    label: typeof labelValue === "string" && labelValue.trim() ? labelValue.trim() : null,
  };
}

function extractEvidence(metadata: unknown): PlannerEvidence[] {
  const record = asRecord(metadata);
  if (!record) return [];

  const candidates = [
    record.evidence,
    record.planner_evidence,
    record.repo_evidence,
    record.evidence_files,
    record.files,
  ];

  const evidence = candidates.flatMap((candidate) => {
    if (Array.isArray(candidate))
      return candidate.map(evidenceFromEntry).filter((item): item is PlannerEvidence => Boolean(item));
    const single = evidenceFromEntry(candidate);
    return single ? [single] : [];
  });

  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.path}:${item.line ?? ""}:${item.snippet ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerPlanReviewRoutes(app: Express) {
  app.get("/api/workspaces/:workspaceId/plan-reviews", async (req: Request, res: Response) => {
    if (!req.userId) {
      return res.status(401).json(errorPayload("auth_required", "Authenticated app user is required"));
    }

    try {
      const workspaceId = requireRouteParam(req, "workspaceId");
      await assertWorkspaceMembership(req.userId, workspaceId);

      const { data: workItemRows, error: workItemError } = await getServiceRoleSupabase()
        .from("work_items")
        .select("id,workspace_id,plan_id,title,description,state,priority,labels,metadata,created_at,updated_at")
        .eq("workspace_id", workspaceId)
        .not("plan_id", "is", null)
        .order("updated_at", { ascending: false })
        .limit(80);
      if (workItemError) throw normalizeSupabaseError("work_items query", workItemError);

      const tasks = (workItemRows ?? []).map((workItem) => ({
        id: workItem.id,
        workspaceId: workItem.workspace_id ?? workspaceId,
        planId: workItem.plan_id,
        name: workItem.title,
        description: workItem.description,
        state: workItem.state,
        priority: workItem.priority,
        labels: workItem.labels,
        metadata: workItem.metadata,
        createdAt: workItem.created_at,
        updatedAt: workItem.updated_at,
        evidence: extractEvidence(workItem.metadata),
      }));
      const planIds = Array.from(new Set(tasks.map((task) => task.planId).filter((id): id is string => Boolean(id))));
      if (planIds.length === 0) {
        return res.status(200).json(PlanReviewListResponseSchema.parse({ plans: [] }));
      }

      const { data: planRows, error: planError } = await getServiceRoleSupabase()
        .from("plan")
        .select("id,name,description,status,type,created_at,updated_at")
        .in("id", planIds);
      if (planError) throw normalizeSupabaseError("plan query", planError);

      const tasksByPlanId = tasks.reduce<Record<string, typeof tasks>>((acc, task) => {
        if (!task.planId) return acc;
        acc[task.planId] = [...(acc[task.planId] ?? []), task];
        return acc;
      }, {});

      const plans = (planRows ?? [])
        .map((plan) => {
          const planTasks = tasksByPlanId[plan.id] ?? [];
          return {
            id: plan.id,
            name: plan.name,
            description: plan.description,
            status: plan.status,
            type: plan.type,
            createdAt: plan.created_at,
            updatedAt: plan.updated_at,
            tasks: planTasks,
            evidence: planTasks.flatMap((task) => task.evidence).slice(0, 12),
          };
        })
        .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));

      return res.status(200).json(PlanReviewListResponseSchema.parse({ plans }));
    } catch (error) {
      if (isWorkspaceAuthorizationError(error)) {
        return res
          .status(403)
          .json(errorPayload("workspace_forbidden", "Authenticated user is not authorized for this workspace"));
      }
      return res.status(502).json(errorPayload("plan_reviews_failed", "Could not read plan reviews", String(error)));
    }
  });
}
