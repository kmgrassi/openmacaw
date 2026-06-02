import { describe, expect, it } from "vitest";

import type { Session } from "../hooks/useSessions";
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

  it("returns undefined for keys it does not recognize", () => {
    expect(parseAgentIdFromSessionKey("")).toBeUndefined();
    expect(parseAgentIdFromSessionKey("plan:abc:main")).toBeUndefined();
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
});
