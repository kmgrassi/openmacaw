import { useEffect, useMemo, useState } from "react";
import {
  useToolDefinitions,
  type ToolDefinition,
} from "../../../hooks/useToolDefinitions";
import { useLocalRuntimesQuery } from "../../../hooks/useServerStateQueries";
import { bundleIdsForTool, sourceLabel } from "./utils";

export function useToolAssignments(
  agentId: string,
  workspaceId?: string | null,
) {
  const {
    agentTools,
    availableTools,
    templates,
    grants,
    loading,
    saving,
    error,
    assignTool,
    unassignTool,
    deleteGrant,
    applyTemplate,
    load,
  } = useToolDefinitions(agentId, workspaceId);
  const [draftAssignedIds, setDraftAssignedIds] = useState<Set<string>>(
    new Set(),
  );
  const [search, setSearch] = useState("");
  const [bundleFilter, setBundleFilter] = useState("");
  const [previewToolId, setPreviewToolId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const localRuntimesQuery = useLocalRuntimesQuery(workspaceId);

  const initialAssignedIds = useMemo(
    () => new Set(agentTools.map((tool) => tool.id)),
    [agentTools],
  );
  const grantsByToolId = useMemo(
    () => new Map(grants.map((grant) => [grant.toolId, grant])),
    [grants],
  );
  const allToolsById = useMemo(
    () => new Map(availableTools.map((tool) => [tool.id, tool])),
    [availableTools],
  );
  const excludedGrantTools = useMemo(
    () =>
      grants
        .filter((grant) => grant.mode === "exclude")
        .map((grant) => allToolsById.get(grant.toolId))
        .filter((tool): tool is ToolDefinition => Boolean(tool))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    [allToolsById, grants],
  );

  const localExecutionReady = useMemo(
    () =>
      localRuntimesQuery.data?.runtimes.some(
        (runtime) => runtime.localExecution.registered,
      ) ?? false,
    [localRuntimesQuery.data],
  );
  const localExecutionLoading = workspaceId
    ? localRuntimesQuery.isLoading
    : false;

  useEffect(() => {
    if (loading) return;
    setDraftAssignedIds(new Set(agentTools.map((tool) => tool.id)));
  }, [agentTools, loading]);

  const draftTools = useMemo(
    () =>
      Array.from(draftAssignedIds)
        .map((toolId) => allToolsById.get(toolId))
        .filter((tool): tool is ToolDefinition => Boolean(tool))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    [allToolsById, draftAssignedIds],
  );

  const addedTools = useMemo(
    () => draftTools.filter((tool) => !initialAssignedIds.has(tool.id)),
    [draftTools, initialAssignedIds],
  );

  const excludedTools = useMemo(
    () => agentTools.filter((tool) => !draftAssignedIds.has(tool.id)),
    [agentTools, draftAssignedIds],
  );

  const filteredCatalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    return availableTools
      .filter((tool) => !draftAssignedIds.has(tool.id))
      .filter((tool) => {
        if (!query) return true;
        return `${tool.slug} ${tool.name} ${tool.description}`
          .toLowerCase()
          .includes(query);
      })
      .filter((tool) => {
        if (!bundleFilter) return true;
        return bundleIdsForTool(tool).includes(bundleFilter);
      });
  }, [availableTools, bundleFilter, draftAssignedIds, search]);

  const dirty = addedTools.length > 0 || excludedTools.length > 0;

  const addTool = (toolId: string) => {
    setDraftAssignedIds((current) => new Set(current).add(toolId));
    setPreviewToolId(toolId);
    setConfirmation(null);
  };

  const removeTool = (toolId: string) => {
    setDraftAssignedIds((current) => {
      const next = new Set(current);
      next.delete(toolId);
      return next;
    });
    setConfirmation(null);
  };

  const resetDraft = () => {
    setDraftAssignedIds(new Set(agentTools.map((tool) => tool.id)));
    setActionError(null);
    setConfirmation(null);
  };

  const saveChanges = async () => {
    if (!workspaceId) return;
    setActionError(null);
    setConfirmation(null);
    const nextAssignedIds = draftAssignedIds;
    const toAdd = Array.from(nextAssignedIds).filter(
      (toolId) => !initialAssignedIds.has(toolId),
    );
    const toRemove = Array.from(initialAssignedIds).filter(
      (toolId) => !nextAssignedIds.has(toolId),
    );

    try {
      for (const toolId of toAdd) {
        await assignTool(toolId);
      }
      for (const toolId of toRemove) {
        await unassignTool(toolId);
      }
      await load();
      setConfirmation("Tool grants saved.");
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const applyTemplateGrant = async (templateId: string) => {
    setActionError(null);
    setConfirmation(null);
    try {
      await applyTemplate(templateId);
      setConfirmation("Tool template applied.");
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const removeGrant = async (toolId: string) => {
    setActionError(null);
    setConfirmation(null);
    try {
      await deleteGrant(toolId);
      setConfirmation("Tool grant removed.");
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const isLocalCodingToolBlocked = (toolId: string) => {
    const tool = allToolsById.get(toolId);
    if (!tool || localExecutionReady) return false;
    return (
      tool.runnerKind === "local_model_coding" ||
      tool.slug === "shell.exec" ||
      tool.slug === "apply_patch"
    );
  };

  const sourceForTool = (toolId: string) => {
    const tool = allToolsById.get(toolId);
    if (!tool) return "resolved";
    return sourceLabel(
      tool,
      initialAssignedIds,
      draftAssignedIds,
      grantsByToolId,
    );
  };

  return {
    allToolsById,
    templates,
    loading,
    saving,
    error,
    actionError,
    confirmation,
    localExecutionReady,
    localExecutionLoading,
    search,
    setSearch,
    bundleFilter,
    setBundleFilter,
    previewToolId,
    setPreviewToolId,
    draftTools,
    addedTools,
    excludedTools,
    excludedGrantTools,
    filteredCatalog,
    dirty,
    addTool,
    removeTool,
    resetDraft,
    saveChanges,
    applyTemplateGrant,
    removeGrant,
    isLocalCodingToolBlocked,
    sourceForTool,
  };
}
