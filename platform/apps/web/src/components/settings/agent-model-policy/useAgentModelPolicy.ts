import { useEffect, useMemo, useState } from "react";

import { recordLearningProviderWarningEvent } from "../../../api/learning-memory";
import { useUpdateAgentMutation } from "../../../hooks/useAgents";
import { useResolvedCredentials } from "../../../hooks/useResolvedCredentials";
import {
  useCredentialMutations,
  useLearningMemoryStatusQuery,
  useLocalRuntimesQuery,
  useModelCatalogQueries,
} from "../../../hooks/useServerStateQueries";
import {
  LOCAL_MODEL_CODING_RUNNER_KIND,
  LOCAL_RELAY_RUNNER_KIND,
  credentialOptionsForProvider,
  credentialRefValue,
  credentialRowId,
  credentialProviderLabel,
  localCodingRunnerOptions,
  localRelayTargetForAgent,
  modelProviderForSelection,
  parseCredentialRef,
} from "../../../lib/agent-model-policy";
import { shouldShowLearningProviderWarning } from "../../../lib/learning-provider-warning";
import type { Agent } from "../../../types/agents";

type AgentModelPolicyStateArgs = {
  agent: Agent;
  refreshKey?: number;
  onSaved?: () => Promise<void> | void;
};

type ProviderChange = {
  fromProvider: string | null;
  toProvider: string | null;
};

