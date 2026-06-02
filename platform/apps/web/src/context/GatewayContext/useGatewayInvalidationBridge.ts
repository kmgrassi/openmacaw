import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GatewayEventFrame, RuntimeScope } from "../../api/ws-types";
import { invalidateRuntimeQueries } from "../../api/query-invalidation";

type AddEventListener = (
  handler: (evt: GatewayEventFrame) => void,
) => () => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizedEventName(
  event: GatewayEventFrame,
  payload: Record<string, unknown> | null,
) {
  const raw =
    stringField(payload, "kind", "event", "type", "phase") ?? event.event;
  return raw.trim().toLowerCase().replace(/[_-]+/g, ".");
}

function eventInvalidationScope(event: GatewayEventFrame) {
  const payload = asRecord(event.payload);
  const eventName = normalizedEventName(event, payload);
  const state = stringField(payload, "state")?.toLowerCase() ?? null;
  const terminalChat =
    state === "final" || state === "aborted" || state === "error";
  const terminalRun =
    eventName === "turn.completed" ||
    eventName === "turn.completion" ||
    eventName === "turn.failed" ||
    eventName === "turn.failure" ||
    eventName === "run.completed" ||
    eventName === "run.completion" ||
    eventName === "run.failed" ||
    eventName === "run.failure";

  if (event.event === "chat") {
    return terminalChat ? { messagesCanChange: true } : null;
  }

  if (terminalRun) {
    return { messagesCanChange: true };
  }

  if (eventName.startsWith("tool.") || eventName.startsWith("usage.")) {
    return { messagesCanChange: false };
  }

  return null;
}

export function useGatewayInvalidationBridge(input: {
  scope: RuntimeScope | null;
  addEventListener: AddEventListener;
}) {
  const queryClient = useQueryClient();
  const { addEventListener, scope } = input;

  useEffect(() => {
    return addEventListener((event) => {
      const invalidationScope = eventInvalidationScope(event);
      if (!invalidationScope) return;
      const payload = asRecord(event.payload);
      const agentId =
        stringField(payload, "agentId", "agent_id") ?? scope?.agentId;
      if (!agentId) return;

      const sessionKey =
        stringField(payload, "sessionKey", "session_key") ?? scope?.sessionKey;

      void invalidateRuntimeQueries(queryClient, agentId, sessionKey, {
        messagesCanChange: invalidationScope.messagesCanChange,
      });
    });
  }, [addEventListener, queryClient, scope]);
}
