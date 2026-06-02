import type { Agent } from "../../types/agents";
import { AgentModelPolicyCard } from "./agent-model-policy/AgentModelPolicyCard";
import { useAgentModelPolicy } from "./agent-model-policy/useAgentModelPolicy";

type AgentModelPolicyProps = {
  agent: Agent;
  refreshKey?: number;
  onSaved?: () => Promise<void> | void;
};

export function AgentModelPolicy({
  agent,
  refreshKey,
  onSaved,
}: AgentModelPolicyProps) {
  const policy = useAgentModelPolicy({ agent, refreshKey, onSaved });

  return (
    <AgentModelPolicyCard
      workspaceId={agent.workspaceId}
      approvalPolicy={policy.approvalPolicy}
      codingOptions={policy.codingOptions}
      credentialProviderLabel={policy.credentialProviderLabel}
      credentialSelectionRequired={policy.credentialSelectionRequired}
      dirty={policy.dirty}
      disableSave={policy.disableSave}
      error={policy.error}
      isCodingAgent={policy.isCodingAgent}
      loadingCredentials={policy.loadingCredentials}
      loadingModels={policy.loadingModels}
      localCodingSelected={policy.localCodingSelected}
      localRelaySelected={policy.localRelaySelected}
      localRelayTarget={policy.localRelayTarget}
      modelOptions={policy.modelOptions}
      pendingProviderChange={policy.pendingProviderChange}
      saving={policy.saving}
      selectedCodingOption={policy.selectedCodingOption}
      selectedCredentialOptions={policy.selectedCredentialOptions}
      selectedCredentialRef={policy.selectedCredentialRef}
      selectedLocalRunnerId={policy.selectedLocalRunnerId}
      selectedModel={policy.selectedModel}
      selectedModelAvailable={policy.selectedModelAvailable}
      selectedProvider={policy.selectedProvider}
      selectedRunnerKind={policy.selectedRunnerKind}
      showNoModelsState={policy.showNoModelsState}
      onApprovalPolicyChange={policy.setApprovalPolicy}
      onCancelPendingProviderChange={policy.cancelPendingProviderChange}
      onConfirmPendingProviderChange={policy.confirmPendingProviderChange}
      onCredentialRefChange={policy.setSelectedCredentialRef}
      onLocalRelayTargetChange={policy.setLocalRelayTarget}
      onLocalRunnerIdChange={policy.applyLocalRunnerSelection}
      onModelChange={policy.applyModelSelection}
      onReset={policy.resetChanges}
      onRunnerKindChange={policy.handleRunnerKindChange}
      onSave={policy.handleSave}
    />
  );
}
