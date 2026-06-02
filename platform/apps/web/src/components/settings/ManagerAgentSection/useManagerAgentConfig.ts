import { useCallback, useEffect, useState } from "react";
import type { ManagerAgentConfigResponse } from "../../../../../../contracts/manager-agent";
import type { ManagerAgentConfigRequest } from "../../../../../../contracts/manager-agent";
import {
  useManagerConfigQuery,
  usePlansQuery,
  useUpdateManagerConfigMutation,
} from "../../../api/query-hooks";
import { dueTaskHasOverride, MANAGER_STATES, type ManagerState } from "./utils";

type UseManagerAgentConfigArgs = {
  workspaceId: string | null;
  agentId: string | null;
};

export function useManagerAgentConfig({
  workspaceId,
  agentId,
}: UseManagerAgentConfigArgs) {
  const [selectedConfigAgentId, setSelectedConfigAgentId] = useState("");
  const [config, setConfig] = useState<ManagerAgentConfigResponse | null>(null);
  const [appliedConfigAgentId, setAppliedConfigAgentId] = useState<
    string | null
  >(null);
  const [formDirty, setFormDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState(false);
  const [cadenceMode, setCadenceMode] = useState<"workspace" | "override">(
    "workspace",
  );
  const [overrideCadenceMs, setOverrideCadenceMs] = useState("60000");
  const [statesMode, setStatesMode] = useState<"workspace" | "override">(
    "workspace",
  );
  const [selectedStates, setSelectedStates] = useState<ManagerState[]>([
    "running",
    "awaiting_review",
  ]);
  const [plansMode, setPlansMode] = useState<"workspace" | "override">(
    "workspace",
  );
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const plansQuery = usePlansQuery(workspaceId);
  const configQuery = useManagerConfigQuery(workspaceId, selectedConfigAgentId);
  const updateConfigMutation = useUpdateManagerConfigMutation(
    workspaceId,
    selectedConfigAgentId,
  );
  const plans = plansQuery.data ?? [];

  const applyConfigToForm = useCallback(
    (nextConfig: ManagerAgentConfigResponse) => {
      setConfig(nextConfig);
      setAppliedConfigAgentId(nextConfig.agentId);
      setFormDirty(false);
      setCadenceMode(nextConfig.cadenceMs === null ? "workspace" : "override");
      setOverrideCadenceMs(
        String(
          nextConfig.cadenceMs ??
            nextConfig.workspaceCadenceMs ??
            nextConfig.effectiveCadenceMs,
        ),
      );
      setStatesMode(
        dueTaskHasOverride(nextConfig.dueTaskQuery, "states")
          ? "override"
          : "workspace",
      );
      setSelectedStates(
        (
          (nextConfig.dueTaskQuery.states ??
            nextConfig.effectiveDueTaskQuery.states ?? [
              "running",
              "awaiting_review",
            ]) as ManagerState[]
        ).filter((state) => MANAGER_STATES.includes(state)),
      );
      setPlansMode(
        dueTaskHasOverride(nextConfig.dueTaskQuery, "planIds")
          ? "override"
          : "workspace",
      );
      setSelectedPlanIds(
        nextConfig.dueTaskQuery.planIds ??
          nextConfig.effectiveDueTaskQuery.planIds ??
          [],
      );
    },
    [],
  );

  useEffect(() => {
    const nextConfig = configQuery.data;
    if (nextConfig) {
      setConfig(nextConfig);
      setConfigError(null);
      if (!formDirty || nextConfig.agentId !== appliedConfigAgentId) {
        applyConfigToForm(nextConfig);
      }
      return;
    }
    if (!selectedConfigAgentId) {
      setConfig(null);
      setAppliedConfigAgentId(null);
      setFormDirty(false);
    }
  }, [
    appliedConfigAgentId,
    applyConfigToForm,
    configQuery.data,
    formDirty,
    selectedConfigAgentId,
  ]);

  useEffect(() => {
    const queryError = configQuery.error ?? plansQuery.error;
    if (queryError) {
      setConfigError((queryError as Error).message);
      if (configQuery.error) setConfig(null);
    }
  }, [configQuery.error, plansQuery.error]);

  useEffect(() => {
    if (!selectedConfigAgentId && agentId) {
      setSelectedConfigAgentId(agentId);
    }
  }, [agentId, selectedConfigAgentId]);

  const handleSelectedConfigAgentIdChange = useCallback(
    (nextAgentId: string) => {
      setSelectedConfigAgentId(nextAgentId);
      setConfig(null);
      setConfigError(null);
      setAppliedConfigAgentId(null);
      setFormDirty(false);
    },
    [],
  );

  const updateCadenceMode = useCallback((mode: "workspace" | "override") => {
    setCadenceMode(mode);
    setFormDirty(true);
  }, []);

  const updateOverrideCadenceMs = useCallback((cadenceMs: string) => {
    setOverrideCadenceMs(cadenceMs);
    setFormDirty(true);
  }, []);

  const updateStatesMode = useCallback((mode: "workspace" | "override") => {
    setStatesMode(mode);
    setFormDirty(true);
  }, []);

  const updatePlansMode = useCallback((mode: "workspace" | "override") => {
    setPlansMode(mode);
    setFormDirty(true);
  }, []);

  const updateSelectedPlanIds = useCallback((planIds: string[]) => {
    setSelectedPlanIds(planIds);
    setFormDirty(true);
  }, []);

  const toggleState = (state: ManagerState) => {
    setFormDirty(true);
    setSelectedStates((current) =>
      current.includes(state)
        ? current.filter((candidate) => candidate !== state)
        : [...current, state],
    );
  };

  const saveConfigPatch = useCallback(
    async (
      request: ManagerAgentConfigRequest,
      targetAgentId = selectedConfigAgentId,
    ) => {
      if (!workspaceId || !targetAgentId) return null;
      const response = await updateConfigMutation.mutateAsync({
        request,
        targetAgentId,
      });
      applyConfigToForm(response);
      return response;
    },
    [
      applyConfigToForm,
      selectedConfigAgentId,
      updateConfigMutation,
      workspaceId,
    ],
  );

  const handleConfigSave = async () => {
    if (!workspaceId || !selectedConfigAgentId) return;

    setConfigSaving(true);
    setConfigError(null);
    setConfigSuccess(false);
    try {
      await saveConfigPatch({
        cadenceMs:
          cadenceMode === "workspace" ? null : Number(overrideCadenceMs),
        dueTaskQuery: {
          states: statesMode === "workspace" ? null : selectedStates,
          planIds: plansMode === "workspace" ? null : selectedPlanIds,
        },
      });
      setConfigSuccess(true);
      setTimeout(() => setConfigSuccess(false), 3000);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigSaving(false);
    }
  };

  const planOptions = plans.map((plan) => ({
    value: plan.id,
    label: plan.name || "Untitled plan",
  }));

  const canSaveConfig =
    Boolean(workspaceId && selectedConfigAgentId && config) &&
    (statesMode === "workspace" || selectedStates.length > 0) &&
    (plansMode === "workspace" || selectedPlanIds.length > 0);

  return {
    selectedConfigAgentId,
    setSelectedConfigAgentId: handleSelectedConfigAgentIdChange,
    plans,
    config,
    configLoading: configQuery.isLoading || plansQuery.isLoading,
    configSaving,
    configError,
    configSuccess,
    cadenceMode,
    setCadenceMode: updateCadenceMode,
    overrideCadenceMs,
    setOverrideCadenceMs: updateOverrideCadenceMs,
    statesMode,
    setStatesMode: updateStatesMode,
    selectedStates,
    plansMode,
    setPlansMode: updatePlansMode,
    selectedPlanIds,
    setSelectedPlanIds: updateSelectedPlanIds,
    toggleState,
    saveConfigPatch,
    handleConfigSave,
    planOptions,
    canSaveConfig,
  };
}
