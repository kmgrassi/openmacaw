import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  LocalRuntime,
  LocalModelProbeResponse,
  LocalRuntimeRunner,
} from "../../../api/local-runtime";
import { prepareRuntime } from "../../../api/broker-runtime";
import { ensureStoredAgentDefaultRouting } from "../../../api/stored-agents";
import {
  useLocalRuntimeMutations,
  useLocalRuntimesQuery,
} from "../../../hooks/useServerStateQueries";
import type { Agent } from "../../../types/agents";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Select } from "../../ui/Select";
import { HostedModelSelect } from "../HostedModelSelect";
import { RUNTIME_PROVIDER_OPTIONS } from "./constants";

type AgentRuntimeEditorProps = {
  agent: Agent;
  runtimeProfile: AgentRuntimeProfile | null;
  runtimeProvider: AgentRuntimeProfile["provider"];
  setRuntimeProvider: (value: AgentRuntimeProfile["provider"]) => void;
  runtimeModel: string;
  setRuntimeModel: (value: string) => void;
  runtimeProfileLoading: boolean;
  runtimeProfileSaving: boolean;
  runtimeProfileDirty: boolean;
  runtimeProviderIsLocal: boolean;
  runtimeCredentialMissing: boolean;
  onRuntimeProfileSave: () => void;
  onRuntimeProfileSaveInput: (input: {
    provider: AgentRuntimeProfile["provider"];
    model: string;
    credentialRef?: AgentRuntimeProfile["credentialRef"];
    localEndpointUrl?: string | null;
  }) => Promise<void> | void;
  onAgentReload: () => Promise<void>;
  onError: (message: string) => void;
  onClearError: () => void;
};

type LocalRuntimeRunnerOption = {
  id: string;
  runtime: LocalRuntime;
  runner: LocalRuntimeRunner;
};

