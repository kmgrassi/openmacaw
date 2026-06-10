import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  listInstalledLocalModels,
  type InstalledLocalModel,
} from "../../../api/local-models";
import type {
  LocalRuntime,
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

  const showLocalModelPicker = runtimeProvider === "openai_compatible";
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
  const firstOnlineLocalRunnerId = onlineLocalRunnerOptions[0]?.id ?? "";
  const selectedLocalRunner = useMemo(
    () =>
      localRunnerOptions.find(
        (option) => option.id === selectedLocalRunnerId,
      ) ?? null,
    [localRunnerOptions, selectedLocalRunnerId],
  );
  const [installedModels, setInstalledModels] = useState<
    InstalledLocalModel[] | null
  >(null);
  const [installedModelsError, setInstalledModelsError] = useState<
    string | null
  >(null);
  const previousLocalRuntimeSelectionRef = useRef<{
    agentId: string;
    assignedLocalRunnerId: string;
  } | null>(null);

  useEffect(() => {
    if (!showLocalModelPicker) {
      setInstalledModels(null);
      setInstalledModelsError(null);
      return;
    }
    let cancelled = false;
    listInstalledLocalModels().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setInstalledModels(result.models);
        setInstalledModelsError(null);
      } else {
        setInstalledModels([]);
        setInstalledModelsError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [showLocalModelPicker]);

  useEffect(() => {
    if (runtimeProvider !== "local") return;

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
      onError("Select an online local runtime before saving.");
      return;
    }
    if (!selectedLocalRunner.runtime.localExecution.helperOnline) {
      onError("Selected local runtime is offline.");
      return;
    }

    onClearError();
    setRuntimeMessage(null);
    try {
      await localRuntimeMutations.assign.mutateAsync({
        runnerId: selectedLocalRunner.runner.id,
        agentId: agent.id,
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

  const localRuntimeSaving =
    localRuntimeMutations.assign.isPending || runtimeProfileSaving;

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
            value={selectedLocalRunner?.runner.model ?? runtimeModel}
            options={[
              {
                value: selectedLocalRunner?.runner.model ?? runtimeModel,
                label:
                  selectedLocalRunner?.runner.model ||
                  runtimeModel ||
                  "Select a local runtime",
              },
            ]}
            disabled
          />
        ) : showLocalModelPicker ? (
          <div>
            <Select
              label="Model"
              value={runtimeModel}
              onChange={(event) => setRuntimeModel(event.target.value)}
              disabled={runtimeProfileLoading || installedModels === null}
              options={buildLocalModelOptions(installedModels, runtimeModel)}
            />
            {installedModels !== null && installedModels.length === 0 && (
              <p className="mt-1 text-xs text-amber-300">
                No local models are installed. Pull one with{" "}
                <code className="font-mono">ollama pull qwen3-coder:30b</code>{" "}
                (or similar) and refresh.
              </p>
            )}
            {installedModelsError && (
              <p className="mt-1 text-xs text-red-300">
                Could not reach local model host:{" "}
                <span className="font-mono">{installedModelsError}</span>
              </p>
            )}
          </div>
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
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex-1">
              <Select
                label="Local model runtime"
                value={selectedLocalRunnerId}
                onChange={(event) =>
                  setSelectedLocalRunnerId(event.target.value)
                }
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
            </div>
            <Button
              size="sm"
              loading={localRuntimeSaving}
              disabled={
                runtimeProfileLoading ||
                localRuntimesQuery.isLoading ||
                !selectedLocalRunner ||
                !selectedLocalRunner.runtime.localExecution.helperOnline
              }
              onClick={handleUseLocalRunner}
            >
              Use for this agent
            </Button>
          </div>
          {assignedLocalRunner && (
            <p className="text-xs text-green-400">
              Bound to {localRunnerLabel(assignedLocalRunner)}.
            </p>
          )}
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
          {selectedLocalRunner && (
            <p className="text-xs text-slate-500">
              {selectedLocalRunner.runner.endpoint} ·{" "}
              {selectedLocalRunner.runner.toolCallCapability ??
                "tool support unknown"}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function buildLocalModelOptions(
  installed: InstalledLocalModel[] | null,
  current: string,
): Array<{ value: string; label: string }> {
  if (installed === null) {
    return [{ value: "", label: "Loading installed models…" }];
  }
  const options = installed.map((model) => ({
    value: model.name,
    label: model.parameterSize
      ? `${model.name}  (${model.parameterSize})`
      : model.name,
  }));
  // If the saved model isn't in the installed list (e.g. user has it
  // configured but hasn't pulled it yet), keep it visible so saves
  // don't silently change the value.
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: `${current}  (not installed)` });
  }
  if (options.length === 0) {
    return [{ value: "", label: "No local models installed" }];
  }
  return options;
}

function localRunnerLabel(option: LocalRuntimeRunnerOption) {
  return `${option.runner.model} on ${option.runtime.machineDisplayName}`;
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
