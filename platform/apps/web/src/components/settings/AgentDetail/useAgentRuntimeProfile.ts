import { useEffect, useState } from "react";
import {
  useAgentRuntimeProfileQuery,
  useUpdateAgentRuntimeProfileMutation,
} from "../../../hooks/useSetupQueries";
import type { Agent } from "../../../types/agents";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import type { ModelTierFloor } from "../../../../../../contracts/model-tiers";
import { HOSTED_RUNTIME_PROVIDERS } from "./constants";

type UseAgentRuntimeProfileArgs = {
  agent: Agent;
  workspaceId: string | null | undefined;
  onError: (message: string) => void;
  onClearError: () => void;
  onSaved: () => Promise<void>;
};

type RuntimeProfileSaveInput = {
  provider: AgentRuntimeProfile["provider"];
  model: string;
  credentialRef?: AgentRuntimeProfile["credentialRef"];
  fallbacks?: AgentRuntimeProfile["fallbacks"];
  modelTierFloor?: ModelTierFloor;
  localEndpointUrl?: string | null;
};

export function useAgentRuntimeProfile({
  agent,
  workspaceId,
  onError,
  onClearError,
  onSaved,
}: UseAgentRuntimeProfileArgs) {
  const profileWorkspaceId = agent.workspaceId ?? workspaceId;
  const runtimeProfileQuery = useAgentRuntimeProfileQuery(
    agent.id,
    profileWorkspaceId,
  );
  const updateRuntimeProfile = useUpdateAgentRuntimeProfileMutation(agent.id);
  const runtimeProfile = runtimeProfileQuery.data ?? null;
  const [runtimeProvider, setRuntimeProvider] = useState<
    AgentRuntimeProfile["provider"]
  >(
    (agent.provider as AgentRuntimeProfile["provider"] | undefined) ?? "openai",
  );
  const [runtimeModel, setRuntimeModel] = useState(agent.model ?? "");
  const [runtimeFallbacks, setRuntimeFallbacks] = useState<
    AgentRuntimeProfile["fallbacks"]
  >([]);
  const [runtimeModelTierFloor, setRuntimeModelTierFloor] =
    useState<ModelTierFloor>("any");

  useEffect(() => {
    if (runtimeProfile) {
      setRuntimeProvider(runtimeProfile.provider);
      setRuntimeModel(runtimeProfile.model);
      setRuntimeFallbacks(runtimeProfile.fallbacks);
      setRuntimeModelTierFloor(runtimeProfile.modelTierFloor);
      return;
    }
    setRuntimeProvider(
      (agent.provider as AgentRuntimeProfile["provider"] | undefined) ??
        "openai",
    );
    setRuntimeModel(agent.model ?? "");
    setRuntimeFallbacks([]);
    setRuntimeModelTierFloor("any");
  }, [agent.id, agent.model, agent.provider, runtimeProfile]);

  useEffect(() => {
    if (runtimeProfileQuery.error) {
      onError(String(runtimeProfileQuery.error));
    }
  }, [runtimeProfileQuery.error, onError]);

  const loadRuntimeProfile = async () => {
    const result = await runtimeProfileQuery.refetch();
    const profile = result.data;
    if (profile) {
      setRuntimeProvider(profile.provider);
      setRuntimeModel(profile.model);
      setRuntimeFallbacks(profile.fallbacks);
      setRuntimeModelTierFloor(profile.modelTierFloor);
    }
  };

  const saveRuntimeProfile = async (input?: RuntimeProfileSaveInput) => {
    if (!profileWorkspaceId) {
      onError("Workspace context is required to save runtime settings.");
      return;
    }
    const nextProvider = input?.provider ?? runtimeProvider;
    const nextModel = input?.model ?? runtimeModel;
    const nextCredentialRef =
      input && "credentialRef" in input
        ? (input.credentialRef ?? null)
        : (runtimeProfile?.credentialRef ?? null);
    const nextFallbacks = input?.fallbacks ?? runtimeFallbacks;
    const nextModelTierFloor = input?.modelTierFloor ?? runtimeModelTierFloor;

    if (!nextModel.trim()) {
      onError("Runtime model is required.");
      return;
    }
    if (HOSTED_RUNTIME_PROVIDERS.has(nextProvider) && !nextCredentialRef) {
      onError("Hosted providers require a saved credential reference.");
      return;
    }

    onClearError();
    try {
      const profile = await updateRuntimeProfile.mutateAsync({
        workspaceId: profileWorkspaceId,
        provider: nextProvider,
        model: nextModel.trim(),
        credentialRef: nextProvider === "local" ? null : nextCredentialRef,
        fallbacks: nextFallbacks,
        modelTierFloor: nextModelTierFloor,
        localEndpointUrl: input?.localEndpointUrl ?? null,
      });
      setRuntimeProvider(profile.provider);
      setRuntimeModel(profile.model);
      setRuntimeFallbacks(profile.fallbacks);
      setRuntimeModelTierFloor(profile.modelTierFloor);
      await onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  const handleRuntimeProfileSave = async () => {
    await saveRuntimeProfile();
  };

  const runtimeProfileDirty =
    runtimeProvider !==
      (runtimeProfile?.provider ?? agent.provider ?? "openai") ||
    runtimeModel.trim() !== (runtimeProfile?.model ?? agent.model ?? "") ||
    JSON.stringify(runtimeFallbacks) !==
      JSON.stringify(runtimeProfile?.fallbacks ?? []) ||
    runtimeModelTierFloor !== (runtimeProfile?.modelTierFloor ?? "any");
  const runtimeProviderIsLocal = runtimeProvider === "local";
  const runtimeProviderNeedsCredential =
    HOSTED_RUNTIME_PROVIDERS.has(runtimeProvider);
  const runtimeCredentialMissing =
    runtimeProviderNeedsCredential && !runtimeProfile?.credentialRef;

  return {
    runtimeProfile,
    runtimeProvider,
    setRuntimeProvider,
    runtimeModel,
    setRuntimeModel,
    runtimeFallbacks,
    setRuntimeFallbacks,
    runtimeModelTierFloor,
    setRuntimeModelTierFloor,
    runtimeProfileLoading: runtimeProfileQuery.isLoading,
    runtimeProfileSaving: updateRuntimeProfile.isPending,
    runtimeProfileDirty,
    runtimeProviderIsLocal,
    runtimeCredentialMissing,
    loadRuntimeProfile,
    handleRuntimeProfileSave,
    saveRuntimeProfile,
  };
}
