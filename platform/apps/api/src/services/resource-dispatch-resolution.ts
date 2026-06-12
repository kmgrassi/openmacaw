import { z } from "zod";

import {
  NetworkPolicySchema,
  RuntimeExecutionResourceSchema,
  RuntimeRepositoryRefSchema,
  type ExecutionResourceAccessMode,
  type ExecutionResourceRequirement,
  type NetworkPolicy,
  type RuntimeExecutionResource,
  type RuntimeRepositoryRef,
} from "../../../../contracts/execution-profile.js";
import { ApiRouteError } from "../http.js";
import { narrowSupabase } from "../lib/narrow-supabase.js";
import { executeLoggedSupabaseRows, getUserScopedSupabase } from "../supabase-client.js";

const RequestedExecutionResourceSchema = z.object({
  resourceId: z.string().uuid().optional(),
  grantId: z.string().uuid().optional(),
  alias: z.string().trim().min(1).optional(),
  requirement: z.enum(["required", "optional"]).optional(),
  accessMode: z.enum(["read", "write"]).optional(),
  repositoryRef: RuntimeRepositoryRefSchema.optional(),
});

const ResourceCredentialRowSchema = z.object({
  credential_id: z.string().uuid(),
  credential_purpose: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
});

const WorkspaceResourceRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  resource_type: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  provider_url: z.string().trim().min(1),
  display_name: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
  metadata_json: z.unknown().optional(),
  workspace_resource_credential: z.array(ResourceCredentialRowSchema).optional(),
});

const AgentResourceGrantRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  access_mode: z.enum(["read", "write"]),
  allowed_refs_json: z.unknown().nullable().optional(),
  network_policy_json: z.unknown().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  workspace_resource: WorkspaceResourceRowSchema,
});

const AgentResourceGrantRowsSchema = z.array(AgentResourceGrantRowSchema);

type RequestedExecutionResource = z.infer<typeof RequestedExecutionResourceSchema>;
type AgentResourceGrantRow = z.infer<typeof AgentResourceGrantRowSchema>;

const RESOURCE_GRANT_SELECT = `
  id,
  workspace_id,
  agent_id,
  resource_id,
  access_mode,
  allowed_refs_json,
  network_policy_json,
  expires_at,
  revoked_at,
  workspace_resource (
    id,
    workspace_id,
    resource_type,
    provider,
    provider_url,
    display_name,
    deleted_at,
    metadata_json,
    workspace_resource_credential (
      credential_id,
      credential_purpose,
      revoked_at
    )
  )
`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requestedResourcesFromMetadata(
  dispatchMetadata: Record<string, unknown>,
): RequestedExecutionResource[] | null {
  if (!Object.hasOwn(dispatchMetadata, "resources")) return null;
  const parsed = z.array(RequestedExecutionResourceSchema).min(1).safeParse(dispatchMetadata.resources);
  if (parsed.success) return parsed.data;
  throw new ApiRouteError(
    422,
    "container_dispatch_resources_invalid",
    "Container dispatch resources are invalid",
    parsed.error.flatten(),
  );
}

function activeCredentialRef(row: AgentResourceGrantRow): RuntimeExecutionResource["credentialRef"] {
  const credential = row.workspace_resource.workspace_resource_credential?.find((candidate) => !candidate.revoked_at);
  return credential ? { type: "credential_id", value: credential.credential_id } : null;
}

function defaultAlias(row: AgentResourceGrantRow): string {
  const displayName = row.workspace_resource.display_name?.trim();
  if (displayName) return displayName;

  try {
    const parsed = new URL(row.workspace_resource.provider_url);
    const pathName = parsed.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .at(-1);
    return pathName || parsed.hostname;
  } catch {
    return row.workspace_resource.resource_type;
  }
}

function parseNetworkPolicy(value: unknown, fallback: NetworkPolicy): NetworkPolicy {
  if (value == null) return fallback;
  const parsed = NetworkPolicySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiRouteError(
    422,
    "resource_network_policy_invalid",
    "Resource grant network policy is invalid",
    parsed.error.flatten(),
  );
}

function allowedRefs(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string"));
  const record = asRecord(value);
  const refs = record.refs;
  return Array.isArray(refs) ? new Set(refs.filter((item): item is string => typeof item === "string")) : new Set();
}

function assertRefAllowed(row: AgentResourceGrantRow, requestedRef: RuntimeRepositoryRef | undefined): void {
  const allowed = allowedRefs(row.allowed_refs_json);
  if (allowed.size === 0) return;
  if (!requestedRef) {
    throw new ApiRouteError(403, "resource_ref_not_granted", "Requested repository ref is not granted", {
      resourceId: row.resource_id,
      grantId: row.id,
    });
  }

  const candidates = [requestedRef.commitSha, requestedRef.ref, requestedRef.branch].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  if (candidates.some((candidate) => allowed.has(candidate))) return;

  throw new ApiRouteError(403, "resource_ref_not_granted", "Requested repository ref is not granted", {
    resourceId: row.resource_id,
    grantId: row.id,
  });
}

