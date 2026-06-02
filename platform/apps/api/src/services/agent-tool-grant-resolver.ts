import type { Json } from "@kmgrassi/supabase-schema";

import { normalizeSupabaseError, type ApiSupabaseClient } from "../supabase-client.js";

export type AgentToolGrantMode = "include" | "exclude";
export type AgentToolGrantSource = "template" | "manual" | "system" | "migration";

export type GrantResolverToolRow = {
  id: string;
  workspace_id: string | null;
  slug: string | null;
  name: string | null;
  description: string | null;
  parameters: Json | null;
  examples: Json | null;
  function_name: string | null;
  type?: string | null;
  execution_kind: string | null;
  runner_kind: string | null;
  enabled: boolean;
  created_by_user_id?: string | null;
};

export type AgentToolGrantRow = {
  id: string;
  agent_id: string;
  tool_id: string;
  workspace_id: string;
  mode: AgentToolGrantMode;
  source: AgentToolGrantSource;
  source_tool_template_id: string | null;
  reason: string | null;
  created_by_user_id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ResolvedAgentToolGrant = {
  tool: GrantResolverToolRow;
  grant: AgentToolGrantRow;
  enabledForAgent: boolean;
};

export type AgentToolGrantResolution = {
  availableTools: GrantResolverToolRow[];
  grants: AgentToolGrantRow[];
  resolvedTools: ResolvedAgentToolGrant[];
};

const TOOL_SELECT =
  "id,workspace_id,slug,name,description,parameters,examples,function_name,type,execution_kind,runner_kind,enabled,created_by_user_id" as const;
const AGENT_TOOL_GRANT_SELECT =
  "id,agent_id,tool_id,workspace_id,mode,source,source_tool_template_id,reason,created_by_user_id,created_at,updated_at" as const;

type ResolverQuery<Row> = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  is(column: string, value: unknown): ResolverQuery<Row>;
  eq(column: string, value: unknown): ResolverQuery<Row>;
};

function table<Row>(supabase: ApiSupabaseClient, name: string) {
  return supabase.from(name as never) as unknown as {
    select(columns?: string): ResolverQuery<Row>;
  };
}

function sortToolRows<Row extends { slug: string | null; name: string | null }>(rows: Row[]) {
  return [...rows].sort(
    (left, right) =>
      (left.slug ?? "").localeCompare(right.slug ?? "") || (left.name ?? "").localeCompare(right.name ?? ""),
  );
}

async function listVisibleToolRows(input: { workspaceId: string; supabase: ApiSupabaseClient }) {
  const [globalResult, workspaceResult] = await Promise.all([
    table<GrantResolverToolRow>(input.supabase, "tool").select(TOOL_SELECT).is("workspace_id", null),
    table<GrantResolverToolRow>(input.supabase, "tool").select(TOOL_SELECT).eq("workspace_id", input.workspaceId),
  ]);

  if (globalResult.error) throw normalizeSupabaseError("tool query", globalResult.error as never);
  if (workspaceResult.error) throw normalizeSupabaseError("tool query", workspaceResult.error as never);

  return sortToolRows(
    Array.from(
      new Map(
        [...(globalResult.data ?? []), ...(workspaceResult.data ?? [])]
          .filter((tool) => tool.enabled)
          .map((tool) => [tool.id, tool]),
      ).values(),
    ),
  );
}

async function listAgentToolGrants(input: { agentId: string; workspaceId: string; supabase: ApiSupabaseClient }) {
  const result = await table<AgentToolGrantRow>(input.supabase, "agent_tool_grant")
    .select(AGENT_TOOL_GRANT_SELECT)
    .eq("agent_id", input.agentId)
    .eq("workspace_id", input.workspaceId);
  if (result.error) throw normalizeSupabaseError("agent_tool_grant query", result.error as never);
  return result.data ?? [];
}

function isEnabledGrant(grant: AgentToolGrantRow) {
  return grant.mode === "include";
}

export async function resolveAgentToolGrants(input: {
  agentId: string;
  workspaceId: string;
  supabase: ApiSupabaseClient;
}): Promise<AgentToolGrantResolution> {
  const [availableTools, grants] = await Promise.all([
    listVisibleToolRows({ workspaceId: input.workspaceId, supabase: input.supabase }),
    listAgentToolGrants({ agentId: input.agentId, workspaceId: input.workspaceId, supabase: input.supabase }),
  ]);

  const toolsById = new Map(availableTools.map((tool) => [tool.id, tool]));
  const resolvedTools = grants
    .map((grant) => {
      const tool = toolsById.get(grant.tool_id);
      if (!tool) return null;
      return {
        tool,
        grant,
        enabledForAgent: isEnabledGrant(grant),
      };
    })
    .filter((resolution): resolution is ResolvedAgentToolGrant => resolution !== null)
    .sort(
      (left, right) =>
        (left.tool.slug ?? "").localeCompare(right.tool.slug ?? "") ||
        (left.tool.name ?? "").localeCompare(right.tool.name ?? ""),
    );

  return {
    availableTools,
    grants,
    resolvedTools,
  };
}
