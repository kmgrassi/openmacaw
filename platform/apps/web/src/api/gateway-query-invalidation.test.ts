import { describe, expect, it } from "vitest";
import type { GatewayEventFrame, RuntimeEventPayload } from "./ws-types";
import { invalidationForGatewayEvent } from "./gateway-query-invalidation";
import { queryKeys } from "./query-keys";

const scope = {
  workspaceId: "workspace-1",
  agentId: "11111111-1111-4111-8111-111111111111",
  sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
} as const;

function keysFor(frame: GatewayEventFrame) {
  return invalidationForGatewayEvent(frame, scope).targets.map(
    (target) => target.key,
  );
}

describe("invalidationForGatewayEvent", () => {
  it("invalidates persisted chat surfaces on final chat events", () => {
    expect(
      keysFor({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: scope.sessionKey,
          state: "final",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        queryKeys.messages.history(scope.agentId, scope.sessionKey),
        queryKeys.sessions.orchestrator(scope.workspaceId),
        queryKeys.sessions.worker(),
        queryKeys.agentDashboard.latestRun(scope.agentId),
        queryKeys.setup.byAgent(scope.agentId),
      ]),
    );
  });

  it("keeps token deltas local instead of refetching durable data", () => {
    expect(
      keysFor({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: scope.sessionKey,
          state: "delta",
        },
      }),
    ).toEqual([]);
  });

  it("invalidates persisted chat surfaces on local model completion method payloads", () => {
    expect(
      keysFor({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: scope.sessionKey,
          method: "run.completed",
        } as RuntimeEventPayload,
      } as GatewayEventFrame),
    ).toEqual(
      expect.arrayContaining([
        queryKeys.messages.history(scope.agentId, scope.sessionKey),
        queryKeys.sessions.orchestrator(scope.workspaceId),
        queryKeys.sessions.worker(),
        queryKeys.agentDashboard.latestRun(scope.agentId),
        queryKeys.setup.byAgent(scope.agentId),
      ]),
    );
  });

  it("does not invalidate persisted chat surfaces on message completion boundaries", () => {
    expect(
      keysFor({
        type: "event",
        event: "message.completed",
        payload: {
          runId: "run-1",
          sessionKey: scope.sessionKey,
        } as RuntimeEventPayload,
      }),
    ).toEqual([]);
  });

  it("maps snake_case runtime payloads to scoped dashboard invalidation", () => {
    const result = invalidationForGatewayEvent(
      {
        type: "event",
        event: "tool_completion",
        payload: {
          workspace_id: "workspace-from-event",
          agent_id: "agent-from-event",
          session_key: "agent:agent-from-event:main",
          run_id: "run-1",
          event_id: "event-1",
        } as RuntimeEventPayload,
      },
      scope,
    );

    expect(result.eventId).toBe("tool_completion:event-1");
    expect(result.targets.map((target) => target.key)).toContainEqual(
      queryKeys.agentDashboard.latestRun("agent-from-event"),
    );
  });

  it("maps canonical usage_reported runtime events to dashboard invalidation", () => {
    expect(
      keysFor({
        type: "event",
        event: "usage",
        payload: {
          kind: "usage_reported",
          runId: "run-1",
        },
      }),
    ).toContainEqual(queryKeys.agentDashboard.latestRun(scope.agentId));
  });

  it("maps future work-item runtime events without broad cache clears", () => {
    expect(
      keysFor({
        type: "event",
        event: "run.completed",
        payload: {
          kind: "work_item.woken",
          workItemId: "work-item-1",
        } as RuntimeEventPayload,
      }),
    ).toEqual(
      expect.arrayContaining([
        queryKeys.workItems.list(scope.workspaceId),
        queryKeys.manager.status(scope.workspaceId),
      ]),
    );
  });
});
