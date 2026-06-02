import type { AgentDiagnosticResponse } from "../api/agent-diagnostic";
import type { AgentHealthResponse } from "../../../../contracts/agent-health";
import type { CapturedConsoleError } from "./browser-console-errors";
import type {
  AuthStateAgent,
  GatewayHelloOk,
  RuntimeScope,
} from "../api/ws-types";
import type {
  GatewayDiagnostics,
  GatewayStatus,
} from "../context/GatewayContext/types";
import type {
  DefaultAgentsAuthState,
  DefaultAgentsOnboardingState,
  ManagerAgentAuthState,
  SetupAuthState,
} from "../../../../contracts/setup";

export type DiagnosticsAuthSummary = {
  status: string;
  hasUser: boolean;
  workspaceId: string | null;
  resolvedAgentId: string | null;
  onboarding: DefaultAgentsOnboardingState;
  defaultAgents: DefaultAgentsAuthState;
  managerAgent: ManagerAgentAuthState;
  providerWarnings: string[];
  agents: SetupAuthState["agents"];
  workspaces: SetupAuthState["workspaces"];
};

export type DiagnosticsGatewaySummary = {
  connected: boolean;
  status: GatewayStatus;
  gatewayReady: boolean | null;
  scope: RuntimeScope | null;
  target: AuthStateAgent | null;
  hello: Omit<GatewayHelloOk, "auth" | "snapshot"> | null;
  diagnostics: GatewayDiagnostics;
  lastCloseReason: string | null;
};

export type DiagnosticsExportPayload = {
  version: 1;
  capturedAt: string;
  currentUrl: string;
  selected: {
    workspaceId: string | null;
    agentId: string | null;
  };
  authState: DiagnosticsAuthSummary;
  gateway: DiagnosticsGatewaySummary;
  agentHealth: AgentHealthResponse | null;
  agentDiagnostic: {
    canChat: boolean;
    blockers: string[];
    claudeCodeBlockers: string[];
    raw: AgentDiagnosticResponse;
  } | null;
  browserConsoleErrors: CapturedConsoleError[];
};

export function summarizeGatewayHello(
  hello: GatewayHelloOk | null,
): DiagnosticsGatewaySummary["hello"] {
  if (!hello) return null;
  return {
    type: hello.type,
    protocol: hello.protocol,
    server: hello.server,
    features: hello.features,
    policy: hello.policy,
  };
}

export function buildDiagnosticsExport(input: {
  capturedAt: string;
  currentUrl: string;
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  authState: DiagnosticsAuthSummary;
  gateway: Omit<DiagnosticsGatewaySummary, "hello" | "lastCloseReason"> & {
    hello: GatewayHelloOk | null;
  };
  agentHealth: AgentHealthResponse | null;
  agentDiagnostic: AgentDiagnosticResponse | null;
  browserConsoleErrors: CapturedConsoleError[];
}): DiagnosticsExportPayload {
  return {
    version: 1,
    capturedAt: input.capturedAt,
    currentUrl: input.currentUrl,
    selected: {
      workspaceId: input.selectedWorkspaceId,
      agentId: input.selectedAgentId,
    },
    authState: input.authState,
    gateway: {
      ...input.gateway,
      hello: summarizeGatewayHello(input.gateway.hello),
      lastCloseReason: input.gateway.diagnostics.lastCloseReason,
    },
    agentHealth: input.agentHealth,
    agentDiagnostic: input.agentDiagnostic
      ? {
          canChat: input.agentDiagnostic.canChat,
          blockers: input.agentDiagnostic.blockers,
          claudeCodeBlockers: input.agentDiagnostic.claudeCode?.blockers ?? [],
          raw: input.agentDiagnostic,
        }
      : null,
    browserConsoleErrors: input.browserConsoleErrors,
  };
}

export function formatDiagnosticsExport(
  payload: DiagnosticsExportPayload,
): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
