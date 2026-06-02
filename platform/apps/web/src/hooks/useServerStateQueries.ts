import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAgentCredentialReference,
  listSavedCredentialsForWorkspace,
  saveAgentCredentialReference,
  saveStoredCredential,
} from "../api/credentials";
import {
  assignLocalRuntimeRunnerToAgent,
  getLocalRuntimeConfig,
  listLocalRuntimes,
  probeLocalModel,
  probeRegisteredLocalRuntimeRunner,
  registerLocalRuntime,
  removeLocalRuntime,
  rotateLocalRuntimeToken,
  unassignLocalRuntimeRunnerFromAgent,
} from "../api/local-runtime";
import {
  fallbackModelCatalog,
  listModelCatalog,
  listModelProviders,
  saveModelProviderCredential,
} from "../api/model-catalog";
import { getLearningMemoryStatus } from "../api/learning-memory";
import {
  fetchSetupAuthState,
  applyDefaultAgentCredentials,
} from "../api/setup";
import {
  fetchWorkspaceSettings,
  patchWorkspaceSettings,
} from "../api/workspace-settings";
import { invalidateAgentReadinessQueries } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";

export function useAuthStateQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.auth.state(),
    queryFn: fetchSetupAuthState,
    enabled,
    staleTime: 10_000,
  });
}

export function useLocalRuntimesQuery(workspaceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.localRuntimes.list(
      workspaceId ?? "__missing_workspace__",
    ),
    queryFn: () => listLocalRuntimes(workspaceId!),
    enabled: Boolean(workspaceId),
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.runtimes.length ? 2_000 : false,
  });
}

export function useLearningMemoryStatusQuery(workspaceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.learningMemory.status(
      workspaceId ?? "__missing_workspace__",
    ),
    queryFn: () => getLearningMemoryStatus(workspaceId!),
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
  });
}

export function useLocalRuntimeMutations(workspaceId?: string | null) {
  const queryClient = useQueryClient();

  async function invalidate(agentIds: string[] = []) {
    await invalidateAgentReadinessQueries(queryClient, {
      workspaceId,
      agentIds,
    });
  }

  return {
    register: useMutation({
      mutationFn: (input: Parameters<typeof registerLocalRuntime>[1]) =>
        registerLocalRuntime(workspaceId!, input),
      onSuccess: async () => invalidate(),
    }),
    remove: useMutation({
      mutationFn: (machineId: string) =>
        removeLocalRuntime(workspaceId!, machineId),
      onSuccess: async () => invalidate(),
    }),
    probeDraft: useMutation({
      mutationFn: (input: Parameters<typeof probeLocalModel>[1]) =>
        probeLocalModel(workspaceId!, input),
    }),
    probeRegistered: useMutation({
      mutationFn: (runnerId: string) =>
        probeRegisteredLocalRuntimeRunner(workspaceId!, runnerId),
    }),
    regenerateConfig: useMutation({
      mutationFn: (machineId: string) =>
        getLocalRuntimeConfig(workspaceId!, machineId),
      onSuccess: async () => invalidate(),
    }),
    rotateToken: useMutation({
      mutationFn: (machineId: string) =>
        rotateLocalRuntimeToken(workspaceId!, machineId),
      onSuccess: async () => invalidate(),
    }),
    assign: useMutation({
      mutationFn: (input: { runnerId: string; agentId: string }) =>
        assignLocalRuntimeRunnerToAgent(workspaceId!, input.runnerId, {
          agentId: input.agentId,
        }),
      onSuccess: async (_result, input) => invalidate([input.agentId]),
    }),
    unassign: useMutation({
      mutationFn: (input: { runnerId: string; agentId: string }) =>
        unassignLocalRuntimeRunnerFromAgent(
          workspaceId!,
          input.runnerId,
          input.agentId,
        ),
      onSuccess: async (_result, input) => invalidate([input.agentId]),
    }),
  };
}

