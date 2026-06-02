import { queryKeys } from "../query-keys";
import { exact, family } from "./targets";
import type {
  QueryInvalidationReason,
  QueryInvalidationScope,
  QueryInvalidationTarget,
} from "./types";

export function invalidationTargetsForReason(
  reason: QueryInvalidationReason,
  scope: QueryInvalidationScope = {},
): QueryInvalidationTarget[] {
  const { workspaceId, agentId, sessionKey } = scope;

  switch (reason) {
    case "auth":
      return [
        exact(queryKeys.auth.state()),
        family(queryKeys.agents.all),
        family(queryKeys.setup.all),
      ];
    case "agent":
      return [
        workspaceId
          ? exact(queryKeys.agents.list(workspaceId))
          : family(queryKeys.agents.lists()),
        agentId
          ? exact(queryKeys.agents.detail(agentId))
          : family(queryKeys.agents.details()),
        agentId && workspaceId
          ? exact(queryKeys.agents.runtimeProfile(agentId, workspaceId))
          : family(queryKeys.agents.runtimeProfiles()),
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
        agentId
          ? exact(queryKeys.agentHealth.detail(agentId))
          : family(queryKeys.agentHealth.all),
      ];
    case "setup":
      return [
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
        agentId
          ? exact(queryKeys.agentHealth.detail(agentId))
          : family(queryKeys.agentHealth.all),
      ];
    case "health":
      return [
        agentId
          ? exact(queryKeys.agentHealth.detail(agentId))
          : family(queryKeys.agentHealth.all),
      ];
    case "dashboard":
      return agentId
        ? [
            exact(queryKeys.agentDashboard.latestRun(agentId)),
            family(queryKeys.agentDashboard.runHistories()),
            family(queryKeys.agentDashboard.tasksLists()),
            family(queryKeys.agentDashboard.configStates()),
          ]
        : [family(queryKeys.agentDashboard.all)];
    case "message":
      return [
        agentId && sessionKey
          ? exact(queryKeys.messages.history(agentId, sessionKey))
          : family(queryKeys.messages.histories()),
      ];
    case "session":
      return [
        workspaceId
          ? family(queryKeys.sessions.orchestrator(workspaceId))
          : family(queryKeys.sessions.orchestratorLists()),
        family(queryKeys.sessions.worker()),
      ];
    case "tool":
      return [
        agentId && workspaceId
          ? exact(queryKeys.tools.agent(agentId, workspaceId))
          : family(queryKeys.tools.agentLists()),
        workspaceId
          ? exact(queryKeys.tools.catalog(workspaceId))
          : family(queryKeys.tools.catalogs()),
        workspaceId
          ? exact(queryKeys.agents.list(workspaceId))
          : family(queryKeys.agents.lists()),
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
        agentId && workspaceId
          ? exact(queryKeys.agentDashboard.configState(agentId, workspaceId))
          : family(queryKeys.agentDashboard.configStates()),
      ];
    case "local_runtime":
      return [
        workspaceId
          ? exact(queryKeys.localRuntimes.list(workspaceId))
          : family(queryKeys.localRuntimes.lists()),
        workspaceId
          ? exact(queryKeys.agents.list(workspaceId))
          : family(queryKeys.agents.lists()),
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
      ];
    case "plan":
      return [
        workspaceId
          ? exact(queryKeys.plans.list(workspaceId))
          : family(queryKeys.plans.lists()),
        workspaceId
          ? exact(queryKeys.workItems.list(workspaceId))
          : family(queryKeys.workItems.lists()),
        family(queryKeys.manager.all),
      ];
    case "work_item":
      return [
        workspaceId
          ? exact(queryKeys.workItems.list(workspaceId))
          : family(queryKeys.workItems.lists()),
        workspaceId
          ? exact(queryKeys.manager.status(workspaceId))
          : family(queryKeys.manager.statuses()),
      ];
    case "manager":
      return [
        workspaceId
          ? exact(queryKeys.manager.status(workspaceId))
          : family(queryKeys.manager.statuses()),
        workspaceId && agentId
          ? exact(queryKeys.manager.config(workspaceId, agentId))
          : family(queryKeys.manager.configs()),
        workspaceId && agentId
          ? family(queryKeys.scheduledTasks.list(workspaceId, agentId))
          : family(queryKeys.scheduledTasks.all),
      ];
    case "scheduled_task":
      return [
        workspaceId && agentId
          ? family(queryKeys.scheduledTasks.list(workspaceId, agentId))
          : family(queryKeys.scheduledTasks.all),
        workspaceId
          ? exact(queryKeys.manager.status(workspaceId))
          : family(queryKeys.manager.statuses()),
      ];
    case "credential":
      return [
        family(queryKeys.credentials.all),
        workspaceId
          ? exact(queryKeys.agents.list(workspaceId))
          : family(queryKeys.agents.lists()),
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
        agentId
          ? exact(queryKeys.agentHealth.detail(agentId))
          : family(queryKeys.agentHealth.all),
      ];
    case "model_catalog":
      return [
        workspaceId
          ? exact(queryKeys.models.catalog(workspaceId))
          : family(queryKeys.models.catalogs()),
      ];
    case "runtime_diagnostic":
      return [
        family(queryKeys.sessions.worker()),
        agentId
          ? exact(queryKeys.agentHealth.detail(agentId))
          : family(queryKeys.agentHealth.all),
        agentId
          ? exact(queryKeys.setup.byAgent(agentId))
          : family(queryKeys.setup.all),
      ];
  }
}
