import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GatewayEventFrame, RuntimeScope } from "./ws-types";
import {
  invalidateQueryTargets,
  invalidationTargetsForReason,
  uniqueInvalidationTargets,
  type QueryInvalidationScope,
  type QueryInvalidationTarget,
} from "./query-invalidation";

type GatewayEventInvalidation = {
  eventId: string | null;
  targets: QueryInvalidationTarget[];
};

const FINAL_CHAT_STATES = new Set(["final", "aborted", "error"]);
const TOOL_EVENT_NAMES = new Set([
  "tool.started",
  "tool.start",
  "tool.call.started",
  "tool.completed",
  "tool.complete",
  "tool.completion",
  "tool.call.completed",
  "tool.failed",
  "tool.failure",
  "tool.call.failed",
]);
const TURN_OR_RUN_FINAL_EVENTS = new Set([
  "turn.completed",
  "turn.completion",
  "message.completed",
  "message.completion",
  "run.completed",
  "run.completion",
  "turn.failed",
  "turn.failure",
  "run.failed",
  "run.failure",
]);
const USAGE_EVENTS = new Set([
  "usage.updated",
  "usage.update",
  "usage.reported",
  "usage",
]);
const PLAN_EVENTS = new Set(["plan.created", "plan.updated", "plan.deleted"]);
const WORK_ITEM_EVENTS = new Set([
  "work.item.created",
  "work.item.updated",
  "work.item.deleted",
  "work.item.snoozed",
  "work.item.woke",
  "work.item.woken",
  "work.item.awakened",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeEventName(frame: GatewayEventFrame): string {
  const payload = record(frame.payload);
  const raw =
    stringField(payload, "kind", "event", "type", "phase", "method") ??
    frame.event;
  return raw.toLowerCase().replace(/[\/_-]+/g, ".").trim();
}

function scopeFromEvent(
  frame: GatewayEventFrame,
  fallbackScope: RuntimeScope | null,
): QueryInvalidationScope {
  const payload = record(frame.payload);
  return {
    workspaceId:
      stringField(payload, "workspaceId", "workspace_id") ??
      fallbackScope?.workspaceId ??
      null,
    agentId:
      stringField(payload, "agentId", "agent_id") ??
      fallbackScope?.agentId ??
      null,
    sessionKey:
      stringField(payload, "sessionKey", "session_key") ??
      fallbackScope?.sessionKey ??
      null,
    runId: stringField(payload, "runId", "run_id"),
    planId: stringField(payload, "planId", "plan_id"),
    workItemId: stringField(payload, "workItemId", "work_item_id"),
  };
}

function eventIdFor(frame: GatewayEventFrame, scope: QueryInvalidationScope) {
  const payload = record(frame.payload);
  const eventId = stringField(payload, "eventId", "event_id", "id");
  if (eventId) return `${frame.event}:${eventId}`;
  if (typeof frame.seq === "number") return `${frame.event}:seq:${frame.seq}`;
  const name = normalizeEventName(frame);
  return [
    frame.event,
    name,
    scope.workspaceId,
    scope.agentId,
    scope.sessionKey,
    scope.runId,
    scope.planId,
    scope.workItemId,
  ]
    .filter(Boolean)
    .join(":");
}

export function invalidationForGatewayEvent(
  frame: GatewayEventFrame,
  fallbackScope: RuntimeScope | null = null,
): GatewayEventInvalidation {
  const scope = scopeFromEvent(frame, fallbackScope);
  const payload = record(frame.payload);
  const eventName = normalizeEventName(frame);
  const targets: QueryInvalidationTarget[] = [];

  if (frame.event === "chat") {
    const state = stringField(payload, "state")?.toLowerCase() ?? null;
    if (state && FINAL_CHAT_STATES.has(state)) {
      targets.push(
        ...invalidationTargetsForReason("message", scope),
        ...invalidationTargetsForReason("session", scope),
        ...invalidationTargetsForReason("dashboard", scope),
        ...invalidationTargetsForReason("setup", scope),
      );
    }
  }

  if (
    TOOL_EVENT_NAMES.has(eventName) ||
    TURN_OR_RUN_FINAL_EVENTS.has(eventName) ||
    USAGE_EVENTS.has(eventName)
  ) {
    targets.push(...invalidationTargetsForReason("dashboard", scope));
  }

  if (TURN_OR_RUN_FINAL_EVENTS.has(eventName)) {
    targets.push(
      ...invalidationTargetsForReason("message", scope),
      ...invalidationTargetsForReason("session", scope),
      ...invalidationTargetsForReason("setup", scope),
    );
  }

  if (PLAN_EVENTS.has(eventName)) {
    targets.push(...invalidationTargetsForReason("plan", scope));
  }

  if (WORK_ITEM_EVENTS.has(eventName)) {
    targets.push(...invalidationTargetsForReason("work_item", scope));
  }

  return {
    eventId: eventIdFor(frame, scope) || null,
    targets: uniqueInvalidationTargets(targets),
  };
}

export function useGatewayQueryInvalidation({
  addEventListener,
  scope,
}: {
  addEventListener: (handler: (evt: GatewayEventFrame) => void) => () => void;
  scope: RuntimeScope | null;
}) {
  const queryClient = useQueryClient();
  const seenEventIdsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return addEventListener((frame) => {
      const invalidation = invalidationForGatewayEvent(frame, scope);
      if (invalidation.targets.length === 0) return;

      if (invalidation.eventId) {
        const now = Date.now();
        const seenAt = seenEventIdsRef.current.get(invalidation.eventId);
        if (seenAt && now - seenAt < 30_000) return;
        seenEventIdsRef.current.set(invalidation.eventId, now);

        for (const [key, timestamp] of seenEventIdsRef.current) {
          if (now - timestamp > 60_000) {
            seenEventIdsRef.current.delete(key);
          }
        }
      }

      void invalidateQueryTargets(queryClient, invalidation.targets);
    });
  }, [addEventListener, queryClient, scope]);
}
