/**
 * Web-side helpers for the dev-only workspace-directory endpoints
 * registered by apps/api/src/routes/local-directory.ts.
 */
import { brokerFetch } from "./broker-fetch";

export type ValidateDirectoryResult =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      reason: "not_absolute" | "not_found" | "not_a_directory" | "not_readable";
    };

export type PickDirectoryResult =
  | { cancelled: true; path: null }
  | { cancelled: false; path: string; validation: ValidateDirectoryResult };

export async function pickDirectory(opts?: {
  defaultLocation?: string;
  prompt?: string;
}): Promise<PickDirectoryResult> {
  const res = await brokerFetch("/api/local/pick-directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pick-directory failed (${res.status}): ${body}`);
  }
  return (await res.json()) as PickDirectoryResult;
}

export async function validateDirectory(
  path: string,
): Promise<ValidateDirectoryResult> {
  const res = await brokerFetch("/api/local/validate-directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`validate-directory failed (${res.status}): ${body}`);
  }
  return (await res.json()) as ValidateDirectoryResult;
}

export type FetchWorkspacePathResult = {
  path: string | null;
  validation: ValidateDirectoryResult | null;
};

export async function fetchAgentWorkspacePath(
  agentId: string,
): Promise<FetchWorkspacePathResult> {
  const res = await brokerFetch(
    `/api/local/agents/${encodeURIComponent(agentId)}/workspace-path`,
    { method: "GET" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch-workspace-path failed (${res.status}): ${body}`);
  }
  return (await res.json()) as FetchWorkspacePathResult;
}

export type SaveWorkspacePathResult = {
  agentId: string;
  workspacePath: string | null;
  toolPolicy: Record<string, unknown>;
};

export async function saveAgentWorkspacePath(
  agentId: string,
  path: string | null,
): Promise<SaveWorkspacePathResult> {
  const res = await brokerFetch(
    `/api/local/agents/${encodeURIComponent(agentId)}/workspace-path`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`save-workspace-path failed (${res.status}): ${body}`);
  }
  return (await res.json()) as SaveWorkspacePathResult;
}
