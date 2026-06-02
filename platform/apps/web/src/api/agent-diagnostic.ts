import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type ClaudeCodeDiagnosticStatus =
  | "not_applicable"
  | "missing_anthropic_credential"
  | "unsupported_runtime_runner"
  | "runtime_bridge_startup_failed"
  | "ready";

export type ClaudeCodeDiagnostic = {
  applicable: boolean;
  status: ClaudeCodeDiagnosticStatus;
  runnerKind: "claude_code" | null;
  provider: string | null;
  model: string | null;
  credential: {
    provider: "anthropic";
    required: boolean;
    ready: boolean;
    reference: unknown;
  };
  runtimeBridge: {
    reported: boolean;
    available: boolean | null;
    status: string | null;
    sessionId: string | null;
    failure: string | null;
  };
  permissions: {
    toolProfile: string | null;
    permissionMode: "acceptEdits";
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
  };
  blockers: string[];
};

export type CodexOAuthDiagnosticStatus =
  | "not_applicable"
  | "missing_codex_oauth_credential"
  | "token_expired"
  | "launcher_unhealthy"
  | "runtime_bridge_startup_failed"
  | "ready";

export type CodexOAuthDiagnostic = {
  applicable: boolean;
  status: CodexOAuthDiagnosticStatus;
  runnerKind: "codex" | null;
  provider: string | null;
  model: string | null;
  credential: {
    provider: "openai_codex";
    authMode: "oauth";
    required: boolean;
    ready: boolean;
    reference: unknown;
    credentialRowId: string | null;
    validationState: string | null;
    validatedAt: string | null;
    token: {
      present: boolean;
      refreshable: boolean;
      expiresAt: number | null;
      expired: boolean | null;
    };
  };
  runtimeBridge: {
    reported: boolean;
    available: boolean | null;
    status: string | null;
    sessionId: string | null;
    failure: string | null;
    credentialEnv: "OPENAI_API_KEY";
  };
  blockers: string[];
};

export type AgentDiagnosticAgentSection = {
  found: boolean;
  name: string | null;
  type: string | null;
  model_settings?: unknown;
};

export type AgentDiagnosticRoutingMatch = {
  ruleId: string;
  ruleName: string | null;
  runnerKind: string | null;
  provider: string | null;
  model: string | null;
  matches: Array<{
    kind: string;
    key: string | null;
    value: string;
    wouldMatch: boolean;
  }>;
  allMatchesPass: boolean;
};

export type AgentDiagnosticRoutingSection = {
  rulesInWorkspace: number;
  matchesForAgent: AgentDiagnosticRoutingMatch[];
  selectedRule: {
    id: string;
    runnerKind: string;
    model: string;
  } | null;
  selectionReason: string;
};

export type AgentDiagnosticExecutionProfileSection = {
  resolved: boolean;
  missing: string[];
  profile: {
    runnerKind: string | null;
    provider: string | null;
    model: string | null;
    credentialRef: unknown;
    toolProfile: string | null;
  } | null;
  source: {
    routingRuleId: string | null;
    fallbackUsed: boolean;
    legacyGatewayConfigUsed: boolean;
  };
};

export type AgentDiagnosticResponse = {
  timestamp: string;
  agentId: string;
  workspaceId: string | null;
  canChat: boolean;
  blockers: string[];
  codexOAuth?: CodexOAuthDiagnostic;
  claudeCode?: ClaudeCodeDiagnostic;
  agent?: AgentDiagnosticAgentSection;
  routing?: AgentDiagnosticRoutingSection;
  executionProfile?: AgentDiagnosticExecutionProfileSection;
};

export function getAgentDiagnostic(agentId: string, workspaceId?: string | null) {
  return apiFetch<AgentDiagnosticResponse>(ROUTES.agentDiagnostic(agentId, workspaceId), {
    defaultErrorMessage: (status) => `agent diagnostic request failed (${status})`,
  });
}
