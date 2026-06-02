import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "../query-keys";
import { invalidateQueryFamily } from "./targets";

export function invalidateAgentQueries(
  queryClient: QueryClient,
  workspaceId: string,
  agentId?: string,
): Promise<void> {
  const invalidations: Array<Promise<void>> = [
    invalidateQueryFamily(queryClient, queryKeys.agents.list(workspaceId)),
  ];

  if (agentId) {
    invalidations.push(
      invalidateQueryFamily(queryClient, queryKeys.agents.detail(agentId)),
      invalidateQueryFamily(queryClient, queryKeys.setup.byAgent(agentId)),
      invalidateQueryFamily(queryClient, queryKeys.agentHealth.detail(agentId)),
      invalidateQueryFamily(
        queryClient,
        queryKeys.agents.runtimeProfile(agentId, workspaceId),
      ),
    );
  }

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidateAgentToolState(
  queryClient: QueryClient,
  input: { agentId: string; workspaceId: string },
): Promise<void> {
  const { agentId, workspaceId } = input;

  return Promise.all([
    invalidateQueryFamily(
      queryClient,
      queryKeys.tools.agent(agentId, workspaceId),
    ),
    invalidateQueryFamily(queryClient, queryKeys.tools.catalog(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.agents.list(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.setup.byAgent(agentId)),
    invalidateQueryFamily(
      queryClient,
      queryKeys.agentDashboard.configState(agentId, workspaceId),
    ),
  ]).then(() => undefined);
}

export function invalidateRuntimeQueries(
  queryClient: QueryClient,
  agentId: string,
  sessionKey?: string,
  options: { messagesCanChange?: boolean } = {},
): Promise<void> {
  const invalidations: Array<Promise<void>> = [
    invalidateQueryFamily(
      queryClient,
      queryKeys.agentDashboard.latestRun(agentId),
    ),
    invalidateQueryFamily(queryClient, queryKeys.agentDashboard.runHistories()),
    invalidateQueryFamily(queryClient, queryKeys.agentDashboard.tasksLists()),
    invalidateQueryFamily(queryClient, queryKeys.setup.byAgent(agentId)),
    invalidateQueryFamily(queryClient, queryKeys.sessions.orchestratorLists()),
    invalidateQueryFamily(queryClient, queryKeys.sessions.worker()),
  ];

  if (options.messagesCanChange === false) {
    return Promise.all(invalidations).then(() => undefined);
  }

  if (sessionKey) {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.messages.history(agentId, sessionKey),
      ),
    );
  } else {
    invalidations.push(
      invalidateQueryFamily(queryClient, queryKeys.messages.histories()),
    );
  }

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidateAgentDashboardQueries(
  queryClient: QueryClient,
  agentId: string,
  workspaceId?: string | null,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries(
      { queryKey: queryKeys.agentDashboard.latestRun(agentId) },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      { queryKey: queryKeys.agentDashboard.runHistories() },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      { queryKey: queryKeys.agentDashboard.tasksLists() },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      {
        queryKey: queryKeys.agentDashboard.configState(agentId, workspaceId),
      },
      { throwOnError: true },
    ),
  ]).then(() => undefined);
}

export function invalidateAgentRuntimeQueries(
  queryClient: QueryClient,
  agentId: string,
  workspaceId?: string | null,
): Promise<void> {
  return Promise.all([
    invalidateQueryFamily(queryClient, queryKeys.setup.byAgent(agentId)),
    invalidateQueryFamily(queryClient, queryKeys.agentHealth.detail(agentId)),
    invalidateQueryFamily(queryClient, queryKeys.sessions.worker()),
    invalidateQueryFamily(queryClient, queryKeys.runtimeAgents.list()),
    invalidateAgentDashboardQueries(queryClient, agentId, workspaceId),
  ]).then(() => undefined);
}