export function AgentRuntimeEditor({
  agent,
  runtimeProfile,
  runtimeProvider,
  setRuntimeProvider,
  runtimeModel,
  setRuntimeModel,
  runtimeProfileLoading,
  runtimeProfileSaving,
  runtimeProfileDirty,
  runtimeProviderIsLocal,
  runtimeCredentialMissing,
  onRuntimeProfileSave,
  onRuntimeProfileSaveInput,
  onAgentReload,
  onError,
  onClearError,
}: AgentRuntimeEditorProps) {
  const [startingRuntime, setStartingRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [ensuringRouting, setEnsuringRouting] = useState(false);
  const [selectedLocalRunnerId, setSelectedLocalRunnerId] = useState("");
  const [localProbeResult, setLocalProbeResult] =
    useState<LocalModelProbeResponse | null>(null);

  const workspaceId = agent.workspaceId;
  const localRuntimesQuery = useLocalRuntimesQuery(workspaceId);
  const localRuntimeMutations = useLocalRuntimeMutations(workspaceId);
  const localRunnerOptions = useMemo(
    () =>
      (localRuntimesQuery.data?.runtimes ?? []).flatMap((runtime) =>
        runtime.runners
          .filter((runner) => runner.kind === "openai_compatible")
          .map((runner) => ({ id: runner.id, runtime, runner })),
      ),
    [localRuntimesQuery.data?.runtimes],
  );
  const onlineLocalRunnerOptions = useMemo(
    () =>
      localRunnerOptions.filter(
        (option) => option.runtime.localExecution.helperOnline,
      ),
    [localRunnerOptions],
  );
  const assignedLocalRunner = useMemo(
    () =>
      localRunnerOptions.find((option) =>
        option.runner.agents.some((assigned) => assigned.agentId === agent.id),
      ) ?? null,
    [agent.id, localRunnerOptions],
  );
  const assignedLocalRunnerId = assignedLocalRunner?.id ?? "";
  const helperRegistered = localRunnerOptions.length > 0;
  const firstOnlineLocalRunnerId = onlineLocalRunnerOptions[0]?.id ?? "";
  const selectedLocalRunner = useMemo(
    () =>
      localRunnerOptions.find(
        (option) => option.id === selectedLocalRunnerId,
      ) ?? null,
    [localRunnerOptions, selectedLocalRunnerId],
  );
  const previousLocalRuntimeSelectionRef = useRef<{
    agentId: string;
    assignedLocalRunnerId: string;
  } | null>(null);

  useEffect(() => {
    if (runtimeProvider !== "local") {
      setLocalProbeResult(null);
      return;
    }

    const previous = previousLocalRuntimeSelectionRef.current;
    const agentChanged = previous === null || previous.agentId !== agent.id;
    const assignmentChanged =
      previous === null ||
      previous.assignedLocalRunnerId !== assignedLocalRunnerId;
    previousLocalRuntimeSelectionRef.current = {
      agentId: agent.id,
      assignedLocalRunnerId,
    };

    if (agentChanged || assignmentChanged) {
      setSelectedLocalRunnerId(
        assignedLocalRunnerId || firstOnlineLocalRunnerId,
      );
      return;
    }

    if (!selectedLocalRunnerId && firstOnlineLocalRunnerId) {
      setSelectedLocalRunnerId(firstOnlineLocalRunnerId);
      return;
    }
  }, [
    agent.id,
    assignedLocalRunnerId,
    firstOnlineLocalRunnerId,
    runtimeProvider,
    selectedLocalRunnerId,
  ]);

  useEffect(() => {
    setLocalProbeResult(null);
  }, [selectedLocalRunnerId]);

  useEffect(() => {
    const missing = agent.configurationStatus?.missing ?? [];
    const shouldEnsure =
      agent.agentType !== "custom" &&
      Boolean(agent.model) &&
      missing.some(
        (requirement) =>
          requirement === "runner" || requirement === "gateway_config",
      );

    if (!shouldEnsure) return;

    let cancelled = false;
    setEnsuringRouting(true);
    ensureStoredAgentDefaultRouting(agent.id)
      .then(async (result) => {
        if (!cancelled && result.changed) {
          await onAgentReload();
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEnsuringRouting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    agent.id,
    agent.agentType,
    agent.model,
    agent.configurationStatus,
    onAgentReload,
    onError,
  ]);

  const handleStartRuntime = async () => {
    setStartingRuntime(true);
    onClearError();
    setRuntimeMessage(null);
    try {
      const result = await prepareRuntime(agent.id);
      if (!result.readyToConnect) {
        throw new Error(
          result.reasons.join(", ") || "Could not start orchestrator runtime.",
        );
      }
      setRuntimeMessage("Orchestrator runtime is ready for this agent.");
    } catch (err) {
      onError(String(err));
    } finally {
      setStartingRuntime(false);
    }
  };

  const handleUseLocalRunner = async () => {
    if (!selectedLocalRunner) {
      onError("Select an advertised local model before saving.");
      return;
    }
    if (!selectedLocalRunner.runtime.localExecution.helperOnline) {
      onError("Selected local runtime is offline.");
      return;
    }

    onClearError();
    setRuntimeMessage(null);
    try {
      await localRuntimeMutations.assignLocalModel.mutateAsync({
        agentId: agent.id,
        machineId: selectedLocalRunner.runtime.id,
        model: selectedLocalRunner.runner.model,
        provider: selectedLocalRunner.runner.provider,
      });
      await onRuntimeProfileSaveInput({
        provider: "local",
        model: selectedLocalRunner.runner.model,
        credentialRef: null,
        localEndpointUrl: selectedLocalRunner.runner.endpoint,
      });
      setRuntimeProvider("local");
      setRuntimeModel(selectedLocalRunner.runner.model);
      setRuntimeMessage(
        `Local runtime bound: ${localRunnerLabel(selectedLocalRunner)}.`,
      );
      await onAgentReload();
    } catch (err) {
      onError(String(err));
    }
  };

  const handleTestLocalRunner = async () => {
    if (!selectedLocalRunner) {
      onError("Select an advertised local model before testing.");
      return;
    }
    onClearError();
    setRuntimeMessage(null);
    try {
      const result = await localRuntimeMutations.probeRegistered.mutateAsync(
        selectedLocalRunner.runner.id,
      );
      setLocalProbeResult(result);
    } catch (err) {
      onError(String(err));
    }
  };

  const localRuntimeSaving =
    localRuntimeMutations.assignLocalModel.isPending || runtimeProfileSaving;
  const localRuntimeTesting = localRuntimeMutations.probeRegistered.isPending;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-medium text-slate-300">Runtime</h4>
          <p className="mt-1 text-xs text-slate-500">
            Select the provider and model this agent uses at dispatch time.
          </p>
          {runtimeMessage && (
            <p className="mt-2 text-xs text-green-400">{runtimeMessage}</p>
          )}
          {runtimeProviderIsLocal &&
            runtimeProfile &&
            !runtimeProfile.localHelperRegistered && (
              <p className="mt-2 text-xs text-amber-400">
                No local runtime relay helper is registered for this workspace.{" "}
                <Link
                  to="/settings/local-runtimes"
                  className="underline hover:text-amber-300"
                >
                  Open local runtimes
                </Link>
              </p>
            )}
          {runtimeCredentialMissing && (
            <p className="mt-2 text-xs text-amber-400">
              Save a credential reference before using this hosted provider.
            </p>
          )}
          {ensuringRouting && (
            <p className="mt-2 text-xs text-slate-500">
              Preparing default routing...
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            loading={runtimeProfileSaving}
            disabled={
              runtimeProfileLoading ||
              runtimeProvider === "local" ||
              !runtimeProfileDirty ||
              runtimeCredentialMissing
            }
            onClick={onRuntimeProfileSave}
          >
            Save runtime
          </Button>
          <Button
            size="sm"
            loading={startingRuntime}
            onClick={handleStartRuntime}
          >
            Start orchestrator
          </Button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Select
          label="Provider"
          value={runtimeProvider}
          onChange={(event) =>
            setRuntimeProvider(
              event.target.value as AgentRuntimeProfile["provider"],
            )
          }
          options={RUNTIME_PROVIDER_OPTIONS}
          disabled={runtimeProfileLoading}
        />
        {runtimeProvider === "local" ? (
          <Select
            label="Model"
            value={selectedLocalRunnerId}
            onChange={(event) => setSelectedLocalRunnerId(event.target.value)}
            disabled={
              runtimeProfileLoading ||
              localRuntimesQuery.isLoading ||
              onlineLocalRunnerOptions.length === 0
            }
            options={buildLocalRuntimeRunnerOptions(
              onlineLocalRunnerOptions,
              selectedLocalRunnerId,
            )}
          />
        ) : (
          <HostedModelSelect
            label="Model"
            value={runtimeModel}
            workspaceId={agent.workspaceId}
            provider={runtimeProvider}
            onChange={setRuntimeModel}
            disabled={runtimeProfileLoading}
          />
        )}
      </div>
      {runtimeProvider === "local" && (
        <div className="mt-4 space-y-3 rounded-md border border-white/5 bg-surface px-3 py-3">
          <div className="grid gap-2 text-xs md:grid-cols-3">
            <WizardCheck
              label="Helper connected"
              state={
                localRuntimesQuery.isLoading
                  ? "pending"
                  : helperRegistered
                    ? "pass"
                    : "fail"
              }
              detail={
                helperRegistered
                  ? "Relay registered for this workspace."
                  : "Set up a helper from local runtime settings."
              }
            />
            <WizardCheck
              label="Model advertised"
              state={selectedLocalRunner ? "pass" : "fail"}
              detail={
                selectedLocalRunner
                  ? localRunnerLabel(selectedLocalRunner)
                  : "No online helper is advertising a model."
              }
            />
            <WizardCheck
              label="Dispatch test"
              state={
                localProbeResult
                  ? localProbeResult.reachable && localProbeResult.modelFound
                    ? "pass"
                    : "fail"
                  : "pending"
              }
              detail={
                localProbeResult
                  ? localProbeResult.reachable && localProbeResult.modelFound
                    ? "Connection test passed."
                    : (localProbeResult.error ??
                      "The helper did not find the selected model.")
                  : "Run a test before binding."
              }
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {assignedLocalRunner ? (
                <p className="text-xs text-green-400">
                  Bound to {localRunnerLabel(assignedLocalRunner)}.
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Pick an advertised model, test the helper path, then bind this
                  agent.
                </p>
              )}
              {selectedLocalRunner && (
                <p className="mt-1 text-xs text-slate-500">
                  {selectedLocalRunner.runner.endpoint} ·{" "}
                  {selectedLocalRunner.runner.toolCallCapability ??
                    "tool support unknown"}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={localRuntimeTesting}
                disabled={
                  runtimeProfileLoading ||
                  localRuntimesQuery.isLoading ||
                  !selectedLocalRunner ||
                  !selectedLocalRunner.runtime.localExecution.helperOnline
                }
                onClick={handleTestLocalRunner}
              >
                Run test
              </Button>
              <Button
                size="sm"
                loading={localRuntimeSaving}
                disabled={
                  runtimeProfileLoading ||
                  localRuntimesQuery.isLoading ||
                  !selectedLocalRunner ||
                  !selectedLocalRunner.runtime.localExecution.helperOnline ||
                  !localProbeResult?.reachable ||
                  !localProbeResult.modelFound
                }
                onClick={handleUseLocalRunner}
              >
                Use local model
              </Button>
            </div>
          </div>
          {!localRuntimesQuery.isLoading &&
            onlineLocalRunnerOptions.length === 0 && (
              <p className="text-xs text-amber-400">
                No online local model runtime is registered for this workspace.{" "}
                <Link
                  to="/settings/local-runtimes"
                  className="underline hover:text-amber-300"
                >
                  Set up local runtime
                </Link>
              </p>
            )}
        </div>
      )}
    </Card>
  );
}

function localRunnerLabel(option: LocalRuntimeRunnerOption) {
  return `${option.runner.model} on ${option.runtime.machineDisplayName}`;
}

function WizardCheck({
  label,
  state,
  detail,
}: {
  label: string;
  state: "pass" | "fail" | "pending";
  detail: string;
}) {
  const tone =
    state === "pass"
      ? "border-green-600/30 bg-green-950/20 text-green-200"
      : state === "fail"
        ? "border-amber-600/30 bg-amber-950/20 text-amber-200"
        : "border-white/5 bg-surface-raised text-slate-300";
  const marker =
    state === "pass" ? "OK" : state === "fail" ? "Needs attention" : "Pending";
  return (
    <div className={`rounded-md border px-3 py-2 ${tone}`}>
      <div className="font-medium">{label}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide opacity-75">
        {marker}
      </div>
      <div className="mt-1 text-slate-400">{detail}</div>
    </div>
  );
}

function buildLocalRuntimeRunnerOptions(
  options: LocalRuntimeRunnerOption[],
  current: string,
): Array<{ value: string; label: string }> {
  if (options.length === 0) {
    return [{ value: "", label: "No online local runtimes" }];
  }
  const selectOptions = options.map((option) => ({
    value: option.id,
    label: localRunnerLabel(option),
  }));
  if (current && !selectOptions.some((option) => option.value === current)) {
    selectOptions.unshift({ value: current, label: "Current local runtime" });
  }
  return selectOptions;
}
