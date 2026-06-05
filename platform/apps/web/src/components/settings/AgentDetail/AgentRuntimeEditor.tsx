import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listInstalledLocalModels,
  type InstalledLocalModel,
} from "../../../api/local-models";
import { prepareRuntime } from "../../../api/broker-runtime";
import { ensureStoredAgentDefaultRouting } from "../../../api/stored-agents";
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
  runtimeProvider: string;
  setRuntimeProvider: (value: string) => void;
  runtimeModel: string;
  setRuntimeModel: (value: string) => void;
  runtimeProfileLoading: boolean;
  runtimeProfileSaving: boolean;
  runtimeProfileDirty: boolean;
  runtimeProviderIsLocal: boolean;
  runtimeCredentialMissing: boolean;
  onRuntimeProfileSave: () => void;
  onAgentReload: () => Promise<void>;
  onError: (message: string) => void;
  onClearError: () => void;
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
  onAgentReload,
  onError,
  onClearError,
}: AgentRuntimeEditorProps) {
  const [startingRuntime, setStartingRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [ensuringRouting, setEnsuringRouting] = useState(false);

  const showLocalModelPicker =
    runtimeProvider === "local" || runtimeProvider === "openai_compatible";
  const [installedModels, setInstalledModels] = useState<
    InstalledLocalModel[] | null
  >(null);
  const [installedModelsError, setInstalledModelsError] = useState<
    string | null
  >(null);

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
          onChange={(event) => setRuntimeProvider(event.target.value)}
          options={RUNTIME_PROVIDER_OPTIONS}
          disabled={runtimeProfileLoading}
        />
        {showLocalModelPicker ? (
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
