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
  useResolvedCredentialQuery,
} from "../../../hooks/useServerStateQueries";
import type { Agent } from "../../../types/agents";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import type { CredentialReference } from "../../../../../../contracts/credentials";
import {
  MODEL_TIER_REGISTRY,
  modelRegistryEntry,
  modelTier,
  modelTierLabel,
  type ModelTierFloor,
} from "../../../../../../contracts/model-tiers";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Select } from "../../ui/Select";
import { HostedModelSelect } from "../HostedModelSelect";
import { RUNTIME_PROVIDER_OPTIONS } from "./constants";
import {
  credentialProviderLabel,
  credentialRefValue,
  credentialRowId,
  credentialValidationLabel,
  matchesProviderFilter,
} from "../credential-picker/credential-picker-utils";

type AgentRuntimeEditorProps = {
  agent: Agent;
  runtimeProfile: AgentRuntimeProfile | null;
  runtimeProvider: AgentRuntimeProfile["provider"];
  setRuntimeProvider: (value: AgentRuntimeProfile["provider"]) => void;
  runtimeModel: string;
  setRuntimeModel: (value: string) => void;
  runtimeFallbacks: AgentRuntimeProfile["fallbacks"];
  setRuntimeFallbacks: (value: AgentRuntimeProfile["fallbacks"]) => void;
  runtimeModelTierFloor: ModelTierFloor;
  setRuntimeModelTierFloor: (value: ModelTierFloor) => void;
  runtimeProfileLoading: boolean;
  runtimeProfileSaving: boolean;
  runtimeProfileDirty: boolean;
  runtimeProviderIsLocal: boolean;
  runtimeCredentialMissing: boolean;
  onRuntimeProfileSaveInput: (input: {
    provider: AgentRuntimeProfile["provider"];
    model: string;
    credentialRef?: AgentRuntimeProfile["credentialRef"];
    fallbacks?: AgentRuntimeProfile["fallbacks"];
    modelTierFloor?: ModelTierFloor;
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
  runtimeFallbacks,
  setRuntimeFallbacks,
  runtimeModelTierFloor,
  setRuntimeModelTierFloor,
  runtimeProfileLoading,
  runtimeProfileSaving,
  runtimeProfileDirty,
  runtimeProviderIsLocal,
  runtimeCredentialMissing,
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
  const credentialQuery = useResolvedCredentialQuery(agent.id, workspaceId);
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
        localRuntimeId: selectedLocalRunner.runner.id,
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
  const routingWarnings = buildRoutingWarnings({
    primaryProvider: runtimeProvider,
    primaryModel: runtimeModel,
    modelTierFloor: runtimeModelTierFloor,
    fallbacks: runtimeFallbacks,
  });

  const saveRuntimeWithCutover = async () => {
    await onRuntimeProfileSaveInput({
      provider: runtimeProvider,
      model: runtimeModel,
      credentialRef: runtimeProfile?.credentialRef ?? null,
      fallbacks: runtimeFallbacks,
      modelTierFloor: runtimeModelTierFloor,
      localEndpointUrl: runtimeProfile?.localEndpointUrl ?? null,
    });
  };

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
            onClick={saveRuntimeWithCutover}
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
      {runtimeProvider !== "local" && (
        <div className="mt-4 space-y-3 rounded-md border border-white/5 bg-surface px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h5 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Cutover policy
              </h5>
            </div>
            <Select
              aria-label="Adequacy floor"
              value={runtimeModelTierFloor}
              onChange={(event) =>
                setRuntimeModelTierFloor(event.target.value as ModelTierFloor)
              }
              options={MODEL_TIER_FLOOR_OPTIONS}
              disabled={runtimeProfileLoading}
              className="min-w-36"
            />
          </div>

          <FallbackChainBuilder
            agentId={agent.id}
            workspaceId={workspaceId}
            fallbacks={runtimeFallbacks}
            disabled={runtimeProfileLoading || runtimeProfileSaving}
            credentialState={credentialQuery.data ?? null}
            onChange={setRuntimeFallbacks}
          />

          {routingWarnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-600/30 bg-amber-950/20 px-3 py-2">
              {routingWarnings.map((warning) => (
                <p key={warning} className="text-xs text-amber-200">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
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

const MODEL_TIER_FLOOR_OPTIONS: Array<{
  value: ModelTierFloor;
  label: string;
}> = [
  { value: "any", label: "Any model" },
  { value: "local", label: "Local or better" },
  { value: "mid", label: "Mid or better" },
  { value: "frontier", label: "Frontier only" },
];

const FALLBACK_PROVIDER_OPTIONS = Array.from(
  new Set(
    MODEL_TIER_REGISTRY.map((entry) => entry.provider).filter(
      (provider) => provider !== "bedrock",
    ),
  ),
).map((provider) => ({
  value: provider,
  label: providerLabel(provider),
}));

function FallbackChainBuilder({
  agentId,
  workspaceId,
  fallbacks,
  disabled,
  credentialState,
  onChange,
}: {
  agentId: string;
  workspaceId: string | null | undefined;
  fallbacks: AgentRuntimeProfile["fallbacks"];
  disabled: boolean;
  credentialState: ReturnType<typeof useResolvedCredentialQuery>["data"] | null;
  onChange: (value: AgentRuntimeProfile["fallbacks"]) => void;
}) {
  const updateLink = (
    index: number,
    patch: Partial<AgentRuntimeProfile["fallbacks"][number]>,
  ) => {
    onChange(
      fallbacks.map((fallback, candidateIndex) =>
        candidateIndex === index ? { ...fallback, ...patch } : fallback,
      ),
    );
  };

  const moveLink = (index: number, direction: -1 | 1) => {
    const next = [...fallbacks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const current = next[index];
    const targetFallback = next[target];
    if (!current || !targetFallback) return;
    next[index] = targetFallback;
    next[target] = current;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {fallbacks.length === 0 && (
        <p className="text-xs text-slate-500">No fallback links configured.</p>
      )}
      {fallbacks.map((fallback, index) => (
        <div
          key={`${fallback.provider}:${fallback.model}:${index}`}
          className="grid gap-2 rounded-md border border-white/5 bg-surface-raised p-2 md:grid-cols-[2rem_1fr_1.4fr_1.3fr_auto]"
        >
          <div
            className="flex h-9 items-center justify-center rounded border border-border text-slate-500"
            title="Drag handle"
          >
            ::
          </div>
          <Select
            label={index === 0 ? "Provider" : undefined}
            aria-label={`Fallback ${index + 1} provider`}
            value={fallback.provider}
            onChange={(event) => {
              const provider = event.target.value;
              updateLink(index, {
                provider,
                model: firstModelForProvider(provider),
                credentialRef: null,
              });
            }}
            options={FALLBACK_PROVIDER_OPTIONS}
            disabled={disabled}
          />
          <Select
            label={index === 0 ? "Model" : undefined}
            aria-label={`Fallback ${index + 1} model`}
            value={fallback.model}
            onChange={(event) =>
              updateLink(index, { model: event.target.value })
            }
            options={modelOptionsForProvider(fallback.provider)}
            disabled={disabled}
          />
          <Select
            label={index === 0 ? "Credential" : undefined}
            aria-label={`Fallback ${index + 1} credential`}
            value={credentialRefValue(fallback.credentialRef)}
            onChange={(event) =>
              updateLink(index, {
                credentialRef: credentialRefFromValue(event.target.value),
              })
            }
            options={credentialOptionsForProvider(
              credentialState,
              fallback.provider,
            )}
            disabled={!workspaceId || disabled}
          />
          <div className="flex items-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || index === 0}
              onClick={() => moveLink(index, -1)}
              title="Move fallback up"
            >
              Up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || index === fallbacks.length - 1}
              onClick={() => moveLink(index, 1)}
              title="Move fallback down"
            >
              Down
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={disabled}
              onClick={() =>
                onChange(
                  fallbacks.filter(
                    (_fallback, candidateIndex) => candidateIndex !== index,
                  ),
                )
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          const provider = FALLBACK_PROVIDER_OPTIONS[0]?.value ?? "openai";
          onChange([
            ...fallbacks,
            {
              provider,
              model: firstModelForProvider(provider),
              credentialRef: null,
            },
          ]);
        }}
      >
        Add fallback
      </Button>
      {!agentId && <span className="sr-only">Agent unavailable</span>}
    </div>
  );
}

function buildRoutingWarnings(input: {
  primaryProvider: string;
  primaryModel: string;
  modelTierFloor: ModelTierFloor;
  fallbacks: AgentRuntimeProfile["fallbacks"];
}) {
  const warnings: string[] = [];
  const primaryTier = modelTier(input.primaryProvider, input.primaryModel);
  if (input.modelTierFloor === "frontier" && primaryTier === "mid") {
    warnings.push(
      "Frontier floor is advisory here: the primary model is mid-tier, so cutover may escalate instead of degrading.",
    );
  }
  input.fallbacks.forEach((fallback, index) => {
    const entry = modelRegistryEntry(fallback.provider, fallback.model);
    if (entry && !entry.executable) {
      warnings.push(
        `Fallback ${index + 1} uses ${providerLabel(fallback.provider)}, whose execution adapter is not available yet. See the provider adapter rollout scope.`,
      );
    }
  });
  return warnings;
}

function firstModelForProvider(provider: string) {
  return (
    MODEL_TIER_REGISTRY.find((entry) => entry.provider === provider)?.model ??
    ""
  );
}

function modelOptionsForProvider(provider: string) {
  return MODEL_TIER_REGISTRY.filter((entry) => entry.provider === provider).map(
    (entry) => ({
      value: entry.model,
      label: `${modelTierLabel(entry.model)} (${entry.tier})`,
    }),
  );
}

function credentialOptionsForProvider(
  state: ReturnType<typeof useResolvedCredentialQuery>["data"] | null,
  provider: string,
) {
  const credentials = state?.credentials ?? [];
  const aliases = state?.aliases ?? [];
  return [
    { value: "", label: "No credential reference" },
    ...aliases
      .filter((alias) => matchesProviderFilter(alias.credential, provider))
      .map((alias) => ({
        value: `alias:${alias.alias}`,
        label: `Alias: ${alias.alias}${alias.credential ? ` (${credentialProviderLabel(alias.credential)} - ${alias.credential.label})` : ""}`,
      })),
    ...credentials
      .filter((credential) => matchesProviderFilter(credential, provider))
      .map((credential) => ({
        value: `credential_id:${credentialRowId(credential)}`,
        label: `${credentialProviderLabel(credential)} - ${credential.label} (${credentialValidationLabel(credential)})`,
      })),
  ];
}

function credentialRefFromValue(value: string): CredentialReference | null {
  const [type, refValue] = value.split(":", 2);
  if ((type === "alias" || type === "credential_id") && refValue) {
    return { type, value: refValue };
  }
  return null;
}

function providerLabel(provider: string) {
  return provider
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
