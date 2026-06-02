import type { Tables } from "@kmgrassi/supabase-schema";
import type { AgentToolCallEvent } from "../../../../contracts/agent-dashboard.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

export const RUN_HISTORY_PAGE_SIZE = 8;
export const DASHBOARD_VERSION_POLL_MS = 5_000;
const DASHBOARD_VERSION_RUN_LIMIT = 25;

export type BrokerRunRow = Pick<
  Tables<"broker_run">,
  | "run_id"
  | "agent_id"
  | "attempt"
  | "created_at"
  | "started_at"
  | "completed_at"
  | "status"
  | "error"
  | "terminal_reason"
  | "tracker_kind"
  | "tracker_issue_key"
  | "issue_identifier"
  | "issue_state"
  | "updated_at"
>;

export type BrokerTaskRow = Pick<
  Tables<"broker_task">,
  | "task_id"
  | "run_id"
  | "attempt"
  | "status"
  | "type"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "last_event"
  | "last_event_at"
  | "error"
  | "updated_at"
> & { tool_events?: AgentToolCallEventRow[] };

export type GatewayConfigStateRow = Pick<
  Tables<"gateway_config_state">,
  | "scope_type"
  | "scope_id"
  | "sync_status"
  | "sync_error"
  | "last_apply_status"
  | "last_apply_error"
  | "last_apply_at"
  | "last_applied_version"
>;

export type BrokerRunVersionRow = Pick<Tables<"broker_run">, "run_id" | "created_at" | "updated_at">;
export type BrokerTaskVersionRow = Pick<Tables<"broker_task">, "task_id" | "last_event_at" | "updated_at">;
export type GatewayConfigVersionRow = GatewayConfigStateRow & Pick<Tables<"gateway_config_state">, "synced_at">;
export type AgentToolCallEventVersionRow = Pick<AgentToolCallEventRow, "id" | "updated_at" | "created_at">;
export type VisibleBrokerRunRow = Pick<Tables<"broker_run">, "run_id" | "agent_id" | "workspace_id">;

export type AgentToolCallEventRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  run_id: string;
  task_id: string | null;
  tool_call_id: string | null;
  correlation_id: string | null;
  sequence: number;
  event_type: string;
  message_kind: AgentToolCallEvent["messageKind"];
  tool_slug: string;
  status: AgentToolCallEvent["status"];
  approval_state: AgentToolCallEvent["approvalState"];
  command_actions: AgentToolCallEvent["commandActions"];
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  output_summary: string | null;
  patch_summary: string | null;
  file_changes: Array<Record<string, unknown>>;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

const BROKER_RUN_SELECT =
  "run_id,agent_id,attempt,created_at,started_at,completed_at,status,error,terminal_reason,tracker_kind,tracker_issue_key,issue_identifier,issue_state,updated_at" as const;
const BROKER_TASK_SELECT =
  "task_id,run_id,attempt,status,type,input_tokens,output_tokens,total_tokens,last_event,last_event_at,error,updated_at" as const;
const GATEWAY_CONFIG_STATE_SELECT =
  "scope_type,scope_id,sync_status,sync_error,last_apply_status,last_apply_error,last_apply_at,last_applied_version" as const;
export const AGENT_TOOL_CALL_EVENT_SELECT =
  "id,workspace_id,agent_id,run_id,task_id,tool_call_id,correlation_id,sequence,event_type,message_kind,tool_slug,status,approval_state,command_actions,arguments,result,output_summary,patch_summary,file_changes,error_code,error_message,started_at,completed_at,duration_ms,created_at,updated_at" as const;

export async function getLatestBrokerRunRow(agentId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_run")
    .select(BROKER_RUN_SELECT)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw normalizeSupabaseError("broker_run query", error);
  return ((data ?? [])[0] as BrokerRunRow | undefined) ?? null;
}

export async function getBrokerRunHistoryRows(input: { agentId: string; offset: number }) {
  const { data, error, count } = await getServiceRoleSupabase()
    .from("broker_run")
    .select(BROKER_RUN_SELECT, { count: "exact" })
    .eq("agent_id", input.agentId)
    .order("created_at", { ascending: false })
    .range(input.offset, input.offset + RUN_HISTORY_PAGE_SIZE - 1);
  if (error) throw normalizeSupabaseError("broker_run query", error);

  return {
    rows: (data ?? []) as BrokerRunRow[],
    total: count ?? 0,
  };
}

