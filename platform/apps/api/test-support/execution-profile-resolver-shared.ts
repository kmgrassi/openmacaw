import { vi } from "vitest";

export type MockDb = Record<string, Array<Record<string, unknown>>>;

let selectRowsForTable: (table: string, params: URLSearchParams) => unknown[] | Promise<unknown[]> = () => [];

vi.mock("../src/supabase-client.js", () => {
  function mockClient() {
    return {
      from(table: string) {
        const params = new URLSearchParams();
        const query = {
          select(columns: string) {
            params.set("select", columns);
            return query;
          },
          eq(column: string, value: unknown) {
            params.set(column, `eq.${String(value)}`);
            return query;
          },
          in(column: string, values: unknown[]) {
            params.set(column, `in.(${values.map(String).join(",")})`);
            return query;
          },
          order(column: string, options?: { ascending?: boolean }) {
            const direction = options?.ascending === true ? "asc" : "desc";
            const existing = params.get("order");
            params.set("order", existing ? `${existing},${column}.${direction}` : `${column}.${direction}`);
            return query;
          },
          limit(count: number) {
            params.set("limit", String(count));
            return query;
          },
          then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
            onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) {
            return Promise.resolve()
              .then(() => selectRowsForTable(table, params))
              .then((data) => ({ data, error: null }))
              .then(onfulfilled, onrejected);
          },
        };
        return query;
      },
    };
  }

  return {
    getServiceRoleSupabase: mockClient,
    getUserScopedSupabase: mockClient,
    normalizeSupabaseError: (_context: string, error: unknown) => error,
  };
});

export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const planningAgentId = "11111111-1111-4111-8111-111111111111";
export const codingAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const managerAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const anthropicCredentialId = "33333333-3333-4333-8333-333333333333";
export const codexCredentialId = "44444444-4444-4444-8444-444444444444";

export function tableParams(params: URLSearchParams) {
  return Object.fromEntries(params.entries());
}

export function queryRows(rowsByTable: MockDb, table: string, params: URLSearchParams) {
  const query = tableParams(params);
  let rows = [...(rowsByTable[table] ?? [])];

  rows = rows.filter((row) => {
    for (const [key, value] of Object.entries(query)) {
      if (key === "select" || key === "order" || key === "limit") continue;
      if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) {
        return false;
      }
      if (value.startsWith("in.")) {
        const allowed = value
          .slice(4, -1)
          .split(",")
          .map((item) => item.trim());
        if (!allowed.includes(String(row[key]))) return false;
      }
    }
    return true;
  });

  if (query.order === "priority.desc,created_at.asc") {
    rows.sort((left, right) => Number(right.priority) - Number(left.priority));
  }
  if (query.order === "position.asc") {
    rows.sort((left, right) => Number(left.position) - Number(right.position));
  }

  const limit = query.limit ? Number(query.limit) : null;
  return (limit ? rows.slice(0, limit) : rows) as never;
}

export function setSelectRowsForTable(
  next: (table: string, params: URLSearchParams) => unknown[] | Promise<unknown[]>,
) {
  selectRowsForTable = next;
}

export function setupMockDatabase(overrides: Partial<MockDb> = {}) {
  const db: MockDb = {
    agent: [
      {
        id: planningAgentId,
        workspace_id: workspaceId,
        type: "planning",
        model_settings: { primary: "openai/gpt-5.2" },
        tool_policy: {},
      },
      {
        id: codingAgentId,
        workspace_id: workspaceId,
        type: "coding",
        model_settings: { primary: "openai/gpt-5.1-codex" },
        tool_policy: {},
      },
    ],
    routing_rule: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        priority: 20,
        enabled: true,
        runner_kind: "llm_tool_runner",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        model_tier_floor: "any",
        credential_id: null,
        credential_alias: "default-anthropic",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        priority: 10,
        enabled: true,
        runner_kind: "codex",
        provider: "openai_codex",
        model: "gpt-5.1-codex",
        model_tier_floor: "any",
        credential_id: codexCredentialId,
        credential_alias: null,
      },
    ],
    routing_rule_fallback: [],
    routing_rule_match: [
      {
        rule_id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        kind: "agent_type",
        key: null,
        value: "planning",
      },
      {
        rule_id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        kind: "agent_type",
        key: null,
        value: "coding",
      },
    ],
    credential_alias: [
      {
        workspace_id: workspaceId,
        alias: "default-anthropic",
        credential_id: anthropicCredentialId,
      },
    ],
    credential: [
      {
        id: codexCredentialId,
        workspace_id: workspaceId,
        key_value: { agent_id: codingAgentId },
      },
    ],
    gateway_config: [
      {
        scope_type: "agent",
        scope_id: codingAgentId,
        version: 1,
        config_json: {
          runners: [
            {
              kind: "codex",
              provider: "openai_codex",
              model: "gpt-5.1-codex",
            },
          ],
        },
      },
    ],
    ...overrides,
  };

  setSelectRowsForTable((table, params) => queryRows(db, table, params));

  return db;
}
