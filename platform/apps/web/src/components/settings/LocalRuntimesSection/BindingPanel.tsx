import type {
  LocalRuntime,
  LocalRuntimeRunner,
} from "../../../api/local-runtime";
import type { Agent } from "../../../types/agents";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { Select } from "../../ui/Select";
import type { LocalRuntimeRunnerAssignment } from "./useLocalRuntimesPage";

function agentLabel(agent: Agent) {
  return agent.agentType === "manager"
    ? `${agent.name} (manager)`
    : `${agent.name} (${agent.agentType})`;
}

function runnerLabel(runner: LocalRuntimeRunner) {
  if (runner.kind === "openclaw") {
    return `OpenClaw (${runner.endpoint})`;
  }
  return runner.model
    ? `${runner.model} (${runner.provider})`
    : `${runner.provider} (${runner.endpoint})`;
}

export function BindingPanel({
  agents,
  assignedRunnerByAgent,
  runtime,
  selectedRunnerByAgent,
  saving,
  onToggleAgent,
  onSave,
}: {
  agents: Agent[];
  assignedRunnerByAgent: Map<string, LocalRuntimeRunnerAssignment>;
  runtime: LocalRuntime;
  selectedRunnerByAgent: Map<string, string>;
  saving: boolean;
  onToggleAgent: (agentId: string, selected: boolean, runnerId: string) => void;
  onSave: () => void;
}) {
  const managerAgent = agents.find((agent) => agent.agentType === "manager");
  const attachableAgents = agents.filter(
    (agent) => agent.agentType !== "manager",
  );
  const runners = runtime.runners;
  const hasMultipleRunners = runners.length > 1;
  const firstRunnerId = runners[0]?.id ?? "";

  function selectedRunnerId(agentId: string): string {
    return selectedRunnerByAgent.get(agentId) ?? firstRunnerId;
  }

  function renderRunnerPicker(agentId: string) {
    if (!hasMultipleRunners) return null;
    return (
      <Select
        label="Runner kind"
        value={selectedRunnerId(agentId)}
        onChange={(event) => {
          const next = event.target.value;
          // Switching the runner kind for an already-bound agent re-binds it
          // to the new runner on save.
          if (selectedRunnerByAgent.has(agentId)) {
            onToggleAgent(agentId, true, next);
          } else {
            onToggleAgent(agentId, false, next);
            onToggleAgent(agentId, true, next);
          }
        }}
        options={runners.map((runner) => ({
          value: runner.id,
          label: runnerLabel(runner),
        }))}
      />
    );
  }

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Agent bindings</h3>
        <p className="mt-1 text-xs text-slate-500">
          {hasMultipleRunners
            ? "This helper advertises more than one runner kind. Pick which one each agent should dispatch to."
            : "The manager is a single toggle. Other workspace agents can be attached independently."}
        </p>
      </div>

      {managerAgent ? (
        <div className="space-y-2 rounded-md border border-white/5 bg-surface px-3 py-2">
          <Checkbox
            containerClassName="flex items-start gap-3"
            className="mt-1"
            label={
              <span className="text-sm font-medium text-slate-200">
                Bind to manager agent
              </span>
            }
            description={managerAgent.name}
            checked={selectedRunnerByAgent.has(managerAgent.id)}
            onChange={(event) =>
              onToggleAgent(
                managerAgent.id,
                event.target.checked,
                selectedRunnerId(managerAgent.id),
              )
            }
          />
          {selectedRunnerByAgent.has(managerAgent.id) &&
            renderRunnerPicker(managerAgent.id)}
        </div>
      ) : (
        <div className="rounded-md border border-amber-600/30 bg-amber-950/10 px-3 py-2 text-sm text-amber-200">
          No manager agent is loaded for this workspace.
        </div>
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium text-slate-400">Also attach to</div>
        {attachableAgents.map((agent) => {
          const assignedElsewhere = assignedRunnerByAgent.get(agent.id);
          const bound = selectedRunnerByAgent.has(agent.id);
          return (
            <div
              key={agent.id}
              className="space-y-2 rounded-md border border-white/5 bg-surface px-3 py-2"
            >
              <Checkbox
                containerClassName="flex items-start justify-between gap-3"
                className="mt-1"
                label={
                  <span className="text-sm text-slate-200">
                    {agentLabel(agent)}
                  </span>
                }
                description={
                  assignedElsewhere &&
                  assignedElsewhere.runtime.id !== runtime.id
                    ? `Currently bound to ${runnerLabel(assignedElsewhere.runner)}`
                    : "Hosted/default when unchecked"
                }
                checked={bound}
                onChange={(event) =>
                  onToggleAgent(
                    agent.id,
                    event.target.checked,
                    selectedRunnerId(agent.id),
                  )
                }
              />
              {bound && renderRunnerPicker(agent.id)}
            </div>
          );
        })}
        {attachableAgents.length === 0 && (
          <div className="rounded-md border border-white/5 bg-surface px-3 py-2 text-sm text-slate-400">
            No non-manager agents loaded.
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="sm" loading={saving} onClick={onSave}>
          Save bindings
        </Button>
      </div>
    </Card>
  );
}
