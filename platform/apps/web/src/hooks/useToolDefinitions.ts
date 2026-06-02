import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentToolGrant,
  AgentToolSettingsResponse,
  ToolDefinition as ContractToolDefinition,
  ToolPolicyTemplate,
} from "../../../../contracts/tool-definition";
import {
  applyAgentToolTemplate,
  createToolDefinition,
  deleteAgentToolGrant,
  deleteToolDefinition,
  listAgentTools,
  reorderAgentTools,
  upsertAgentToolGrant,
  updateToolDefinition,
} from "../api/generated/platform-api-client";
import { invalidateAgentToolState } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";

export type ToolDefinition = ContractToolDefinition & {
  functionName: string;
  type: string | null;
};

export type ToolDefinitionInput = {
  slug: string;
  name: string;
  description: string;
  functionName: string;
  parameters: Record<string, unknown>;
  examples?: unknown[];
  type?: string | null;
  executionKind?: string | null;
  runnerKind?: string | null;
  enabled: boolean;
};

function toUiTool(tool: ContractToolDefinition): ToolDefinition {
  return {
    ...tool,
    functionName: tool.slug.replace(/[.-]/g, "_"),
    type: null,
  };
}

function toApiInput(input: ToolDefinitionInput, workspaceId: string) {
  return {
    workspaceId,
    slug: input.slug,
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    examples: input.examples ?? [],
    executionKind: input.executionKind ?? null,
    runnerKind: input.runnerKind ?? null,
  };
}

