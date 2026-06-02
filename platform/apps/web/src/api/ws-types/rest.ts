import type { AgentId, WorkspaceId } from "./agent";
import type { SessionKey } from "./scope";

export type AuthStateAgent = {
  id: AgentId;
  name: string;
  model: string | null;
  provider: string | null;
  hasCredentials: boolean;
  isResolved: boolean;
};

export type AuthStateResponse = {
  readyToPrepare: boolean;
  reasons: string[];
  resolvedAgentId: AgentId | null;
  workspaceId: WorkspaceId | null;
  agents: AuthStateAgent[];
};

export type PrepareErrorAction =
  | "configure_tracker"
  | "configure_credential"
  | "configure_runner"
  | "configure_route"
  | "configure_runtime"
  | "configure_agent"
  | "select_model";

export type PrepareError = {
  /** Stable error code from the platform (e.g. "launcher_config_error", "agent_runtime_unconfigured"). */
  code: string;
  /** Human-readable message from the platform. */
  message: string;
  /** Specific code from the underlying launcher/orchestrator (e.g. "missing_tracker_kind"). */
  launcherErrorCode?: string;
  /** Free-form hint surfaced from the launcher to guide remediation. */
  resolutionHint?: string;
  /** Config keys the launcher reported as missing/invalid (e.g. ["tracker.kind"]). */
  requiredConfig?: string[];
  /** Suggested remediation action - used by the dashboard to render a fix button. */
  suggestedAction?: PrepareErrorAction;
  /** Raw error response body, retained for diagnostics. */
  raw?: unknown;
};

export type PrepareRuntimeResponse = {
  readyToConnect: boolean;
  reasons: string[];
  onboardingNextAction?: string;
  prepareError?: PrepareError;
};

export type BootstrapParams = {
  session_key: SessionKey;
  agent_id: AgentId;
  workspace_id: WorkspaceId;
  client_instance_id: string;
  source: "login" | "token_refresh" | "reconnect";
};

export type BootstrapResult = {
  ok: boolean;
  bootstrapId?: string;
  sessionId?: string;
  stateUpserted?: boolean;
  resolved?: {
    userId: string;
    agentId: AgentId;
    workspaceId: WorkspaceId;
    sessionKey: SessionKey;
  };
  error?: string;
  status?: number;
};

export type OnboardingReason =
  | "missing_model"
  | "missing_usable_agent"
  | "no_provider_credentials"
  | "setup_required";