type RuntimeDiagnosticsInvalidationOptions = {
  agentId?: string | null;
  workspaceId?: string | null;
  orchestratorScopeKey?: string | null;
};

export function invalidateRuntimeDiagnostics(
  queryClient: QueryClient,
  options: RuntimeDiagnosticsInvalidationOptions = {},
): Promise<void> {
  const invalidations: Array<Promise<void>> = [
    invalidateQueryFamily(queryClient, queryKeys.sessions.worker()),
  ];

  if (options.orchestratorScopeKey) {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.sessions.orchestrator(options.orchestratorScopeKey),
      ),
    );
  } else {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.sessions.orchestratorLists(),
      ),
    );
  }

  if (options.agentId) {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.setup.byAgent(options.agentId),
      ),
      invalidateQueryFamily(
        queryClient,
        queryKeys.agentHealth.detail(options.agentId),
      ),
      invalidateQueryFamily(
        queryClient,
        queryKeys.agentDiagnostics.detail(options.agentId, options.workspaceId),
      ),
    );
  }

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidateWorkspaceConfigQueries(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return Promise.all([
    invalidateQueryFamily(queryClient, queryKeys.tools.catalog(workspaceId)),
    invalidateQueryFamily(
      queryClient,
      queryKeys.localRuntimes.list(workspaceId),
    ),
    invalidateQueryFamily(queryClient, queryKeys.plans.list(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.workItems.list(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.manager.status(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.models.catalog(workspaceId)),
  ]).then(() => undefined);
}

export function invalidateAgentReadinessQueries(
  queryClient: QueryClient,
  input: {
    workspaceId?: string | null;
    agentIds?: Array<string | null | undefined>;
  },
): Promise<void> {
  const agentIds = [
    ...new Set(
      input.agentIds?.filter((agentId): agentId is string =>
        Boolean(agentId),
      ) ?? [],
    ),
  ];
  const invalidations: Array<Promise<void>> = [
    invalidateQueryFamily(queryClient, queryKeys.auth.state()),
    invalidateQueryFamily(queryClient, queryKeys.agents.all),
    invalidateQueryFamily(queryClient, queryKeys.credentials.all),
    invalidateQueryFamily(queryClient, queryKeys.models.all),
  ];

  if (input.workspaceId) {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.localRuntimes.list(input.workspaceId),
      ),
      invalidateQueryFamily(queryClient, queryKeys.models.catalogs()),
    );
  } else {
    invalidations.push(
      invalidateQueryFamily(queryClient, queryKeys.localRuntimes.all),
    );
  }

  for (const agentId of agentIds) {
    invalidations.push(
      invalidateQueryFamily(queryClient, queryKeys.setup.byAgent(agentId)),
      invalidateQueryFamily(queryClient, queryKeys.agentHealth.detail(agentId)),
    );
  }

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidatePlansAndWorkItems(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return Promise.all([
    invalidateQueryFamily(queryClient, queryKeys.plans.list(workspaceId)),
    invalidateQueryFamily(queryClient, queryKeys.workItems.list(workspaceId)),
  ]).then(() => undefined);
}

export function invalidateManagerWorkspace(
  queryClient: QueryClient,
  workspaceId: string,
  agentId?: string | null,
): Promise<void> {
  const invalidations: Array<Promise<void>> = [
    invalidateQueryFamily(queryClient, queryKeys.manager.status(workspaceId)),
  ];

  if (agentId) {
    invalidations.push(
      invalidateQueryFamily(
        queryClient,
        queryKeys.manager.config(workspaceId, agentId),
      ),
      invalidateQueryFamily(
        queryClient,
        queryKeys.scheduledTasks.list(workspaceId, agentId),
      ),
    );
  } else {
    invalidations.push(
      invalidateQueryFamily(queryClient, queryKeys.manager.all),
      invalidateQueryFamily(queryClient, queryKeys.scheduledTasks.all),
    );
  }

  return Promise.all(invalidations).then(() => undefined);
}
