import { z } from "zod";

import type { ProviderFailure, ProviderFailureSummaryEntry } from "../../../../contracts/provider-failures.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";

const PROVIDER_FAILURE_SELECT =
  "id,created_at,workspace_id,agent_id,work_item_id,run_id,runner_kind,provider,model,error_code,status_code,attempt" as const;
type SupabaseError = Parameters<typeof normalizeSupabaseError>[1];

const ProviderFailureRowSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  workspace_id: z.string(),
  agent_id: z.string().nullable(),
  work_item_id: z.string().nullable(),
  run_id: z.string().nullable(),
  runner_kind: z.string(),
  provider: z.string(),
  model: z.string(),
  error_code: z.string(),
  status_code: z.number().int().nullable(),
  attempt: z.number().int(),
});

type ProviderFailureRow = z.infer<typeof ProviderFailureRowSchema>;

type ProviderFailureTableClient = {
  from(table: "provider_failure"): {
    select(columns: string): ProviderFailureQueryBuilder;
  };
};

type ProviderFailureQueryBuilder = {
  eq(column: string, value: unknown): ProviderFailureQueryBuilder;
  gte(column: string, value: unknown): ProviderFailureQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): ProviderFailureQueryBuilder;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
};

function providerFailureTable() {
  return (getServiceRoleSupabase() as unknown as ProviderFailureTableClient).from("provider_failure");
}

function mapProviderFailureRow(row: ProviderFailureRow): ProviderFailure {
  return {
    id: row.id,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    runnerKind: row.runner_kind,
    provider: row.provider,
    model: row.model,
    errorCode: row.error_code,
    statusCode: row.status_code,
    attempt: row.attempt,
  } as ProviderFailure;
}

function parseRows(context: string, data: unknown): ProviderFailure[] {
  const rows = ProviderFailureRowSchema.array().parse(Array.isArray(data) ? data : []);
  return rows.map(mapProviderFailureRow);
}

function pageOffset(cursor?: string | null): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function listRecentProviderFailures(input: {
  workspaceId: string;
  limit: number;
  cursor?: string | null;
}): Promise<{ items: ProviderFailure[]; nextCursor: string | null }> {
  return withRepositoryLogging(
    {
      repository: "provider_failures",
      method: "listRecentProviderFailures",
      table: "provider_failure",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      const offset = pageOffset(input.cursor);
      const { data, error } = await providerFailureTable()
        .select(PROVIDER_FAILURE_SELECT)
        .eq("workspace_id", input.workspaceId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit);

      if (error) throw normalizeSupabaseError("provider_failure recent query", error as SupabaseError);
      const rows = parseRows("provider_failure recent query", data);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? String(offset + limit) : null,
      };
    },
  );
}

export async function summarizeProviderFailures(input: {
  workspaceId: string;
  since: string;
}): Promise<ProviderFailureSummaryEntry[]> {
  return withRepositoryLogging(
    {
      repository: "provider_failures",
      method: "summarizeProviderFailures",
      table: "provider_failure",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await providerFailureTable()
        .select(PROVIDER_FAILURE_SELECT)
        .eq("workspace_id", input.workspaceId)
        .gte("created_at", input.since)
        .order("created_at", { ascending: false })
        .range(0, 999);

      if (error) throw normalizeSupabaseError("provider_failure summary query", error as SupabaseError);
      const rows = parseRows("provider_failure summary query", data);
      const groups = new Map<string, ProviderFailureSummaryEntry>();

      for (const row of rows) {
        const key = `${row.provider}\u0000${row.model}\u0000${row.errorCode}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count += 1;
          continue;
        }
        groups.set(key, {
          provider: row.provider,
          model: row.model,
          errorCode: row.errorCode,
          count: 1,
        } as ProviderFailureSummaryEntry);
      }

      return Array.from(groups.values()).sort((left, right) => right.count - left.count);
    },
  );
}
