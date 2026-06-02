import { useCallback, useMemo } from "react";
import {
  makeSessionKey,
  type AuthStateAgent,
  type RuntimeScope,
} from "../../api/ws-types";
import { invalidateAgentData } from "../../api/query-client";
import { useAgentsQuery } from "../../hooks/useAgents";
import { useAuthStore } from "../../stores/auth";
import { RuntimeChatPanel } from "../dashboard/RuntimeChatPanel";
import { Badge } from "../ui/Badge";
import { ManagerAgentDefaults } from "./ManagerAgentSection/ManagerAgentDefaults";
import { ManagerAgentOverrides } from "./ManagerAgentSection/ManagerAgentOverrides";
import { ManagerScheduledTasks } from "./ManagerAgentSection/ManagerScheduledTasks";
import { ManagerAgentStatus } from "./ManagerAgentSection/ManagerAgentStatus";
import { useManagerAgentActivation } from "./ManagerAgentSection/useManagerAgentActivation";
import { useManagerAgentConfig } from "./ManagerAgentSection/useManagerAgentConfig";
import { useManagerRuntimeStatus } from "./ManagerAgentSection/useManagerRuntimeStatus";
import { formatStatus, statusBadgeVariant } from "./ManagerAgentSection/utils";

export function ManagerAgentSection() {
  const { workspaceId, managerAgent } = useAuthStore();
  const { data: agents = [] } = useAgentsQuery(workspaceId);

  const manager = useMemo(() => {
    if (managerAgent.agentId) {
      return agents.find((agent) => agent.id === managerAgent.agentId) ?? null;
    }
    return (
      agents.find(
        (agent) =>
          agent.agentType === "manager" && agent.workspaceId === workspaceId,
      ) ?? null
    );
  }, [agents, managerAgent.agentId, workspaceId]);

  const agentId = managerAgent.agentId ?? manager?.id ?? null;
  const managerAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.agentType === "manager" && agent.workspaceId === workspaceId,
      ),
    [agents, workspaceId],
  );
  const managerChatScope = useMemo<RuntimeScope | null>(() => {
    if (!agentId || !workspaceId) return null;
    return {
      agentId,
      workspaceId,
      sessionKey: makeSessionKey(agentId),
    };
  }, [agentId, workspaceId]);

  const { status, statusError, loadStatus } = useManagerRuntimeStatus({
    workspaceId,
  });

  const configState = useManagerAgentConfig({
    workspaceId,
    agentId,
  });
  const reloadAgents = useCallback(async () => {
    await invalidateAgentData({ workspaceId });
  }, [workspaceId]);

  const activation = useManagerAgentActivation({
    workspaceId,
    agentId,
    reloadAgents,
    loadStatus,
    saveConfigPatch: configState.saveConfigPatch,
  });

  const managerChatTarget = useMemo<AuthStateAgent | null>(() => {
    if (!agentId) return null;
    return {
      id: agentId,
      name: manager?.name ?? "Manager Agent",
      model: manager?.model ?? activation.model,
      provider: manager?.provider ?? activation.provider,
      hasCredentials:
        manager?.hasCredentials ?? !managerAgent.missing.includes("credential"),
      isResolved: false,
    };
  }, [
    activation.model,
    activation.provider,
    agentId,
    manager,
    managerAgent.missing,
  ]);

  const configAgentOptions = [
    { value: "", label: "Select an agent" },
    ...managerAgents.map((agent) => ({
      value: agent.id,
      label: agent.name || agent.id,
    })),
  ];
  const missingRequirements = status ? status.missing : managerAgent.missing;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">
            Scheduled Agent
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Configure the scheduler for the workspace manager agent and monitor
            its runtime status.
          </p>
        </div>
        <Badge
          variant={statusBadgeVariant(status?.status ?? "unknown")}
          className="self-start capitalize"
        >
          {formatStatus(status?.status ?? "unknown")}
        </Badge>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <ManagerAgentDefaults
            agentId={agentId}
            workspaceId={workspaceId}
            provider={activation.provider}
            setProvider={activation.setProvider}
            model={activation.model}
            setModel={activation.setModel}
            baseUrl={activation.baseUrl}
            setBaseUrl={activation.setBaseUrl}
            cadenceMs={activation.cadenceMs}
            setCadenceMs={activation.setCadenceMs}
            credentialMode={activation.credentialMode}
            setCredentialMode={activation.setCredentialMode}
            selectedRef={activation.selectedRef}
            setSelectedRef={activation.setSelectedRef}
            localProvider={activation.localProvider}
            credentialOptions={activation.credentialOptions}
            filteredCredentials={activation.filteredCredentials}
            loadingCredentials={activation.loadingCredentials}
            activationError={activation.activationError}
            activationSuccess={activation.activationSuccess}
            activating={activation.activating}
            canActivate={activation.canActivate}
            onActivate={activation.handleActivate}
            onActivateWithCredential={(credential) =>
              activation.handleActivate(credential)
            }
          />

          <ManagerAgentOverrides
            managerAgents={managerAgents}
            configAgentOptions={configAgentOptions}
            selectedConfigAgentId={configState.selectedConfigAgentId}
            setSelectedConfigAgentId={configState.setSelectedConfigAgentId}
            config={configState.config}
            configLoading={configState.configLoading}
            configSaving={configState.configSaving}
            configError={configState.configError}
            configSuccess={configState.configSuccess}
            cadenceMode={configState.cadenceMode}
            setCadenceMode={configState.setCadenceMode}
            overrideCadenceMs={configState.overrideCadenceMs}
            setOverrideCadenceMs={configState.setOverrideCadenceMs}
            statesMode={configState.statesMode}
            setStatesMode={configState.setStatesMode}
            selectedStates={configState.selectedStates}
            plansMode={configState.plansMode}
            setPlansMode={configState.setPlansMode}
            selectedPlanIds={configState.selectedPlanIds}
            setSelectedPlanIds={configState.setSelectedPlanIds}
            plans={configState.plans}
            planOptions={configState.planOptions}
            toggleState={configState.toggleState}
            canSaveConfig={configState.canSaveConfig}
            onSaveConfig={configState.handleConfigSave}
          />

          <ManagerScheduledTasks workspaceId={workspaceId} agentId={agentId} />
        </div>

        <ManagerAgentStatus
          agentId={agentId}
          manager={manager}
          provider={activation.provider}
          workspaceId={workspaceId}
          status={status}
          statusError={statusError}
          missingRequirements={missingRequirements}
          onRefresh={loadStatus}
        />
      </div>

      <RuntimeChatPanel
        scope={managerChatScope}
        target={managerChatTarget}
        loading={!agentId}
        hasCredentials={managerChatTarget?.hasCredentials ?? false}
      />
    </div>
  );
}
