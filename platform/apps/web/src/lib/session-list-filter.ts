import type { Session } from "../hooks/useSessions";

const AGENT_KEY_RE = /^agent:([^:]+):/;

/**
 * Extracts the agent id encoded in a session key of the form
 * `agent:{agentId}:main`.
 */
export function parseAgentIdFromSessionKey(key: string): string | undefined {
  const agentMatch = AGENT_KEY_RE.exec(key);
  return agentMatch?.[1];
}

export type VisibleSession =
  | Session
  | { key: string; label: string; agentId: string | undefined };

/**
 * Returns the sessions that should be shown for the currently selected agent,
 * preserving manager transcripts even when the runtime has not yet emitted
 * any manager rows.
 *
 * - When `activeKey` belongs to an agent (regular or manager), only sessions
 *   for that agent are returned.
 * - When `readOnly` is true (manager transcripts) and the active key is not
 *   present in the filtered list, a placeholder row is prepended so the user
 *   still sees a "Manager transcript" entry to click into.
 */
export function selectVisibleSessions(
  sessions: Session[],
  activeKey: string,
  readOnly: boolean,
): VisibleSession[] {
  const agentId = parseAgentIdFromSessionKey(activeKey);
  const agentSessions = agentId
    ? sessions.filter((s) => s.agentId === agentId || s.key.includes(agentId))
    : sessions;

  if (
    readOnly &&
    activeKey &&
    !agentSessions.some((session) => session.key === activeKey)
  ) {
    return [
      { key: activeKey, label: "Manager transcript", agentId },
      ...agentSessions,
    ];
  }

  return agentSessions;
}
