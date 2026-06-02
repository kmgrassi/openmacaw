import { useMutation, useQuery } from "@tanstack/react-query";

import { invalidateAgentData, queryStaleTimes } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import {
  fetchAgentHealth,
  fetchSetup,
  fetchSetupAuthState,
  updateDefaultAgentAssignment,
} from "../api/setup";
import {
  getAgentRuntimeProfile,
  updateAgentRuntimeProfile,
} from "../api/stored-agents";
import type { AgentRuntimeProfile } from "../../../../contracts/agents";
import type { DefaultAgentAssignmentUpdateRequest } from "../../../../contracts/setup";

export function useSetupAuthStateQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.auth.state(),
    queryFn: fetchSetupAuthState,
    enabled,
  });
}

export function useSetupByAgentQuery(agentId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.setup.byAgent(agentId ?? "none"),
    queryFn: () => fetchSetup(agentId ?? ""),
    enabled: Boolean(agentId),
  });
}

export function useAgentHealthQuery(agentId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.agentHealth.detail(agentId ?? "none"),
    queryFn: () => fetchAgentHealth(agentId ?? ""),
    enabled: Boolean(agentId),
    staleTime: queryStaleTimes.runtime,
    retry: false,
  });
}

export function useAgentRuntimeProfileQuery(
  agentId: string | null | undefined,
  workspaceId: string | null | undefined,
) {
  return useQuery({
    queryKey: queryKeys.agents.runtimeProfile(
      agentId ?? "none",
      workspaceId ?? "none",
    ),
    queryFn: () => getAgentRuntimeProfile(agentId ?? "", workspaceId),
    enabled: Boolean(agentId && workspaceId),
  });
}

export function useUpdateDefaultAgentAssignmentMutation() {
  return useMutation({
    mutationFn: (input: DefaultAgentAssignmentUpdateRequest) =>
      updateDefaultAgentAssignment(input),
    onSuccess: async (_auth, variables) => {
      await invalidateAgentData({
        agentId: variables.agentId,
        workspaceId: variables.workspaceId,
      });
    },
  });
}

export function useUpdateAgentRuntimeProfileMutation(agentId: string) {
  return useMutation({
    mutationFn: (input: Parameters<typeof updateAgentRuntimeProfile>[1]) =>
      updateAgentRuntimeProfile(agentId, input),
    onSuccess: async (profile: AgentRuntimeProfile) => {
      await invalidateAgentData({
        agentId,
        workspaceId: profile.workspaceId,
      });
    },
  });
}