export function useAgentModelPolicy({
  agent,
  refreshKey,
  onSaved,
}: AgentModelPolicyStateArgs) {
  const updateAgent = useUpdateAgentMutation();
  const { catalog: catalogQuery } = useModelCatalogQueries({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    refreshToken: refreshKey,
    fallbackMode: "all",
  });
  const localRuntimesQuery = useLocalRuntimesQuery(agent.workspaceId);
  const learningMemoryStatusQuery = useLearningMemoryStatusQuery(
    agent.workspaceId,
  );
  const credentialMutations = useCredentialMutations(
    agent.id,
    agent.workspaceId,
  );
  const models = catalogQuery.data?.models ?? [];
  const localRuntimes = localRuntimesQuery.data?.runtimes ?? [];
  const loadingModels =
    catalogQuery.isLoading ||
    localRuntimesQuery.isLoading ||
    catalogQuery.isFetching ||
    localRuntimesQuery.isFetching;
  const [selectedModel, setSelectedModel] = useState(agent.model ?? "");
  const [saving, setSaving] = useState(false);
  const [pendingProviderChange, setPendingProviderChange] =
    useState<ProviderChange | null>(null);
  const [localRelayTarget, setLocalRelayTarget] = useState(
    agent.provider ?? "",
  );
  const [savedLocalRelayTarget, setSavedLocalRelayTarget] = useState(
    agent.provider ?? "",
  );
  const codingOptions = useMemo(
    () => localCodingRunnerOptions(localRuntimes),
    [localRuntimes],
  );
  const {
    credentials,
    setCredentials,
    aliases,
    loadingCredentials,
    selectedRunnerKind,
    setSelectedRunnerKind,
    savedRunnerKind,
    setSavedRunnerKind,
    selectedLocalRunnerId,
    setSelectedLocalRunnerId,
    savedLocalRunnerId,
    setSavedLocalRunnerId,
    approvalPolicy,
    setApprovalPolicy,
    savedApprovalPolicy,
    setSavedApprovalPolicy,
    selectedCredentialRef,
    setSelectedCredentialRef,
    savedCredentialRef,
    setSavedCredentialRef,
    savedProvider,
    setSavedProvider,
    error,
    setError,
  } = useResolvedCredentials({ agent, refreshKey, localRuntimes });

  useEffect(() => {
    setSelectedModel(agent.model ?? "");
  }, [agent.id, agent.model]);

  useEffect(() => {
    const nextRelayTarget = localRelayTargetForAgent({
      savedProvider,
      agentProvider: agent.provider,
    });
    setLocalRelayTarget(nextRelayTarget);
    setSavedLocalRelayTarget(nextRelayTarget);
  }, [agent.id, agent.provider, savedProvider]);

  const selectedProvider = modelProviderForSelection(selectedModel, models);
  const selectedCredentialOptions = credentialOptionsForProvider(
    selectedProvider,
    credentials,
    aliases,
  );
  const selectedCredentialOptionValues = new Set(
    selectedCredentialOptions.map((option) => option.value),
  );
  const isCodingAgent = agent.agentType === "coding";
  const localCodingSelected =
    isCodingAgent && selectedRunnerKind === LOCAL_MODEL_CODING_RUNNER_KIND;
  const localRelaySelected = selectedRunnerKind === LOCAL_RELAY_RUNNER_KIND;
  const selectedCodingOption =
    codingOptions.find((option) => option.id === selectedLocalRunnerId) ?? null;
  const selectedCodingRunner = selectedCodingOption?.runner ?? null;
  const credentialSelectionRequired =
    !localCodingSelected &&
    !localRelaySelected &&
    Boolean(selectedProvider) &&
    selectedCredentialOptions.length > 1;
  const canSaveCredentialReference =
    localCodingSelected ||
    localRelaySelected ||
    !selectedProvider ||
    selectedCredentialOptionValues.has(selectedCredentialRef);
  const canSaveLocalCoding =
    !localCodingSelected || Boolean(selectedCodingRunner);
  const canSaveLocalRelay =
    !localRelaySelected || localRelayTarget.trim().length > 0;
  const dirty =
    selectedModel !== (agent.model ?? "") ||
    selectedCredentialRef !== savedCredentialRef ||
    selectedRunnerKind !== savedRunnerKind ||
    selectedLocalRunnerId !== savedLocalRunnerId ||
    approvalPolicy !== savedApprovalPolicy ||
    localRelayTarget !== savedLocalRelayTarget;

  useEffect(() => {
    if (localCodingSelected) return;
    if (!selectedProvider || selectedCredentialRef) return;
    const matchingCredentials = credentials.filter(
      (credential) => credential.provider === selectedProvider,
    );
    const credential = matchingCredentials[0];
    if (matchingCredentials.length === 1 && credential) {
      setSelectedCredentialRef(`credential_id:${credentialRowId(credential)}`);
    }
  }, [
    credentials,
    localCodingSelected,
    selectedCredentialRef,
    selectedProvider,
    setSelectedCredentialRef,
  ]);

  const catalogOptions = models.map((model) => ({
    value: model.id,
    label: `${model.name} (${model.providerName ?? model.provider})`,
  }));
  const modelOptions = [...catalogOptions];
  const selectedModelAvailable = modelOptions.some(
    (option) => option.value === selectedModel,
  );

  if ((!selectedModel || !selectedModelAvailable) && modelOptions.length > 0) {
    modelOptions.unshift({ value: "", label: "Select a model..." });
  }

  const showNoModelsState =
    modelOptions.length === 0 && !(isCodingAgent && codingOptions.length > 0);
  const disableSave =
    !dirty ||
    !canSaveCredentialReference ||
    !canSaveLocalCoding ||
    !canSaveLocalRelay ||
    learningMemoryStatusQuery.isLoading ||
    learningMemoryStatusQuery.isFetching ||
    learningMemoryStatusQuery.isError;

  const applyModelSelection = (modelId: string) => {
    setSelectedModel(modelId);
    const provider = modelProviderForSelection(modelId, models);
    if (!provider) {
      setSelectedCredentialRef("");
      return;
    }

    const matchingCredentials = credentials.filter(
      (credential) => credential.provider === provider,
    );
    const credential = matchingCredentials[0];
    if (matchingCredentials.length === 1 && credential) {
      setSelectedCredentialRef(`credential_id:${credentialRowId(credential)}`);
      return;
    }
    setSelectedCredentialRef("");
  };

  const applyLocalRunnerSelection = (runnerId: string) => {
    const option =
      codingOptions.find((candidate) => candidate.id === runnerId) ?? null;
    setSelectedRunnerKind(LOCAL_MODEL_CODING_RUNNER_KIND);
    setSelectedLocalRunnerId(runnerId);
    setSelectedModel(option?.runner.model ?? "");
    setSelectedCredentialRef("");
  };

  const handleRunnerKindChange = (runnerKind: string) => {
    setSelectedRunnerKind(runnerKind);
    if (runnerKind !== LOCAL_MODEL_CODING_RUNNER_KIND) {
      setSelectedLocalRunnerId("");
    }
    if (runnerKind !== LOCAL_RELAY_RUNNER_KIND) {
      setLocalRelayTarget("");
    }
  };

  const recordProviderWarningEvent = (
    action: "shown" | "cancelled" | "confirmed",
    providerChange: ProviderChange,
  ) => {
    if (!agent.workspaceId) return;
    void recordLearningProviderWarningEvent({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      fromProvider: providerChange.fromProvider,
      toProvider: providerChange.toProvider,
      action,
    }).catch(() => undefined);
  };

  const persistChanges = async () => {
    if (
      !dirty ||
      !canSaveCredentialReference ||
      !canSaveLocalCoding ||
      !canSaveLocalRelay
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const nextRunnerKind = localCodingSelected
        ? LOCAL_MODEL_CODING_RUNNER_KIND
        : selectedRunnerKind;
      const nextModel = localCodingSelected
        ? (selectedCodingRunner?.model ?? selectedModel)
        : localRelaySelected
          ? null
          : selectedModel;
      const nextProvider = localCodingSelected
        ? (selectedCodingRunner?.provider ?? "openai_compatible")
        : localRelaySelected
          ? localRelayTarget.trim() || null
          : selectedProvider;
      const nextCredentialRef =
        localCodingSelected || localRelaySelected
          ? null
          : parseCredentialRef(selectedCredentialRef);

      if (agent.workspaceId) {
        const response = await credentialMutations.saveReference.mutateAsync({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          runnerKind: nextRunnerKind,
          provider: nextProvider,
          model: nextModel ?? null,
          localModelId: localCodingSelected ? selectedLocalRunnerId : null,
          localEndpointUrl: localCodingSelected
            ? selectedCodingRunner?.endpoint?.trim() || null
            : null,
          credentialRef: nextCredentialRef,
        });
        const refValue = credentialRefValue(response.reference.credentialRef);
        setCredentials(response.credentials);
        setSelectedCredentialRef(refValue);
        setSavedCredentialRef(refValue);
        setSavedRunnerKind(response.reference.runnerKind);
        setSavedProvider(response.reference.provider ?? null);
        setSavedLocalRunnerId(localCodingSelected ? selectedLocalRunnerId : "");
        setSavedApprovalPolicy(approvalPolicy);
        const nextRelayTarget = response.reference.provider ?? "";
        setLocalRelayTarget(nextRelayTarget);
        setSavedLocalRelayTarget(nextRelayTarget);
      }

      await updateAgent.mutateAsync({
        agentId: agent.id,
        patch: {
          model: nextModel || null,
          localModelCoding:
            agent.agentType === "coding"
              ? {
                  enabled: localCodingSelected,
                  localModelId: localCodingSelected
                    ? selectedLocalRunnerId
                    : null,
                  approvalPolicy,
                  workspaceWrite: localCodingSelected,
                }
              : undefined,
        },
      });
      await onSaved?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (
      learningMemoryStatusQuery.isLoading ||
      learningMemoryStatusQuery.isFetching ||
      learningMemoryStatusQuery.isError
    ) {
      return;
    }

    const nextProvider = localCodingSelected
      ? (selectedCodingRunner?.provider ?? "openai_compatible")
      : localRelaySelected
        ? localRelayTarget.trim() || null
        : selectedProvider;
    const providerChange = {
      fromProvider: savedProvider,
      toProvider: nextProvider,
    };
    if (
      shouldShowLearningProviderWarning({
        learningEnabled:
          learningMemoryStatusQuery.data?.learningEnabled ?? false,
        hasEmbeddedMemories:
          learningMemoryStatusQuery.data?.hasEmbeddedMemories ?? false,
        ...providerChange,
      })
    ) {
      setPendingProviderChange(providerChange);
      recordProviderWarningEvent("shown", providerChange);
      return;
    }

    await persistChanges();
  };

  const resetChanges = () => {
    setSelectedModel(agent.model ?? "");
    setSelectedRunnerKind(savedRunnerKind);
    setSelectedLocalRunnerId(savedLocalRunnerId);
    setApprovalPolicy(savedApprovalPolicy);
    setSelectedCredentialRef(savedCredentialRef);
    setLocalRelayTarget(savedLocalRelayTarget);
  };

  const cancelPendingProviderChange = () => {
    if (!pendingProviderChange) return;
    recordProviderWarningEvent("cancelled", pendingProviderChange);
    setPendingProviderChange(null);
  };

  const confirmPendingProviderChange = async () => {
    if (!pendingProviderChange) return;
    recordProviderWarningEvent("confirmed", pendingProviderChange);
    setPendingProviderChange(null);
    await persistChanges();
  };

  return {
    approvalPolicy,
    cancelPendingProviderChange,
    codingOptions,
    confirmPendingProviderChange,
    credentialProviderLabel: credentialProviderLabel(selectedProvider),
    credentialSelectionRequired,
    dirty,
    disableSave,
    error,
    handleRunnerKindChange,
    handleSave,
    isCodingAgent,
    loadingCredentials,
    loadingModels,
    localCodingSelected,
    localRelaySelected,
    localRelayTarget,
    modelOptions,
    pendingProviderChange,
    resetChanges,
    saving,
    selectedCodingOption,
    selectedCredentialOptions,
    selectedCredentialRef,
    selectedLocalRunnerId,
    selectedModel,
    selectedModelAvailable,
    selectedProvider,
    selectedRunnerKind,
    setApprovalPolicy,
    setLocalRelayTarget,
    setSelectedCredentialRef,
    showNoModelsState,
    applyLocalRunnerSelection,
    applyModelSelection,
  };
}
