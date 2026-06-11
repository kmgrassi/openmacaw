import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ManagerAgentConfigRequest } from "../../../../contracts/manager-agent";
import {
  fetchManagerAgentConfig,
  fetchManagerRuntimeStatus,
  updateManagerAgentConfig,
} from "./manager-agent";
import {
  createPlan,
  deletePlan,
  deleteWorkItem,
  listPlans,
  listWorkItems,
  type PlanDraft,
} from "./plans";
import {
  cancelScheduledTask,
  listScheduledTasks,
  runScheduledTaskNow,
} from "./scheduled-tasks";
import {
  invalidateManagerWorkspace,
  invalidatePlansAndWorkItems,
} from "./query-invalidation";
import { queryKeys } from "./query-keys";
import {
  listWorkItemCutovers,
  listWorkspaceRecentCutovers,
} from "./provider-cutovers";
import {
  snoozeWorkItem,
  wakeWorkItem,
  type SnoozeWorkItemInput,
} from "./work-items";

export function usePlansQuery(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.plans.list(workspaceId ?? ""),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await listPlans(workspaceId);
      return response.plans;
    },
    enabled: Boolean(workspaceId),
  });
}

export function useWorkItemsQuery(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.workItems.list(workspaceId ?? ""),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await listWorkItems(workspaceId);
      return response.workItems;
    },
    enabled: Boolean(workspaceId),
  });
}

export function useWorkItemCutoversQuery(
  workItemId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.workItems.cutover(workItemId ?? ""),
    queryFn: async () => {
      if (!workItemId) return [];
      const response = await listWorkItemCutovers(workItemId);
      return response.cutovers;
    },
    enabled: Boolean(workItemId) && (options.enabled ?? true),
  });
}

export function useWorkspaceRecentCutoversQuery(
  workspaceId: string | null | undefined,
  options: { enabled?: boolean; limit?: number } = {},
) {
  const limit = options.limit ?? 250;
  return useQuery({
    queryKey: queryKeys.workItems.recentCutovers(workspaceId ?? "", limit),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await listWorkspaceRecentCutovers(workspaceId, {
        limit,
      });
      return response.items;
    },
    enabled: Boolean(workspaceId) && (options.enabled ?? true),
  });
}

export function useCreatePlanMutation(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: PlanDraft) => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return createPlan(workspaceId, draft);
    },
    onSuccess: async () => {
      if (!workspaceId) return;
      await invalidatePlansAndWorkItems(queryClient, workspaceId);
      await invalidateManagerWorkspace(queryClient, workspaceId);
    },
  });
}

export function useDeletePlanMutation(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return deletePlan(workspaceId, planId);
    },
    onSuccess: async () => {
      if (!workspaceId) return;
      await invalidatePlansAndWorkItems(queryClient, workspaceId);
      await invalidateManagerWorkspace(queryClient, workspaceId);
    },
  });
}

export function useDeleteWorkItemMutation(
  workspaceId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return deleteWorkItem(workspaceId, workItemId);
    },
    onSuccess: async () => {
      if (!workspaceId) return;
      await invalidatePlansAndWorkItems(queryClient, workspaceId);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.manager.status(workspaceId),
      });
    },
  });
}

export function useSnoozeWorkItemMutation(
  workspaceId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workItemId,
      input,
    }: {
      workItemId: string;
      input: SnoozeWorkItemInput;
    }) => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return snoozeWorkItem(workspaceId, workItemId, input);
    },
    onSuccess: async () => {
      if (!workspaceId) return;
      await invalidatePlansAndWorkItems(queryClient, workspaceId);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.manager.status(workspaceId),
      });
    },
  });
}

export function useWakeWorkItemMutation(
  workspaceId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return wakeWorkItem(workspaceId, workItemId);
    },
    onSuccess: async () => {
      if (!workspaceId) return;
      await invalidatePlansAndWorkItems(queryClient, workspaceId);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.manager.status(workspaceId),
      });
    },
  });
}

export function useManagerStatusQuery(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.manager.status(workspaceId ?? ""),
    queryFn: () => {
      if (!workspaceId) throw new Error("Workspace context is required.");
      return fetchManagerRuntimeStatus(workspaceId);
    },
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
}

export function useManagerConfigQuery(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return useQuery({
    queryKey: queryKeys.manager.config(workspaceId ?? "", agentId ?? ""),
    queryFn: () => {
      if (!workspaceId || !agentId) {
        throw new Error("Workspace and agent are required.");
      }
      return fetchManagerAgentConfig(workspaceId, agentId);
    },
    enabled: Boolean(workspaceId && agentId),
  });
}

export function useUpdateManagerConfigMutation(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      targetAgentId,
    }: {
      request: ManagerAgentConfigRequest;
      targetAgentId?: string;
    }) => {
      const resolvedAgentId = targetAgentId ?? agentId;
      if (!workspaceId || !resolvedAgentId) {
        throw new Error("Workspace and manager agent are required.");
      }
      return updateManagerAgentConfig(workspaceId, resolvedAgentId, request);
    },
    onSuccess: async (_response, variables) => {
      if (!workspaceId) return;
      await invalidateManagerWorkspace(
        queryClient,
        workspaceId,
        variables.targetAgentId ?? agentId,
      );
    },
  });
}

export function useScheduledTasksQuery(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.list(workspaceId ?? "", agentId ?? ""),
    queryFn: () => {
      if (!workspaceId || !agentId) {
        throw new Error("Workspace and agent are required.");
      }
      return listScheduledTasks(workspaceId, agentId);
    },
    enabled: Boolean(workspaceId && agentId),
  });
}

export function useCancelScheduledTaskMutation(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduledTaskId: string) => {
      if (!workspaceId || !agentId) {
        throw new Error("Workspace and agent are required.");
      }
      return cancelScheduledTask({
        workspaceId,
        agentId,
        scheduledTaskId,
        reason: "Canceled from manager settings",
      });
    },
    onSuccess: async () => {
      if (!workspaceId || !agentId) return;
      await invalidateManagerWorkspace(queryClient, workspaceId, agentId);
    },
  });
}

export function useRunScheduledTaskNowMutation(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduledTaskId: string) => {
      if (!workspaceId || !agentId) {
        throw new Error("Workspace and agent are required.");
      }
      return runScheduledTaskNow({
        workspaceId,
        agentId,
        scheduledTaskId,
      });
    },
    onSuccess: async () => {
      if (!workspaceId || !agentId) return;
      await invalidateManagerWorkspace(queryClient, workspaceId, agentId);
    },
  });
}
