import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listOrchestratorSessions } from "../api/orchestrator-sessions";
import { queryKeys } from "../api/query-keys";
import { useGatewayContext } from "../context/GatewayContext";

export type Session = {
  key: string;
  id?: string;
  label?: string;
  agentId?: string;
  lastMessageAt?: number;
};

export function useSessions() {
  const { connected, request, scope } = useGatewayContext();
  const queryClient = useQueryClient();
  const scopeKey = scope?.sessionKey ?? "default";

  const query = useQuery({
    queryKey: queryKeys.sessions.orchestrator(scopeKey),
    queryFn: async () => {
      const result = await listOrchestratorSessions(request, 50);
      return result.sessions.map((s) => ({
        key: s.key,
        id: s.id || s.sessionId,
        label: s.label,
        agentId: s.agentId,
        lastMessageAt: s.lastMessageAt ?? s.updatedAt ?? undefined,
      }));
    },
    enabled: connected,
  });

  const sessions = useMemo<Session[]>(() => query.data ?? [], [query.data]);

  const resetMutation = useMutation({
    mutationFn: async (key: string) => {
      await request("sessions.reset", { key });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.orchestratorLists(),
      });
    },
  });

  const reload = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const resetSession = useCallback(
    async (key: string) => {
      try {
        await resetMutation.mutateAsync(key);
      } catch (err) {
        console.error("[useSessions] reset failed:", err);
      }
    },
    [resetMutation],
  );

  useEffect(() => {
    if (query.error) {
      console.error("[useSessions]", query.error);
    }
  }, [query.error]);

  return {
    sessions,
    loading: query.isLoading || query.isFetching,
    reload,
    resetSession,
  };
}
