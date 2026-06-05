import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAgentsQuery, useCreateAgentMutation } from "../../hooks/useAgents";
import { useUpdateDefaultAgentAssignmentMutation } from "../../hooks/useSetupQueries";
import { useAuthStore } from "../../stores/auth";
import type {
  AgentType,
  PlanningDestination,
} from "../../../../../contracts/agents";
import type { DefaultAgentRole } from "../../../../../contracts/setup";
import { DEFAULT_MODEL_ID } from "../../../../../contracts/model-catalog";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { HostedModelSelect } from "./HostedModelSelect";
import { AgentDetail } from "./AgentDetail";
import { ClaudeCodeSmokePanel } from "./ClaudeCodeSmokePanel";
import { ModelAgnosticSmokePanel } from "./ModelAgnosticSmokePanel";
import { LocalModelCodingSmokePanel } from "./LocalModelCodingSmokePanel";

const AGENT_KIND_OPTIONS: Array<{ value: AgentType; label: string }> = [
  { value: "coding", label: "Coding" },
  { value: "planning", label: "Planning" },
  { value: "manager", label: "Manager" },
  { value: "custom", label: "Custom" },
];

const PLANNING_DESTINATION_OPTIONS: Array<{
  value: PlanningDestination;
  label: string;
}> = [
  { value: "database", label: "Database" },
  { value: "linear", label: "Linear" },
];

type AgentsSettingsTab = "agents" | "diagnostics";

const AGENTS_SETTINGS_TABS: Array<{ id: AgentsSettingsTab; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "diagnostics", label: "Diagnostics" },
];

