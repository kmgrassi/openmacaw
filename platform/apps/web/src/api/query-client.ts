import { broadcastQueryClient } from "@tanstack/query-broadcast-client-experimental";
import { QueryClient, type QueryKey } from "@tanstack/react-query";

import { BrokerSessionError } from "./broker";
import { ApiClientError } from "./client";
import { queryKeys } from "./query-keys";

const RUNTIME_STALE_TIME_MS = 5_000;
const SERVER_STATE_STALE_TIME_MS = 30_000;
const STATIC_STALE_TIME_MS = 5 * 60_000;
const QUERY_GC_TIME_MS = 30 * 60_000;
const MAX_GET_RETRIES = 2;
const BROADCAST_CHANNEL = "parallel-agent-platform-query-cache";

function errorStatus(error: unknown): number | null {
  if (error instanceof ApiClientError) return error.status;
  if (error instanceof BrokerSessionError) return error.status;
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
}

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 401 || status === 403 || status === 404) return false;
  return failureCount < MAX_GET_RETRIES;
}

export function createAppQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: QUERY_GC_TIME_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        staleTime: SERVER_STATE_STALE_TIME_MS,
      },
      mutations: {
        retry: false,
      },
    },
  });

  queryClient.setQueryDefaults(queryKeys.agentDashboard.all, {
    staleTime: RUNTIME_STALE_TIME_MS,
  });
  queryClient.setQueryDefaults(queryKeys.messages.all, {
    staleTime: RUNTIME_STALE_TIME_MS,
  });
  queryClient.setQueryDefaults(queryKeys.sessions.all, {
    staleTime: RUNTIME_STALE_TIME_MS,
  });
  queryClient.setQueryDefaults(queryKeys.agentHealth.all, {
    staleTime: RUNTIME_STALE_TIME_MS,
  });
  queryClient.setQueryDefaults(queryKeys.models.all, {
    staleTime: STATIC_STALE_TIME_MS,
  });
  queryClient.setQueryDefaults(queryKeys.tools.catalogs(), {
    staleTime: STATIC_STALE_TIME_MS,
  });

  return queryClient;
}

export const queryClient = createAppQueryClient();

export function installCrossTabQuerySync(queryClient: QueryClient) {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return () => {};
  }

  return broadcastQueryClient({
    queryClient,
    broadcastChannel: BROADCAST_CHANNEL,
  });
}

export const queryStaleTimes = {
  runtime: RUNTIME_STALE_TIME_MS,
  serverState: SERVER_STATE_STALE_TIME_MS,
  static: STATIC_STALE_TIME_MS,
} as const;

export async function invalidateAgentData(input?: {
  agentId?: string | null;
  workspaceId?: string | null;
}) {
  const invalidations: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: queryKeys.auth.state() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.all }),
  ];

  if (input?.agentId) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.setup.byAgent(input.agentId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentHealth.detail(input.agentId),
      }),
    );

    if (input.workspaceId) {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeProfile(
            input.agentId,
            input.workspaceId,
          ),
        }),
      );
    } else {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeProfiles(),
        }),
      );
    }
  } else {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: queryKeys.setup.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentHealth.all }),
    );
  }

  await Promise.all(invalidations);
}

export async function invalidateQueryFamily(queryKey: QueryKey) {
  await queryClient.invalidateQueries({ queryKey });
}