export function useToolDefinitions(
  agentId: string,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: workspaceId
      ? queryKeys.tools.agent(agentId, workspaceId)
      : queryKeys.tools.agent(agentId, "__missing_workspace__"),
    queryFn: () => listAgentTools({ agentId, workspaceId: workspaceId! }),
    enabled: Boolean(workspaceId),
    staleTime: 10_000,
  });

  const invalidateTools = useCallback(async () => {
    if (!workspaceId) return;
    await invalidateAgentToolState(queryClient, { agentId, workspaceId });
  }, [agentId, queryClient, workspaceId]);

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onMutate: () => {
      setMutationError(null);
    },
    onError: (err) => {
      setMutationError((err as Error).message);
    },
    onSuccess: invalidateTools,
  });
  const reorderMutation = useMutation({
    mutationFn: async (orderedTools: ToolDefinition[]) => {
      await reorderAgentTools(agentId, {
        toolIds: orderedTools.map((tool) => tool.id),
      });
    },
    onMutate: () => {
      setMutationError(null);
    },
    onError: (err) => {
      setMutationError((err as Error).message);
    },
  });

  const settings = query.data;
  const agentTools = useMemo(
    () => settings?.tools.map(toUiTool) ?? [],
    [settings],
  );
  const availableTools = useMemo(
    () => settings?.availableTools.map(toUiTool) ?? [],
    [settings],
  );
  const templates = useMemo<ToolPolicyTemplate[]>(
    () => settings?.templates ?? [],
    [settings],
  );
  const grants = useMemo<AgentToolGrant[]>(
    () => settings?.grants ?? [],
    [settings],
  );
  const loading = workspaceId ? query.isLoading : false;

  const setToolSettings = useCallback(
    (settings: AgentToolSettingsResponse) => {
      if (!workspaceId) return;
      queryClient.setQueryData(
        queryKeys.tools.agent(agentId, workspaceId),
        settings,
      );
    },
    [agentId, queryClient, workspaceId],
  );

  const load = useCallback(async () => {
    setMutationError(null);
    if (!workspaceId) return;
    await query.refetch();
  }, [query, workspaceId]);

  const createTool = useCallback(
    async (input: ToolDefinitionInput) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      await mutation.mutateAsync(async () => {
        const response = await createToolDefinition(
          toApiInput(input, workspaceId),
        );
        const settings = await upsertAgentToolGrant(agentId, response.tool.id, {
          workspaceId,
          mode: "include",
        });
        setToolSettings(settings);
      });
    },
    [agentId, mutation, setToolSettings, workspaceId],
  );

  const updateTool = useCallback(
    async (toolId: string, input: ToolDefinitionInput) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      await mutation.mutateAsync(async () => {
        await updateToolDefinition(toolId, toApiInput(input, workspaceId));
      });
    },
    [mutation, workspaceId],
  );

  const deleteTool = useCallback(
    async (toolId: string) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      await mutation.mutateAsync(async () => {
        await deleteToolDefinition({ toolId, workspaceId });
      });
    },
    [mutation, workspaceId],
  );

  const assignTool = useCallback(
    async (toolId: string) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      const tool = availableTools.find((candidate) => candidate.id === toolId);
      if (!tool) throw new Error("Tool is not available");
      await mutation.mutateAsync(async () => {
        const settings = await upsertAgentToolGrant(agentId, toolId, {
          workspaceId,
          mode: "include",
        });
        setToolSettings(settings);
      });
    },
    [agentId, availableTools, mutation, setToolSettings, workspaceId],
  );

  const unassignTool = useCallback(
    async (toolId: string) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      const tool = agentTools.find((candidate) => candidate.id === toolId);
      if (!tool) throw new Error("Tool is not assigned");
      await mutation.mutateAsync(async () => {
        const settings = await upsertAgentToolGrant(agentId, toolId, {
          workspaceId,
          mode: "exclude",
        });
        setToolSettings(settings);
      });
    },
    [agentId, agentTools, mutation, setToolSettings, workspaceId],
  );

  const deleteGrant = useCallback(
    async (toolId: string) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      await mutation.mutateAsync(async () => {
        const settings = await deleteAgentToolGrant({
          agentId,
          toolId,
          workspaceId,
        });
        setToolSettings(settings);
      });
    },
    [agentId, mutation, setToolSettings, workspaceId],
  );

  const applyTemplate = useCallback(
    async (templateId: string) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      await mutation.mutateAsync(async () => {
        const settings = await applyAgentToolTemplate(agentId, templateId, {
          workspaceId,
        });
        setToolSettings(settings);
      });
    },
    [agentId, mutation, setToolSettings, workspaceId],
  );

  const reorderTools = useCallback(
    async (orderedTools: ToolDefinition[]) => {
      if (!workspaceId) throw new Error("workspaceId is required");
      const queryKey = queryKeys.tools.agent(agentId, workspaceId);
      const previousSettings =
        queryClient.getQueryData<AgentToolSettingsResponse>(queryKey);

      if (previousSettings) {
        const previousToolsById = new Map(
          previousSettings.tools.map((tool) => [tool.id, tool]),
        );
        queryClient.setQueryData<AgentToolSettingsResponse>(queryKey, {
          ...previousSettings,
          tools: orderedTools
            .map((tool) => previousToolsById.get(tool.id))
            .filter(
              (tool): tool is AgentToolSettingsResponse["tools"][number] =>
                Boolean(tool),
            ),
        });
      }

      try {
        await reorderMutation.mutateAsync(orderedTools);
      } catch (err) {
        if (previousSettings) {
          queryClient.setQueryData(queryKey, previousSettings);
        }
        throw err;
      }
    },
    [agentId, queryClient, reorderMutation, workspaceId],
  );

  const unassignedTools = useMemo(() => {
    const assignedIds = new Set(agentTools.map((tool) => tool.id));
    return availableTools.filter((tool) => !assignedIds.has(tool.id));
  }, [agentTools, availableTools]);

  return {
    agentTools,
    availableTools,
    templates,
    grants,
    unassignedTools,
    loading,
    saving: mutation.isPending || reorderMutation.isPending,
    error:
      mutationError ??
      (workspaceId ? ((query.error as Error | null)?.message ?? null) : null),
    load,
    createTool,
    updateTool,
    deleteTool,
    assignTool,
    unassignTool,
    deleteGrant,
    applyTemplate,
    reorderTools,
  };
}