function assertAccessModeAllowed(row: AgentResourceGrantRow, requestedAccessMode: ExecutionResourceAccessMode): void {
  if (row.access_mode === "write" || requestedAccessMode === "read") return;
  throw new ApiRouteError(403, "resource_access_mode_not_granted", "Requested resource access mode is not granted", {
    resourceId: row.resource_id,
    grantId: row.id,
    grantedAccessMode: row.access_mode,
    requestedAccessMode,
  });
}

function selectRequestedRows(
  rows: AgentResourceGrantRow[],
  requestedResources: RequestedExecutionResource[] | null,
): Array<{ row: AgentResourceGrantRow; requested: RequestedExecutionResource | null }> {
  if (!requestedResources) {
    return rows
      .filter(
        (row) =>
          !row.revoked_at &&
          !row.workspace_resource.deleted_at &&
          (!row.expires_at || Date.parse(row.expires_at) > Date.now()),
      )
      .map((row) => ({ row, requested: null }));
  }

  const byGrantId = new Map(rows.map((row) => [row.id, row]));
  const byResourceId = new Map(rows.map((row) => [row.resource_id, row]));

  return requestedResources.map((requested) => {
    const row = requested.grantId
      ? byGrantId.get(requested.grantId)
      : requested.resourceId
        ? byResourceId.get(requested.resourceId)
        : null;
    if (!row) {
      throw new ApiRouteError(
        403,
        "resource_not_granted",
        "Requested execution resource is not granted to this agent",
        {
          resourceId: requested.resourceId ?? null,
          grantId: requested.grantId ?? null,
        },
      );
    }
    return { row, requested };
  });
}

function assertActive(row: AgentResourceGrantRow): void {
  if (row.revoked_at || row.workspace_resource.deleted_at) {
    throw new ApiRouteError(403, "resource_not_granted", "Requested execution resource is not granted to this agent", {
      resourceId: row.resource_id,
      grantId: row.id,
    });
  }
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    throw new ApiRouteError(403, "resource_grant_expired", "Requested execution resource grant has expired", {
      resourceId: row.resource_id,
      grantId: row.id,
    });
  }
}

function toRuntimeResource(input: {
  row: AgentResourceGrantRow;
  requested: RequestedExecutionResource | null;
  fallbackNetworkPolicy: NetworkPolicy;
}): RuntimeExecutionResource {
  assertActive(input.row);
  const accessMode = input.requested?.accessMode ?? "read";
  const requirement: ExecutionResourceRequirement = input.requested?.requirement ?? "required";
  assertAccessModeAllowed(input.row, accessMode);
  assertRefAllowed(input.row, input.requested?.repositoryRef);

  return RuntimeExecutionResourceSchema.parse({
    grantId: input.row.id,
    resourceId: input.row.resource_id,
    resourceType: input.row.workspace_resource.resource_type,
    provider: input.row.workspace_resource.provider,
    providerUrl: input.row.workspace_resource.provider_url,
    displayName: input.row.workspace_resource.display_name ?? null,
    alias: input.requested?.alias ?? defaultAlias(input.row),
    credentialRef: activeCredentialRef(input.row),
    accessMode,
    requirement,
    repositoryRef: input.requested?.repositoryRef,
    networkPolicy: parseNetworkPolicy(input.row.network_policy_json, input.fallbackNetworkPolicy),
  });
}

export async function resolveContainerDispatchResources(input: {
  accessToken: string;
  workspaceId: string;
  agentId: string;
  dispatchMetadata: Record<string, unknown>;
  fallbackNetworkPolicy: NetworkPolicy;
}): Promise<RuntimeExecutionResource[]> {
  const requestedResources = requestedResourcesFromMetadata(input.dispatchMetadata);
  const supabase = narrowSupabase(getUserScopedSupabase(input.accessToken));
  const rows = await executeLoggedSupabaseRows<unknown>(
    {
      operation: "list agent resource grants for container dispatch",
      table: "agent_resource_grant",
    },
    supabase
      .from("agent_resource_grant")
      .select(RESOURCE_GRANT_SELECT)
      .eq("workspace_id", input.workspaceId)
      .eq("agent_id", input.agentId)
      .is("revoked_at", null),
  );
  const parsedRows = AgentResourceGrantRowsSchema.parse(rows);
  const selectedRows = selectRequestedRows(parsedRows, requestedResources);
  const resources = selectedRows.map(({ row, requested }) =>
    toRuntimeResource({ row, requested, fallbackNetworkPolicy: input.fallbackNetworkPolicy }),
  );

  if (resources.length > 0) return resources;

  throw new ApiRouteError(
    403,
    "container_dispatch_resources_missing",
    "Container execution target requires at least one granted execution resource",
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    },
  );
}
