import { useEffect, useMemo, useState } from "react";
import { type CredentialAlias, type SavedCredential } from "../api/credentials";
import type { LocalRuntime } from "../api/local-runtime";
import { useResolvedCredentialQuery } from "./useServerStateQueries";
import type { Agent } from "../types/agents";
import {
  credentialRefValue,
  defaultRunnerKindForAgent,
  findLocalCodingRunnerForSavedModel,
  localCodingRunnerOptions,
  runnerKindForAgent,
  LOCAL_MODEL_CODING_RUNNER_KIND,
  type ApprovalPolicy,
} from "../lib/agent-model-policy";

type UseResolvedCredentialsArgs = {
  agent: Agent;
  refreshKey?: number;
  localRuntimes: LocalRuntime[];
};

export function useResolvedCredentials({
  agent,
  refreshKey,
  localRuntimes,
}: UseResolvedCredentialsArgs) {
  const credentialQuery = useResolvedCredentialQuery(
    agent.id,
    agent.workspaceId,
    refreshKey,
  );
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [aliases, setAliases] = useState<CredentialAlias[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [selectedRunnerKind, setSelectedRunnerKind] = useState(
    defaultRunnerKindForAgent(agent),
  );
  const [savedRunnerKind, setSavedRunnerKind] = useState(selectedRunnerKind);
  const [selectedLocalRunnerId, setSelectedLocalRunnerId] = useState("");
  const [savedLocalRunnerId, setSavedLocalRunnerId] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    agent.localModelCoding?.approvalPolicy ?? "on_request",
  );
  const [savedApprovalPolicy, setSavedApprovalPolicy] =
    useState(approvalPolicy);
  const [selectedCredentialRef, setSelectedCredentialRef] = useState("");
  const [savedCredentialRef, setSavedCredentialRef] = useState("");
  const [savedProvider, setSavedProvider] = useState<string | null>(
    agent.provider ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const codingOptions = useMemo(
    () => localCodingRunnerOptions(localRuntimes),
    [localRuntimes],
  );

  useEffect(() => {
    setSelectedRunnerKind(defaultRunnerKindForAgent(agent));
    setApprovalPolicy(agent.localModelCoding?.approvalPolicy ?? "on_request");
    setSavedProvider(agent.provider ?? null);
  }, [agent.id, agent.runnerKind, agent.agentType, agent.localModelCoding]);

  useEffect(() => {
    if (!agent.workspaceId || credentialQuery.isError) {
      setCredentials([]);
      setAliases([]);
      setSelectedCredentialRef("");
      setSavedCredentialRef("");
      if (credentialQuery.error) {
        setError(
          credentialQuery.error instanceof Error
            ? credentialQuery.error.message
            : String(credentialQuery.error),
        );
      }
      return;
    }

    if (!credentialQuery.data) {
      setLoadingCredentials(credentialQuery.isLoading);
      return;
    }

    const response = credentialQuery.data;
    setError(null);
    setLoadingCredentials(credentialQuery.isFetching);
    setCredentials(response.credentials);
    setAliases(response.aliases);
    const refValue = credentialRefValue(response.reference.credentialRef);
    const runnerKind =
      response.reference.runnerKind ||
      (agent.localModelCoding?.enabled
        ? LOCAL_MODEL_CODING_RUNNER_KIND
        : runnerKindForAgent(agent));
    setSelectedCredentialRef(refValue);
    setSavedCredentialRef(refValue);
    setSelectedRunnerKind(runnerKind);
    setSavedRunnerKind(runnerKind);
    setSavedProvider(response.reference.provider ?? agent.provider ?? null);
    const matched = findLocalCodingRunnerForSavedModel(
      response.reference.model,
      agent.localModelCoding?.localModelId,
      codingOptions,
    );
    const localRunnerId = matched ? matched.id : "";
    setSelectedLocalRunnerId(localRunnerId);
    setSavedLocalRunnerId(localRunnerId);
    const nextApprovalPolicy =
      agent.localModelCoding?.approvalPolicy ?? "on_request";
    setApprovalPolicy(nextApprovalPolicy);
    setSavedApprovalPolicy(nextApprovalPolicy);
  }, [
    agent.id,
    agent.workspaceId,
    agent.provider,
    agent.localModelCoding,
    credentialQuery.data,
    credentialQuery.error,
    credentialQuery.isError,
    credentialQuery.isFetching,
    credentialQuery.isLoading,
    refreshKey,
    codingOptions,
  ]);

  return {
    credentials,
    setCredentials,
    aliases,
    setAliases,
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
    codingOptions,
    error,
    setError,
  };
}
