import { useEffect, useMemo, useState } from "react";
import type { ManagerAgentConfigRequest } from "../../../../../../contracts/manager-agent";
import type {
  CredentialReference,
  CredentialProvider,
  SavedCredential,
} from "../../../api/credentials";
import {
  getAgentCredentialReference,
  saveStoredCredential,
} from "../../../api/credentials";
import { updateAgentRuntimeProfile } from "../../../api/stored-agents";
import {
  credentialProviderMatches,
  credentialRowId,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODELS,
  MANAGER_PROVIDERS,
  providerLabel,
  type SchedulerRuntimeProvider,
} from "./utils";

type InlineCredential = {
  apiKey: string;
  label?: string;
};

type UseManagerAgentActivationArgs = {
  workspaceId: string | null;
  agentId: string | null;
  reloadAgents: () => Promise<void>;
  loadStatus: () => Promise<void>;
  saveConfigPatch: (
    request: ManagerAgentConfigRequest,
    targetAgentId?: string,
  ) => Promise<unknown>;
};

export function useManagerAgentActivation({
  workspaceId,
  agentId,
  reloadAgents,
  loadStatus,
  saveConfigPatch,
}: UseManagerAgentActivationArgs) {
  const [provider, setProvider] = useState<SchedulerRuntimeProvider>("openai");
  const [model, setModel] = useState(DEFAULT_MODELS.openai);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [cadenceMs, setCadenceMs] = useState("300000");
  const [credentialMode, setCredentialMode] = useState<"reuse" | "new">(
    "reuse",
  );
  const [selectedRef, setSelectedRef] = useState("");
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationSuccess, setActivationSuccess] = useState(false);
  const localProvider = provider === "openai_compatible";

  useEffect(() => {
    if (!workspaceId || !agentId) {
      setCredentials([]);
      return;
    }

    let cancelled = false;
    setLoadingCredentials(true);
    void getAgentCredentialReference(agentId, workspaceId)
      .then((response) => {
        if (cancelled) return;
        setCredentials(response.credentials);
        const reference = response.reference.credentialRef;
        setSelectedRef(reference ? `${reference.type}:${reference.value}` : "");
        if (
          response.reference.provider &&
          MANAGER_PROVIDERS.includes(
            response.reference.provider as SchedulerRuntimeProvider,
          )
        ) {
          const resolvedProvider = response.reference
            .provider as SchedulerRuntimeProvider;
          setProvider(resolvedProvider);
          setModel(
            response.reference.model ?? DEFAULT_MODELS[resolvedProvider],
          );
        } else if (response.reference.model) {
          setModel(response.reference.model);
        }
        setBaseUrl(
          response.reference.localEndpointUrl ?? DEFAULT_LOCAL_BASE_URL,
        );
      })
      .catch((err) => {
        if (!cancelled)
          setActivationError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingCredentials(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, workspaceId]);

  useEffect(() => {
    setModel((current) => current || DEFAULT_MODELS[provider]);
    setSelectedRef("");
  }, [provider]);

  const filteredCredentials = useMemo(
    () =>
      credentials.filter((credential) =>
        credentialProviderMatches(credential, provider),
      ),
    [credentials, provider],
  );

  const credentialOptions = useMemo(
    () => [
      { value: "", label: "Select a workspace credential" },
      ...filteredCredentials.map((credential) => ({
        value: `credential_id:${credentialRowId(credential)}`,
        label: `${credential.label} (${providerLabel(credential.provider)})`,
      })),
    ],
    [filteredCredentials],
  );

  const canActivate =
    Boolean(workspaceId && agentId && model.trim()) &&
    (localProvider
      ? Boolean(baseUrl.trim())
      : (credentialMode === "reuse" && Boolean(selectedRef)) ||
        credentialMode === "new");

  const handleActivate = async (newCredentialOverride?: InlineCredential) => {
    const usingInlineCredential =
      !localProvider &&
      credentialMode === "new" &&
      Boolean(newCredentialOverride?.apiKey);
    const canActivateWithOverride =
      Boolean(workspaceId && agentId && model.trim()) &&
      (localProvider
        ? Boolean(baseUrl.trim())
        : credentialMode === "reuse"
          ? Boolean(selectedRef)
          : usingInlineCredential);
    if (!workspaceId || !agentId || !canActivateWithOverride) {
      if (newCredentialOverride) {
        throw new Error("Manager agent, model, and API key are required.");
      }
      return;
    }
    if (!localProvider && credentialMode === "new" && !usingInlineCredential) {
      return;
    }
    const [type, value] = selectedRef.split(":", 2);
    const credentialRef: CredentialReference | undefined =
      !localProvider &&
      credentialMode === "reuse" &&
      (type === "credential_id" || type === "alias") &&
      value
        ? { type, value }
        : undefined;

    setActivating(true);
    setActivationError(null);
    setActivationSuccess(false);
    try {
      let nextCredentialRef = credentialRef;
      if (!localProvider && credentialMode === "new") {
        const inlineApiKey = newCredentialOverride?.apiKey ?? "";
        const saved = await saveStoredCredential({
          scope: { kind: "agent", agentId, workspaceId },
          provider: provider as CredentialProvider,
          apiKey: inlineApiKey,
        });
        const credentialId =
          saved.credential.credentialRowId ??
          saved.credential.id.split(":", 1)[0] ??
          saved.credential.id;
        nextCredentialRef = { type: "credential_id", value: credentialId };
      }
      await updateAgentRuntimeProfile(agentId, {
        workspaceId,
        provider,
        model: model.trim(),
        credentialRef: localProvider ? null : (nextCredentialRef ?? null),
        localEndpointUrl: localProvider ? baseUrl.trim() : null,
      });
      if (Number(cadenceMs) > 0) {
        await saveConfigPatch({ cadenceMs: Number(cadenceMs) }, agentId);
      }
      setActivationSuccess(true);
      await reloadAgents();
      await loadStatus();
      setTimeout(() => setActivationSuccess(false), 3000);
    } catch (err) {
      setActivationError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(false);
    }
  };

  return {
    provider,
    setProvider,
    model,
    setModel,
    baseUrl,
    setBaseUrl,
    cadenceMs,
    setCadenceMs,
    credentialMode,
    setCredentialMode,
    selectedRef,
    setSelectedRef,
    localProvider,
    credentialOptions,
    filteredCredentials,
    loadingCredentials,
    activationError,
    activationSuccess,
    activating,
    canActivate,
    handleActivate,
  };
}