export async function getVisibleBrokerRunIds(agentId: string, runIds: string[]) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_run")
    .select("run_id,agent_id")
    .eq("agent_id", agentId)
    .in("run_id", runIds);
  if (error) throw normalizeSupabaseError("broker_run query", error);

  return new Set(data.map((run) => run.run_id));
}

export async function getBrokerTaskRows(runIds: string[]) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_task")
    .select(BROKER_TASK_SELECT)
    .in("run_id", runIds)
    .order("created_at", { ascending: false });
  if (error) throw normalizeSupabaseError("broker_task query", error);

  return (data ?? []) as BrokerTaskRow[];
}

export async function getToolEventsByTaskId(runIds: string[]) {
  if (runIds.length === 0) return new Map<string, AgentToolCallEventRow[]>();

  const { data, error } = await getServiceRoleSupabase()
    .from("agent_tool_call_event" as never)
    .select(AGENT_TOOL_CALL_EVENT_SELECT)
    .in("run_id", runIds)
    .order("sequence", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw normalizeSupabaseError("agent_tool_call_event query", error);

  const grouped = new Map<string, AgentToolCallEventRow[]>();
  for (const rawEvent of data ?? []) {
    const event = rawEvent as AgentToolCallEventRow;
    if (!event.task_id) continue;
    const events = grouped.get(event.task_id) ?? [];
    events.push(event);
    grouped.set(event.task_id, events);
  }

  return grouped;
}

export async function getVisibleBrokerRun(agentId: string, runId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_run")
    .select("run_id,agent_id,workspace_id")
    .eq("agent_id", agentId)
    .eq("run_id", runId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("broker_run query", error);

  return (data as VisibleBrokerRunRow | null) ?? null;
}

export async function getBrokerTaskForRun(runId: string, taskId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_task")
    .select("task_id,run_id")
    .eq("run_id", runId)
    .eq("task_id", taskId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("broker_task query", error);

  return data ?? null;
}

export async function insertAgentToolCallEvent(row: Record<string, unknown>) {
  const { data, error } = await getServiceRoleSupabase()
    .from("agent_tool_call_event" as never)
    .insert(row as never)
    .select(AGENT_TOOL_CALL_EVENT_SELECT)
    .single();
  if (error) throw normalizeSupabaseError("agent_tool_call_event insert", error);

  return (data as AgentToolCallEventRow | null) ?? null;
}

export async function getGatewayConfigStateForScope(scopeType: "agent" | "workspace", scopeId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("gateway_config_state")
    .select(GATEWAY_CONFIG_STATE_SELECT)
    .eq("scope_type", scopeType)
    .eq("scope_id", scopeId)
    .limit(1);

  if (error) throw normalizeSupabaseError("gateway_config_state query", error);
  return ((data ?? [])[0] as GatewayConfigStateRow | undefined) ?? null;
}

export async function getRecentBrokerRuns(agentId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("broker_run")
    .select("run_id,created_at,updated_at")
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false })
    .limit(DASHBOARD_VERSION_RUN_LIMIT);
  if (error) throw normalizeSupabaseError("broker_run query", error);

  return (data ?? []) as BrokerRunVersionRow[];
}

export async function getLatestBrokerTask(runIds: string[]) {
  if (runIds.length === 0) return null;

  const { data, error } = await getServiceRoleSupabase()
    .from("broker_task")
    .select("task_id,last_event_at,updated_at")
    .in("run_id", runIds)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw normalizeSupabaseError("broker_task query", error);

  return ((data ?? [])[0] as BrokerTaskVersionRow | undefined) ?? null;
}

export async function getLatestAgentToolCallEvent(runIds: string[]) {
  if (runIds.length === 0) return null;

  const { data, error } = await getServiceRoleSupabase()
    .from("agent_tool_call_event" as never)
    .select("id,created_at,updated_at")
    .in("run_id", runIds)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw normalizeSupabaseError("agent_tool_call_event query", error);

  return ((data ?? [])[0] as AgentToolCallEventVersionRow | undefined) ?? null;
}

export async function getGatewayConfigVersionRows(agentId: string, workspaceId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("gateway_config_state")
    .select(
      "scope_type,scope_id,sync_status,sync_error,last_apply_status,last_apply_error,last_apply_at,last_applied_version,synced_at",
    )
    .or(
      [
        "and(scope_type.eq.agent,scope_id.eq." + agentId + ")",
        "and(scope_type.eq.workspace,scope_id.eq." + workspaceId + ")",
      ].join(","),
    )
    .order("scope_type", { ascending: true })
    .limit(2);
  if (error) throw normalizeSupabaseError("gateway_config_state query", error);

  return (data ?? []) as GatewayConfigVersionRow[];
}
