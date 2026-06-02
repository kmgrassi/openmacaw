import { useEffect, useState } from "react";
import {
  useAgentRuntimeProfileQuery,
  useUpdateAgentRuntimeProfileMutation,
} from "../../../hooks/useSetupQueries";
import type { Agent } from "../../../types/agents";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import { HOSTED_RUNTIME_PROVIDERS } from "./constants";

type UseAgentRuntimeProfileArgs = {
  agent: Agent;
  workspaceId: string | null | undefined;
  onError: (message: string) => void;
  onClearError: () => void;
  onSaved: () => Promise<void>;
};

export function useAgentRuntimeProfile({
  agent,
  workspaceId,
  onError,
  onClearError,
}: UseAgentRuntimeProfileArgs) {
  const profileWorkspaceId = agent.workspaceId ?? workspaceId;
  const runtimeProfileQuery = useAgentRuntimeProfileQuery(
    agent.id,
    profileWorkspaceId,
  );
  const updateRuntimeProfile = useUpdateAgentRuntimeProfileMutation(agent.id);
  const runtimeProfile = runtimeProfileQuery.data ?? null;
  const [runtimeProvider, setRuntimeProvider] = useState(
    agent.provider ?? "openai",
  );
  const [runtimeModel, setRuntimeModel] = useState(agent.model ?? "");

  useEffect(() => {
    if (runtimeProfile) {
      setRuntimeProvider(runtimeProfile.provider);
      setRuntimeModel(runtimeProfile.model);
      return;
    }
    setRuntimeProvider(agent.provider ?? "openai");
    setRuntimeModel(agent.model ?? "");
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
    }
  };

  const handleRuntimeProfileSave = async () => {
    if (!profileWorkspaceId) {
      onError("Workspace context is required to save runtime settings.");
      return;
    }
    if (!runtimeModel.trim()) {
      onError("Runtime model is required.");
      return;
    }
    if (
      HOSTED_RUNTIME_PROVIDERS.has(runtimeProvider) &&
      !runtimeProfile?.credentialRef
    ) {
      onError("Hosted providers require a saved credential reference.");
      return;
    }

    onClearError();
    try {
      const profile = await updateRuntimeProfile.mutateAsync({
        workspaceId: profileWorkspaceId,
        provider: runtimeProvider as AgentRuntimeProfile["provider"],
        model: runtimeModel.trim(),
        credentialRef:
          runtimeProvider === "local"
            ? null
            : (runtimeProfile?.credentialRef ?? null),
      });
      setRuntimeProvider(profile.provider);
      setRuntimeModel(profile.model);
    } catch (err) {
      onError(String(err));
    }
  };

  const runtimeProfileDirty =
    runtimeProvider !==
      (runtimeProfile?.provider ?? agent.provider ?? "openai") ||
    runtimeModel.trim() !== (runtimeProfile?.model ?? agent.model ?? "");
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
    runtimeProfileLoading: runtimeProfileQuery.isLoading,
    runtimeProfileSaving: updateRuntimeProfile.isPending,
    runtimeProfileDirty,
    runtimeProviderIsLocal,
    runtimeCredentialMissing,
    loadRuntimeProfile,
    handleRuntimeProfileSave,
  };
}
