import { describe, expect, it } from "vitest";

import type { Session } from "../hooks/useSessions";
import { parseAgentScopedSessionAgentId } from "../api/ws-types/scope";
import {
  parseAgentIdFromSessionKey,
  selectVisibleSessions,
} from "./session-list-filter";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MANAGER_AGENT_ID = "22222222-2222-4222-8222-222222222222";

describe("parseAgentIdFromSessionKey", () => {
  it("parses agent keys", () => {
    expect(parseAgentIdFromSessionKey(`agent:${AGENT_ID}:main`)).toBe(AGENT_ID);
  });

  it("parses agent-scoped non-main keys", () => {
    expect(parseAgentIdFromSessionKey(`agent:${AGENT_ID}:tool-battery:run-1`)).toBe(
      AGENT_ID,
    );
  });

  it("returns undefined for keys it does not recognize", () => {
    expect(parseAgentIdFromSessionKey("")).toBeUndefined();
    expect(parseAgentIdFromSessionKey("plan:abc:main")).toBeUndefined();
  });
});

describe("parseAgentScopedSessionAgentId", () => {
  it("rejects non-agent or invalid agent keys", () => {
    expect(parseAgentScopedSessionAgentId("plan:abc:main")).toBeNull();
    expect(parseAgentScopedSessionAgentId("agent:not-a-uuid:main")).toBeNull();
  });
});

describe("selectVisibleSessions", () => {
  const managerSession: Session = {
    key: `agent:${MANAGER_AGENT_ID}:main`,
    id: "manager-thread-1",
    label: "Manager transcript",
    agentId: MANAGER_AGENT_ID,
    lastMessageAt: 1_700_000_100_000,
  };
  const codingSession: Session = {
    key: `agent:${AGENT_ID}:main`,
    id: "coding-thread-1",
    label: "Coding transcript",
    agentId: AGENT_ID,
    lastMessageAt: 1_700_000_200_000,
  };

  it("keeps the manager-agent session whose row is keyed as agent:{managerAgentId}:main", () => {
    const result = selectVisibleSessions(
      [managerSession, codingSession],
      `agent:${MANAGER_AGENT_ID}:main`,
      true,
    );

    expect(result).toEqual([managerSession]);
  });

  it("does not duplicate the active key when a matching row already exists", () => {
    const activeKey = `agent:${MANAGER_AGENT_ID}:main`;
    const result = selectVisibleSessions([managerSession], activeKey, true);

    expect(result).toEqual([managerSession]);
  });

  it("filters non-manager agent sessions when the active key is a regular agent", () => {
    const result = selectVisibleSessions(
      [managerSession, codingSession],
      `agent:${AGENT_ID}:main`,
      false,
    );

    expect(result).toEqual([codingSession]);
  });

  it("keeps agent-scoped non-main sessions without relying on substring matches", () => {
    const toolSession: Session = {
      key: `agent:${AGENT_ID}:tool-battery:run-1`,
      id: "tool-thread-1",
      label: "Tool battery",
      lastMessageAt: 1_700_000_300_000,
    };

    const result = selectVisibleSessions(
      [managerSession, codingSession, toolSession],
      `agent:${AGENT_ID}:main`,
      false,
    );

    expect(result).toEqual([codingSession, toolSession]);
  });

  it("does not leak sessions from a different agent whose key happens to contain the active id", () => {
    const overlappingAgentId = `${AGENT_ID}-suffix`;
    const unrelatedSession: Session = {
      key: `external:${AGENT_ID}:mirror`,
      id: "external-thread-1",
      label: "External mirror",
      lastMessageAt: 1_700_000_250_000,
    };
    const overlappingSession: Session = {
      key: `agent:${MANAGER_AGENT_ID}:main`,
      id: "other-thread-1",
      label: "Different agent",
      agentId: overlappingAgentId,
      lastMessageAt: 1_700_000_350_000,
    };

    const result = selectVisibleSessions(
      [codingSession, unrelatedSession, overlappingSession],
      `agent:${AGENT_ID}:main`,
      false,
    );

    expect(result).toEqual([codingSession]);
  });
});
