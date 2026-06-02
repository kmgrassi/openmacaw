import type { PlanReviewPlan, PlanReviewTask, PlannerEvidence } from "../../../../contracts/plans.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

type WorkItemPlanReviewRow = {
  id: string;
  workspace_id: string | null;
  plan_id: string | null;
  title: string | null;
  description: string | null;
  state: string;
  priority: string | null;
  labels: string[];
  metadata: unknown;
  created_at: string;
  updated_at: string;
};
type PlanReviewDbPlanRow = {
  id: string;
  name: string | null;
  description: string | null;
  status: string;
  type: string | null;
  created_at: string;
  updated_at: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

export function extractPlannerEvidence(metadata: unknown): PlannerEvidence[] {
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
    if (Array.isArray(candidate)) {
      return candidate.map(evidenceFromEntry).filter((item): item is PlannerEvidence => Boolean(item));
    }
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

export async function fetchPlanReviewsForWorkspace(workspaceId: string): Promise<PlanReviewPlan[]> {
  const { data: workItemRows, error: workItemError } = await getServiceRoleSupabase()
    .from("work_items")
    .select("id,workspace_id,plan_id,title,description,state,priority,labels,metadata,created_at,updated_at")
    .eq("workspace_id", workspaceId)
    .not("plan_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(80);
  if (workItemError) throw normalizeSupabaseError("work_items query", workItemError);

  const tasks: PlanReviewTask[] = ((workItemRows ?? []) as WorkItemPlanReviewRow[]).map((workItem) => ({
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
    evidence: extractPlannerEvidence(workItem.metadata),
  }));
  const planIds = Array.from(new Set(tasks.map((task) => task.planId).filter((id): id is string => Boolean(id))));
  if (planIds.length === 0) return [];

  const { data: planRows, error: planError } = await getServiceRoleSupabase()
    .from("plan")
    .select("id,name,description,status,type,created_at,updated_at")
    .in("id", planIds);
  if (planError) throw normalizeSupabaseError("plan query", planError);

  const tasksByPlanId = tasks.reduce<Record<string, PlanReviewTask[]>>((acc, task) => {
    if (!task.planId) return acc;
    acc[task.planId] = [...(acc[task.planId] ?? []), task];
    return acc;
  }, {});

  return ((planRows ?? []) as PlanReviewDbPlanRow[])
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
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
