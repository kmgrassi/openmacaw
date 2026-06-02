import type { ManagerAgentConfigResponse } from "../../../../../../contracts/manager-agent";
import type { PlanRecord } from "../../../api/plans";
import type { Agent } from "../../../types/agents";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { FieldMessage } from "../../ui/FieldMessage";
import { Select } from "../../ui/Select";
import {
  CADENCE_OPTIONS,
  formatCadence,
  formatPlanFilter,
  formatState,
  MANAGER_STATES,
  type ManagerState,
} from "./utils";

type SelectOption = {
  value: string;
  label: string;
};

type ManagerAgentOverridesProps = {
  managerAgents: Agent[];
  configAgentOptions: SelectOption[];
  selectedConfigAgentId: string;
  setSelectedConfigAgentId: (agentId: string) => void;
  config: ManagerAgentConfigResponse | null;
  configLoading: boolean;
  configSaving: boolean;
  configError: string | null;
  configSuccess: boolean;
  cadenceMode: "workspace" | "override";
  setCadenceMode: (mode: "workspace" | "override") => void;
  overrideCadenceMs: string;
  setOverrideCadenceMs: (cadenceMs: string) => void;
  statesMode: "workspace" | "override";
  setStatesMode: (mode: "workspace" | "override") => void;
  selectedStates: ManagerState[];
  plansMode: "workspace" | "override";
  setPlansMode: (mode: "workspace" | "override") => void;
  selectedPlanIds: string[];
  setSelectedPlanIds: (planIds: string[]) => void;
  plans: PlanRecord[];
  planOptions: SelectOption[];
  toggleState: (state: ManagerState) => void;
  canSaveConfig: boolean;
  onSaveConfig: () => void;
};

export function ManagerAgentOverrides({
  managerAgents,
  configAgentOptions,
  selectedConfigAgentId,
  setSelectedConfigAgentId,
  config,
  configLoading,
  configSaving,
  configError,
  configSuccess,
  cadenceMode,
  setCadenceMode,
  overrideCadenceMs,
  setOverrideCadenceMs,
  statesMode,
  setStatesMode,
  selectedStates,
  plansMode,
  setPlansMode,
  selectedPlanIds,
  setSelectedPlanIds,
  plans,
  planOptions,
  toggleState,
  canSaveConfig,
  onSaveConfig,
}: ManagerAgentOverridesProps) {
  return (
    <Card>
      <div className="mb-4">
        <h3 className="text-sm font-medium text-slate-300">
          Per-Agent Overrides
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Override manager cadence and due-task filters for one manager agent.
        </p>
      </div>

      <Select
        label="Agent"
        value={selectedConfigAgentId}
        onChange={(event) => setSelectedConfigAgentId(event.target.value)}
        options={configAgentOptions}
        disabled={managerAgents.length === 0}
      />

      {managerAgents.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          No manager agents are available in this workspace.
        </p>
      )}

      {configLoading && (
        <p className="mt-3 text-xs text-slate-500">Loading manager settings.</p>
      )}

      {configError && !config && (
        <FieldMessage tone="error" className="mt-3">
          {configError}
        </FieldMessage>
      )}

      {config && (
        <div className="mt-4 space-y-5">
          <div className="rounded-md border border-border bg-surface p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-slate-400">
                  Cadence
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Effective: {formatCadence(config.effectiveCadenceMs)}
                  {config.cadenceMs === null
                    ? ` from workspace default (${formatCadence(config.workspaceCadenceMs)})`
                    : " from agent override"}
                </div>
              </div>
              <Badge
                variant={config.cadenceMs === null ? "default" : "warning"}
              >
                {config.cadenceMs === null ? "workspace" : "override"}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="radio"
                  checked={cadenceMode === "workspace"}
                  onChange={() => setCadenceMode("workspace")}
                />
                Use workspace default
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="radio"
                    checked={cadenceMode === "override"}
                    onChange={() => setCadenceMode("override")}
                  />
                  Override
                </label>
                <select
                  value={overrideCadenceMs}
                  onChange={(event) => setOverrideCadenceMs(event.target.value)}
                  disabled={cadenceMode !== "override"}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                >
                  {CADENCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border bg-surface p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-slate-400">
                  Due-task state filter
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Effective:{" "}
                  {(config.effectiveDueTaskQuery.states ?? [])
                    .map(formatState)
                    .join(", ")}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setStatesMode("workspace")}
              >
                Clear override
              </Button>
            </div>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="radio"
                  checked={statesMode === "workspace"}
                  onChange={() => setStatesMode("workspace")}
                />
                Use workspace default
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="radio"
                  checked={statesMode === "override"}
                  onChange={() => setStatesMode("override")}
                />
                Override states
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {MANAGER_STATES.map((state) => (
                <Checkbox
                  key={state}
                  containerClassName="flex rounded border border-border bg-surface-raised px-3 py-2"
                  labelClassName="capitalize"
                  label={formatState(state)}
                  checked={selectedStates.includes(state)}
                  disabled={statesMode !== "override"}
                  onChange={() => toggleState(state)}
                />
              ))}
            </div>
            {statesMode === "override" && selectedStates.length === 0 && (
              <FieldMessage tone="error" className="mt-2">
                Select at least one state.
              </FieldMessage>
            )}
          </div>

          <div className="rounded-md border border-border bg-surface p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-slate-400">
                  Due-task plan filter
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Effective:{" "}
                  {formatPlanFilter(
                    config.effectiveDueTaskQuery.planIds,
                    plans,
                  )}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPlansMode("workspace")}
              >
                Clear override
              </Button>
            </div>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="radio"
                  checked={plansMode === "workspace"}
                  onChange={() => setPlansMode("workspace")}
                />
                Use workspace default
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="radio"
                  checked={plansMode === "override"}
                  onChange={() => setPlansMode("override")}
                />
                Override plans
              </label>
            </div>
            <select
              multiple
              value={selectedPlanIds}
              onChange={(event) =>
                setSelectedPlanIds(
                  Array.from(event.target.selectedOptions).map(
                    (option) => option.value,
                  ),
                )
              }
              disabled={plansMode !== "override" || planOptions.length === 0}
              className="h-32 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {planOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {planOptions.length === 0 && (
              <p className="mt-2 text-xs text-slate-500">
                No plans are available in this workspace.
              </p>
            )}
            {plansMode === "override" &&
              planOptions.length > 0 &&
              selectedPlanIds.length === 0 && (
                <FieldMessage tone="error" className="mt-2">
                  Select at least one plan.
                </FieldMessage>
              )}
          </div>

          {configError && (
            <FieldMessage tone="error">{configError}</FieldMessage>
          )}
          {configSuccess && (
            <FieldMessage tone="success">Manager overrides saved.</FieldMessage>
          )}

          <div className="flex justify-end">
            <Button
              loading={configSaving}
              disabled={!canSaveConfig}
              onClick={() => void onSaveConfig()}
            >
              Save overrides
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