export function useResolvedCredentialQuery(
  agentId?: string | null,
  workspaceId?: string | null,
  refreshToken = 0,
) {
  const scope =
    agentId && workspaceId
      ? `workspace:${workspaceId}:agent:${agentId}`
      : "missing";
  return useQuery({
    queryKey: queryKeys.credentials.resolved(scope, refreshToken),
    queryFn: () => getAgentCredentialReference(agentId!, workspaceId!),
    enabled: Boolean(agentId && workspaceId),
    staleTime: 10_000,
  });
}

export function useWorkspaceCredentialsQuery(workspaceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.credentials.workspace(
      workspaceId ?? "__missing_workspace__",
    ),
    queryFn: () => listSavedCredentialsForWorkspace(workspaceId!),
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
  });
}

export function useCredentialMutations(
  agentId?: string | null,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();

  async function invalidate() {
    await invalidateAgentReadinessQueries(queryClient, {
      workspaceId,
      agentIds: agentId ? [agentId] : [],
    });
    if (workspaceId) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.credentials.workspace(workspaceId),
      });
    }
  }

  return {
    saveStored: useMutation({
      mutationFn: saveStoredCredential,
      onSuccess: async () => invalidate(),
    }),
    saveReference: useMutation({
      mutationFn: saveAgentCredentialReference,
      onSuccess: async () => invalidate(),
    }),
  };
}

export function useModelCatalogQueries(input: {
  workspaceId?: string | null;
  agentId?: string | null;
  refresh?: boolean;
  refreshToken?: number;
  fallbackMode?: "configured" | "all";
}) {
  const providers = useQuery({
    queryKey: queryKeys.models.providers(
      input.workspaceId ?? "__missing_workspace__",
      {
        refresh: input.refresh,
        refreshToken: input.refreshToken,
      },
    ),
    queryFn: () =>
      listModelProviders({
        workspaceId: input.workspaceId!,
        refresh: input.refresh,
      }),
    enabled: Boolean(input.workspaceId),
    staleTime: 5 * 60_000,
  });
  const catalog = useQuery({
    queryKey: queryKeys.models.catalog(
      input.workspaceId ?? "__missing_workspace__",
      {
        agentId: input.agentId,
        refresh: input.refresh,
        refreshToken: input.refreshToken,
      },
    ),
    queryFn: () =>
      listModelCatalog({
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        refresh: input.refresh,
      }),
    enabled: Boolean(input.workspaceId),
    staleTime: 5 * 60_000,
    select: (response) => ({
      ...response,
      models: response.models.length
        ? response.models
        : input.fallbackMode === "all"
          ? fallbackModelCatalog().models
          : fallbackModelCatalog().models.filter(
              (model) => model.source === "configured",
            ),
    }),
  });

  return { providers, catalog };
}

export function useModelProviderCredentialMutation(
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      provider: Parameters<typeof saveModelProviderCredential>[0];
      credential: Parameters<typeof saveModelProviderCredential>[1];
    }) => saveModelProviderCredential(input.provider, input.credential),
    onSuccess: async () => {
      await invalidateAgentReadinessQueries(queryClient, { workspaceId });
    },
  });
}

export function useApplyDefaultAgentCredentialsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: applyDefaultAgentCredentials,
    onSuccess: async (_result, input) => {
      await invalidateAgentReadinessQueries(queryClient, {
        workspaceId: input.workspaceId,
        agentIds: input.agentIds,
      });
    },
  });
}

export function useWorkspaceSettingsQuery(workspaceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaceSettings.detail(
      workspaceId ?? "__missing_workspace__",
    ),
    queryFn: () => fetchWorkspaceSettings(workspaceId!),
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
  });
}

export function useWorkspaceSettingsMutation(workspaceId?: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: patchWorkspaceSettings,
    onSuccess: (settings) => {
      if (!workspaceId) return;
      // Seed the cache with the post-write value so the UI updates
      // immediately without a re-fetch.
      queryClient.setQueryData(
        queryKeys.workspaceSettings.detail(workspaceId),
        settings,
      );
    },
  });
}
