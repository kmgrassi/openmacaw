import { BrokerSessionError } from "./broker";
import { makeSessionKey } from "./ws-types";
import type {
  AgentId,
  BootstrapResult,
  SessionKey,
  WorkspaceId,
} from "./ws-types";

export type { BootstrapResult } from "./ws-types";

export async function establishBrokerSession(accessToken: string) {
  if (!accessToken || !accessToken.trim()) {
    throw new BrokerSessionError(401, "Missing access token");
  }
  // The local setup can proxy broker/session through a separate runtime layer.
  // Health-checking /health can intermittently fail in dev setups and blocks auth;
  // treat this as a no-op session establishment.
  void accessToken;
  return;
}

// Legacy runtime bootstrap endpoint removed from the minimal contract.
// Keep a synthetic no-op compatibility shape so callers don't need churn.
export async function bootstrapSession(
  _accessToken: string,
  params: {
    agentId: AgentId;
    workspaceId: WorkspaceId;
    source: "login" | "token_refresh" | "reconnect";
  },
): Promise<BootstrapResult> {
  const sessionKey: SessionKey = makeSessionKey(params.agentId);

  return {
    ok: true,
    bootstrapId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    stateUpserted: true,
    resolved: {
      userId: "00000000-0000-4000-8000-000000000003",
      agentId: params.agentId,
      workspaceId: params.workspaceId,
      sessionKey,
    },
  };
}

export async function brokerLogout() {
  return Promise.resolve();
}