export function AgentsSection() {
  const { agentId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { workspaceId, defaultAgents, applyAuthState } = useAuthStore();
  const { data: agents = [], isLoading: loading, error } = useAgentsQuery();
  const createAgent = useCreateAgentMutation();
  const updateDefaultAgentAssignment =
    useUpdateDefaultAgentAssignmentMutation();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AgentType>("coding");
  const [newModel, setNewModel] = useState(DEFAULT_MODEL_ID);
  const [planningDestination, setPlanningDestination] =
    useState<PlanningDestination>("database");
  const [customBackendType, setCustomBackendType] = useState("openclaw_ws");
  const [customBaseUrl, setCustomBaseUrl] = useState("ws://127.0.0.1:7788");
  const [customAgentId, setCustomAgentId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [savingDefaultRole, setSavingDefaultRole] =
    useState<DefaultAgentRole | null>(null);
  const [activeTab, setActiveTab] = useState<AgentsSettingsTab>("agents");

  const isNewAgentRoute =
    pathname.replace(/\/+$/, "") === "/settings/agents/new";
  const selectedAgent = isNewAgentRoute
    ? null
    : (agents.find((agent) => agent.id === agentId) ?? null);

  const defaultOptions = (role: DefaultAgentRole) => [
    { value: "", label: `No ${role} default selected` },
    ...agents
      .filter(
        (agent) =>
          agent.agentType === role && agent.workspaceId === workspaceId,
      )
      .map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const handleDefaultAssignmentChange = async (
    role: DefaultAgentRole,
    selectedAgentId: string,
  ) => {
    if (!workspaceId || !selectedAgentId) return;
    setAssignmentError(null);
    setSavingDefaultRole(role);
    try {
      const auth = await updateDefaultAgentAssignment.mutateAsync({
        workspaceId,
        role,
        agentId: selectedAgentId,
      });
      applyAuthState(auth);
    } catch (err) {
      setAssignmentError((err as Error).message);
    } finally {
      setSavingDefaultRole(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    if (!workspaceId) {
      setCreateError("Workspace is required before creating an agent.");
      return;
    }
    if (
      newType === "custom" &&
      (!customBackendType.trim() ||
        !customBaseUrl.trim() ||
        !customAgentId.trim())
    ) {
      setCreateError(
        "Custom agents require a backend type, base URL, and target agent ID.",
      );
      return;
    }
    setCreateError(null);
    try {
      const created = await createAgent.mutateAsync({
        name: newName.trim(),
        workspaceId,
        type: newType,
        model: newModel.trim() || null,
        planningDestination,
        customTarget:
          newType === "custom"
            ? {
                backendType: customBackendType.trim(),
                baseUrl: customBaseUrl.trim(),
                agentId: customAgentId.trim(),
              }
            : undefined,
      });
      setNewName("");
      setNewType("coding");
      setNewModel(DEFAULT_MODEL_ID);
      setPlanningDestination("database");
      setCustomBackendType("openclaw_ws");
      setCustomBaseUrl("ws://127.0.0.1:7788");
      setCustomAgentId("");
      setCreating(false);
      navigate(`/settings/agents/${created.id}`);
    } catch (err) {
      setCreateError(String(err));
    }
  };

  const resetCreateForm = () => {
    setNewName("");
    setNewType("coding");
    setNewModel(DEFAULT_MODEL_ID);
    setPlanningDestination("database");
    setCustomBackendType("openclaw_ws");
    setCustomBaseUrl("ws://127.0.0.1:7788");
    setCustomAgentId("");
    setCreateError(null);
  };

  const handleCancelCreate = () => {
    resetCreateForm();
    setCreating(false);
    if (isNewAgentRoute) {
      navigate("/settings/agents");
    }
  };

  const createAgentCard = (
    <Card>
      <h4 className="mb-3 text-sm font-medium text-slate-300">Create agent</h4>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            label="Agent name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Planning Agent"
            onKeyDown={(e) =>
              e.key === "Enter" && newType !== "custom" && void handleCreate()
            }
            autoFocus
          />
          <HostedModelSelect
            label="Primary model"
            value={newModel}
            workspaceId={workspaceId}
            onChange={setNewModel}
          />
        </div>

        <SegmentedControl
          label="Agent type"
          value={newType}
          onValueChange={setNewType}
          options={AGENT_KIND_OPTIONS}
          columns={4}
          fullWidth
          surface="raised"
        />

        {newType === "planning" && (
          <Select
            label="Planning destination"
            value={planningDestination}
            onChange={(event) =>
              setPlanningDestination(event.target.value as PlanningDestination)
            }
            options={PLANNING_DESTINATION_OPTIONS}
          />
        )}

        {newType === "custom" && (
          <div className="grid gap-3 md:grid-cols-3">
            <Input
              label="Backend type"
              value={customBackendType}
              onChange={(event) => setCustomBackendType(event.target.value)}
              placeholder="openclaw_ws"
            />
            <Input
              label="Base URL"
              value={customBaseUrl}
              onChange={(event) => setCustomBaseUrl(event.target.value)}
              placeholder="ws://127.0.0.1:7788"
            />
            <Input
              label="Target agent ID"
              value={customAgentId}
              onChange={(event) => setCustomAgentId(event.target.value)}
              placeholder="planner-local"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleCancelCreate}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!newName.trim() || !workspaceId}
            onClick={() => void handleCreate()}
          >
            Create
          </Button>
        </div>
      </div>
      {createError && (
        <p className="mt-2 text-xs text-red-400">{createError}</p>
      )}
    </Card>
  );

  if (selectedAgent) {
    return <AgentDetail key={selectedAgent.id} agent={selectedAgent} />;
  }

  if (isNewAgentRoute) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">New agent</h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose the agent type, model, and destination before configuring
            runtime and credentials.
          </p>
        </div>
        {createAgentCard}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">Agents</h2>
          <p className="mt-1 text-sm text-slate-400">
            Manage your AI agents, their identities, credentials, and model
            policies.
          </p>
        </div>
        {activeTab === "agents" && !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            New agent
          </Button>
        )}
      </div>

      <div className="flex gap-2 border-b border-border">
        {AGENTS_SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "border-blue-500 text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "diagnostics" ? (
        <>
          <ModelAgnosticSmokePanel />
          <ClaudeCodeSmokePanel />
          <LocalModelCodingSmokePanel />
        </>
      ) : (
        <>
          {/* Create form */}
          {creating && createAgentCard}

          <Card>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Select
                label="Default planning agent"
                value={defaultAgents.planning.agentId ?? ""}
                disabled={!workspaceId || savingDefaultRole !== null}
                onChange={(event) =>
                  void handleDefaultAssignmentChange(
                    "planning",
                    event.target.value,
                  )
                }
                options={defaultOptions("planning")}
              />
              <Select
                label="Default coding agent"
                value={defaultAgents.coding.agentId ?? ""}
                disabled={!workspaceId || savingDefaultRole !== null}
                onChange={(event) =>
                  void handleDefaultAssignmentChange(
                    "coding",
                    event.target.value,
                  )
                }
                options={defaultOptions("coding")}
              />
              <div className="text-xs text-slate-500">
                {savingDefaultRole
                  ? `Saving ${savingDefaultRole} default...`
                  : "Workspace defaults are per user."}
              </div>
            </div>
            {assignmentError && (
              <p className="mt-2 text-xs text-red-400">{assignmentError}</p>
            )}
          </Card>

          {loading && agents.length === 0 && (
            <p className="text-sm text-slate-400">Loading agents...</p>
          )}

          {error && (
            <div className="rounded-md bg-red-900/20 border border-red-600/30 px-3 py-2 text-sm text-red-400">
              {error.message}
            </div>
          )}

          <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-slate-500">
            {agents.length === 0 && !loading
              ? "Create an agent to configure it."
              : "Select an agent from the left menu to view details."}
          </div>
        </>
      )}
    </div>
  );
}
