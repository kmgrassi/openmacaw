import type { WorkerBridgeSessionRow } from "../../../../../contracts/worker-bridge.js";
import type { ResolvedSavedCredential } from "../saved-credentials.js";

type CodexOAuthDiagnosticStatus =
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

function credentialRefValue(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const value = (ref as { value?: unknown; credentialId?: unknown; credential_id?: unknown }).value;
  if (typeof value === "string" && value.trim()) return value.trim();
  const credentialId = (ref as { credentialId?: unknown }).credentialId;
  if (typeof credentialId === "string" && credentialId.trim()) return credentialId.trim();
  const credentialIdSnake = (ref as { credential_id?: unknown }).credential_id;
  if (typeof credentialIdSnake === "string" && credentialIdSnake.trim()) return credentialIdSnake.trim();
  return null;
}

function isFailedBridgeStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "error" || normalized === "unsupported_runner";
}

function isRunningBridgeStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === "running" || normalized === "ready";
}

export function selectCodexBridgeSession(
  sessions: WorkerBridgeSessionRow[],
  input: { agentId: string; workspaceId: string | null },
) {
  const candidates = sessions.filter((session) => {
    if (session.kind !== "codex") return false;
    if (session.agent_id && session.agent_id !== input.agentId) return false;
    if (session.workspace_id && input.workspaceId && session.workspace_id !== input.workspaceId) return false;
    return true;
  });

  const newestFirst = candidates.sort((left, right) => {
    const rightStartedAt = Date.parse(right.started_at);
    const leftStartedAt = Date.parse(left.started_at);
    return (Number.isNaN(rightStartedAt) ? 0 : rightStartedAt) - (Number.isNaN(leftStartedAt) ? 0 : leftStartedAt);
  });

  return (
    newestFirst.find((session) => isRunningBridgeStatus(session.status)) ??
    newestFirst.find((session) => isFailedBridgeStatus(session.status)) ??
    newestFirst[0] ??
    null
  );
}

export function buildCodexOAuthDiagnostic(input: {
  requestedRunnerKind: string | null;
  executionProfile: {
    resolved: boolean;
    missing: string[];
    profile: {
      runnerKind: string | null;
      provider: string | null;
      model: string | null;
      credentialRef: unknown;
      toolProfile: string | null;
    } | null;
  };
  launcherHealthy: boolean;
  bridgeSession: WorkerBridgeSessionRow | null;
  credentials: ResolvedSavedCredential[];
}): CodexOAuthDiagnostic {
  const profile = input.executionProfile.profile;
  const applicable =
    (input.requestedRunnerKind === "codex" || profile?.runnerKind === "codex") &&
    profile?.provider === "openai_codex";
  const credentialRowId = credentialRefValue(profile?.credentialRef);
  const credential =
    input.credentials.find((candidate) => candidate.credentialRowId === credentialRowId) ??
    input.credentials.find((candidate) => candidate.provider === "openai_codex" && candidate.launchableKind === "codex") ??
    null;

  const expiresAt = credential?.oauth?.expiresAt ?? null;
  const expired = typeof expiresAt === "number" ? expiresAt <= Date.now() : null;
  const tokenPresent = Boolean(credential?.secretValue || credential?.secretRef);
  const refreshable = Boolean(credential?.oauth?.refreshToken);
  const credentialReady =
    applicable &&
    profile?.runnerKind === "codex" &&
    Boolean(profile.credentialRef) &&
    credential?.provider === "openai_codex" &&
    credential.launchableKind === "codex" &&
    tokenPresent &&
    !input.executionProfile.missing.includes("credential") &&
    expired !== true;

  const bridgeFailure = input.bridgeSession
    ? isFailedBridgeStatus(input.bridgeSession.status) ||
      (input.bridgeSession.exit_status !== null && input.bridgeSession.exit_status !== 0)
    : false;
  const bridgeAvailable = input.bridgeSession
    ? !bridgeFailure && isRunningBridgeStatus(input.bridgeSession.status)
    : null;

  const blockers: string[] = [];
  if (applicable && !credentialReady) {
    blockers.push(
      expired
        ? "ChatGPT OAuth access token is expired and was not refreshed before diagnostic"
        : "Missing launchable ChatGPT OAuth credential for Codex",
    );
  }
  if (applicable && !input.launcherHealthy) {
    blockers.push("Launcher health check failed before Codex bridge availability could be verified");
  }
  if (applicable && bridgeFailure) {
    blockers.push("Runtime reported Codex bridge startup failure");
  }

  let status: CodexOAuthDiagnosticStatus = "not_applicable";
  if (applicable && expired) {
    status = "token_expired";
  } else if (applicable && !credentialReady) {
    status = "missing_codex_oauth_credential";
  } else if (applicable && !input.launcherHealthy) {
    status = "launcher_unhealthy";
  } else if (applicable && bridgeFailure) {
    status = "runtime_bridge_startup_failed";
  } else if (applicable) {
    status = "ready";
  }

  return {
    applicable,
    status,
    runnerKind: profile?.runnerKind === "codex" ? "codex" : null,
    provider: profile?.provider ?? null,
    model: profile?.model ?? null,
    credential: {
      provider: "openai_codex",
      authMode: "oauth",
      required: applicable,
      ready: credentialReady,
      reference: profile?.credentialRef ?? null,
      credentialRowId: credential?.credentialRowId ?? credentialRowId,
      validationState: credential?.validationState ?? null,
      validatedAt: credential?.validatedAt ?? null,
      token: {
        present: tokenPresent,
        refreshable,
        expiresAt,
        expired,
      },
    },
    runtimeBridge: {
      reported: Boolean(input.bridgeSession),
      available: bridgeAvailable,
      status: input.bridgeSession?.status ?? null,
      sessionId: input.bridgeSession?.id ?? null,
      failure: bridgeFailure ? (input.bridgeSession?.status ?? "failed") : null,
      credentialEnv: "OPENAI_API_KEY",
    },
    blockers,
  };
}
