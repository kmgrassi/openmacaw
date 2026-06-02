import type { AgentId, WorkspaceId } from "./agent";

/**
 * Session key - encodes agent + session name.
 * Format: `agent:{agentId}:main` (currently the only variant).
 */
export type SessionKey = `agent:${string}:main`;

/** Strict UUID v4/v5-ish validator used for runtime scope fields. */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

/** Builds a session key from an agent ID. */
export function makeSessionKey(agentId: AgentId): SessionKey {
  if (!isValidUuid(agentId)) {
    throw new Error("invalid_agent_id");
  }
  return `agent:${agentId}:main`;
}

/**
 * Extracts the agent ID from a session key.
 * Returns `null` if the key doesn't match the expected format.
 */
export function parseAgentId(sessionKey: SessionKey | string): AgentId | null {
  const m = /^agent:([^:]+):main$/.exec(String(sessionKey || ""));
  const candidate = m?.[1]?.trim() || "";
  return isValidUuid(candidate) ? candidate : null;
}

/**
 * Runtime scope - the resolved identity context for a WS connection.
 * Every connected session MUST have all three fields populated.
 */
export type RuntimeScope = {
  agentId: AgentId;
  workspaceId: WorkspaceId;
  sessionKey: SessionKey;
};

/**
 * Required scope fields on the wire (snake_case).
 * Matches engine `WsScopeFields` from ws-scope-contract.ts.
 * Used in WS upgrade query params and scoped request payloads.
 */
export type WsScopeFields = {
  agent_id: AgentId;
  workspace_id: WorkspaceId;
};

/**
 * Optional scope fields - used during connect handshake before onboarding
 * when scope may not yet be resolved.
 * Matches engine `WsScopeFieldsOptional`.
 */
export type WsScopeFieldsOptional = {
  agent_id?: AgentId | null;
  workspace_id?: WorkspaceId | null;
};

/** Convert a resolved RuntimeScope to wire-format WsScopeFields. */
export function toWireScopeFields(scope: RuntimeScope): WsScopeFields {
  return {
    agent_id: scope.agentId,
    workspace_id: scope.workspaceId,
  };
}

/**
 * Query parameters appended to the WS URL to scope the connection.
 * The broker validates these on upgrade.
 * Extends WsScopeFields with the session_key.
 */
export type WsConnectQuery = WsScopeFields & {
  session_key: SessionKey;
};
