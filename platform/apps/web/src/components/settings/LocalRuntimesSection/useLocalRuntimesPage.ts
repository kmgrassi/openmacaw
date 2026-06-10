import { useMemo, useState } from "react";
import {
  type LocalRuntime,
  type LocalRuntimeConfigResponse,
  type LocalRuntimeRunner,
  type LocalModelProbeResponse,
} from "../../../api/local-runtime";
import { useAgentsQuery } from "../../../hooks/useAgents";
import { useRequiredWorkspaceId } from "../../../hooks/useWorkspaceId";
import {
  useLocalRuntimeMutations,
  useLocalRuntimesQuery,
} from "../../../hooks/useServerStateQueries";
import { useLocalRuntimeRegistration } from "./useLocalRuntimeRegistration";
import { wizardStateFor } from "./wizard-state";

export type LocalRuntimeRunnerAssignment = {
  runner: LocalRuntimeRunner;
  runtime: LocalRuntime;
};

export function useLocalRuntimesPage() {
  const workspaceId = useRequiredWorkspaceId();
  const localRuntimesQuery = useLocalRuntimesQuery(workspaceId);
  const mutations = useLocalRuntimeMutations(workspaceId);
  const { data: agents = [] } = useAgentsQuery(workspaceId);

  const [error, setError] = useState<string | null>(null);
  const [runnerProbes, setRunnerProbes] = useState<
    Record<string, LocalModelProbeResponse | null>
  >({});
  const [configResult, setConfigResult] =
    useState<LocalRuntimeConfigResponse | null>(null);
  const [configActionRuntimeId, setConfigActionRuntimeId] = useState<
    string | null
  >(null);

  const runtimes = localRuntimesQuery.data?.runtimes ?? [];
  const heartbeatIntervalMs =
    localRuntimesQuery.data?.heartbeatIntervalMs ?? 30_000;
  const loading = localRuntimesQuery.isLoading;
  const queryError =
    localRuntimesQuery.error instanceof Error
      ? localRuntimesQuery.error.message
      : localRuntimesQuery.error
        ? String(localRuntimesQuery.error)
        : null;

  const registration = useLocalRuntimeRegistration({
    workspaceId,
    onConfigResultClear: () => setConfigResult(null),
  });

  const currentRuntime = runtimes[0] ?? null;
  const wizardState = wizardStateFor(
    currentRuntime,
    Boolean(registration.registrationResult),
  );

  const assignedRunnerByAgent = useMemo(() => {
    const assignments = new Map<string, LocalRuntimeRunnerAssignment>();
    for (const runtime of runtimes) {
      for (const runner of runtime.runners) {
        for (const agent of runner.agents) {
          assignments.set(agent.agentId, { runner, runtime });
        }
      }
    }
    return assignments;
  }, [runtimes]);

  const handleRemove = async (machineId: string) => {
    try {
      await mutations.remove.mutateAsync(machineId);
      setConfigResult(null);
      registration.setRegistrationResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleProbeRunner = async (runnerId: string) => {
    setError(null);
    try {
      setRunnerProbes((current) => ({
        ...current,
        [runnerId]: null,
      }));
      const result = await mutations.probeRegistered.mutateAsync(runnerId);
      setRunnerProbes((current) => ({
        ...current,
        [runnerId]: result,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfigAction = async (
    machineId: string,
    action: "regenerate" | "rotate",
  ) => {
    setConfigActionRuntimeId(machineId);
    setError(null);
    try {
      setConfigResult(
        action === "rotate"
          ? await mutations.rotateToken.mutateAsync(machineId)
          : await mutations.regenerateConfig.mutateAsync(machineId),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigActionRuntimeId(null);
    }
  };

  return {
    agents,
    assignedRunnerByAgent,
    configActionRuntimeId,
    configResult,
    currentRuntime,
    error: error ?? queryError,
    heartbeatIntervalMs,
    loading,
    runnerProbes,
    probingRunnerId: mutations.probeRegistered.variables ?? null,
    registration,
    removingId: mutations.remove.variables ?? null,
    wizardState,
    handleConfigAction,
    handleProbeRunner,
    handleRemove,
    loadRuntimes: localRuntimesQuery.refetch,
    setConfigResult,
  };
}
