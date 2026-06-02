import type { Request, Response } from "express";

import { deriveProviderFromModel } from "../../../../../contracts/agent-helpers.js";
import { defaultRunnerKindForAgentType } from "../../../../../contracts/agent-runner-defaults.js";
import {
  SavedCredentialListResponseSchema,
  type SaveCredentialRequest,
  type UpsertAgentCredentialReferenceRequest,
} from "../../../../../contracts/credentials.js";
import { ModelProviderSchema } from "../../../../../contracts/model-catalog.js";
import type { DefaultAgentRole } from "../../../../../contracts/setup.js";
import { ApiRouteError, errorPayload, handleApiRouteError, requireRouteParam } from "../../http.js";
import {
  getAgentCredentialReferenceRule,
  getRoutingRuleLocalEndpointUrl,
  upsertAgentCredentialReferenceRule,
} from "../../repositories/routing-rules.js";
import { validateCredentialRecord } from "../../services/credential-validation.js";
import { ensureDefaultAgentToolsForAgent } from "../../services/default-agent-tools.js";
import { ensureGatewayConfigExists } from "../../services/ensure-gateway-config.js";
import { resolveExecutionProfile } from "../../services/execution-profile-resolver.js";
import {
  listSavedCredentialsForAgentFromSupabase,
  saveInlineCredentialForAgentInSupabase,
} from "../../services/saved-credentials.js";
import { buildRequirementStatusFromResolution } from "../../services/setup/builders.js";
import { listWorkspaceCredentialReferenceState } from "../../services/stored-agent-credential-state.js";
import { listStoredAgentsFromSupabase } from "../../services/stored-agent-management.js";
import {
  ensureStoredAgentDefaultRouting,
  resolveLocalModelRoutingRule,
  syncCredentialIntoRoutingRuleForAgent,
} from "../../services/stored-agent-routing.js";
import { toolProfileForAgentType } from "../../services/tool-bundles.js";
import { assertCredentialReferenceBelongsToWorkspace, requireStoredAgent } from "./authz.js";
import {
  parseCredentialReferenceRequest,
  parseSaveCredentialRequest,
  requireWorkspaceIdFromRequest,
} from "./request-parsers.js";
import { buildCredentialReferenceResponse, buildSaveCredentialResponse } from "./responses.js";

export async function ensureDefaultRoutingHandler(input: {
  req: Request;
  res: Response;
  accessToken: string | null | undefined;
  userId: string | null | undefined;
}) {
  const { req, res, accessToken, userId } = input;
  const agentId = requireRouteParam(req, "agentId");
  const result = await ensureStoredAgentDefaultRouting({
    agentId,
    accessToken: accessToken ?? "",
    userId: userId ?? "",
  });
  const { configured, missing } = buildRequirementStatusFromResolution(result.resolution);
  return res.status(200).json({
    agentId: result.agent.id,
    workspaceId: result.agent.workspaceId,
    changed: result.changed,
    configurationStatus: { configured, missing },
    executionProfile: result.resolution,
  });
}

export async function listStoredAgentCredentials(req: Request, res: Response) {
  try {
    const workspaceId = requireWorkspaceIdFromRequest(req);
    const agentId = requireRouteParam(req, "id");
    const credentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
    return res.status(200).json(
      SavedCredentialListResponseSchema.parse({
        credentials: credentials.map(
          ({ secretValue: _secretValue, secretRef: _secretRef, aliases: _aliases, ...credential }) => credential,
        ),
      }),
    );
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "supabase_unreachable",
      message: error instanceof ApiRouteError ? error.message : "Could not read stored credentials from Supabase",
    });
  }
}

export async function getStoredAgentCredentialReference(req: Request, res: Response) {
  try {
    const workspaceId = requireWorkspaceIdFromRequest(req);
    const agentId = requireRouteParam(req, "id");
    const agent = await requireStoredAgent({ agentId, workspaceId });
    const state = await listWorkspaceCredentialReferenceState(workspaceId, req.userId);
    const rule = await getAgentCredentialReferenceRule({
      agentId: agent.id,
      workspaceId,
    });
    const resolvedProfile = rule
      ? null
      : (
          await resolveExecutionProfile({
            agentId: agent.id,
            requesterUserId: req.userId,
            skipCredentialCheck: true,
          })
        ).profile;
    const localEndpointUrl = rule
      ? await getRoutingRuleLocalEndpointUrl({
          ruleId: rule.id,
          workspaceId,
        })
      : null;

    return res.status(200).json(
      buildCredentialReferenceResponse({
        agent,
        workspaceId,
        state,
        rule,
        localEndpointUrl,
        runnerKind: resolvedProfile?.runnerKind ?? defaultRunnerKindForAgentType(agent.agentType),
        provider: resolvedProfile?.provider ?? agent.provider ?? deriveProviderFromModel(agent.model),
        model: resolvedProfile?.model ?? agent.model,
      }),
    );
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_reference_read_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not read credential reference",
    });
  }
}

async function upsertCredentialReference(req: Request, request: UpsertAgentCredentialReferenceRequest) {
  const agentId = requireRouteParam(req, "id");
  const agent = await requireStoredAgent({
    agentId,
    workspaceId: request.workspaceId,
  });
  await assertCredentialReferenceBelongsToWorkspace({
    workspaceId: request.workspaceId,
    credentialRef: request.credentialRef,
  });

  const requestedRunnerKind = request.runnerKind ?? defaultRunnerKindForAgentType(agent.agentType);
  const localModelRule =
    requestedRunnerKind === "local_model_coding"
      ? await resolveLocalModelRoutingRule({
          workspaceId: request.workspaceId,
          localModelId: request.localModelId,
          localEndpointUrl: request.localEndpointUrl,
        })
      : null;
  const rule = await upsertAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: request.workspaceId,
    runnerKind: requestedRunnerKind,
    provider: localModelRule?.provider ?? request.provider ?? agent.provider ?? deriveProviderFromModel(agent.model),
    model: localModelRule?.model ?? request.model ?? agent.model,
    credentialRef: request.credentialRef,
    localEndpointUrl: localModelRule?.endpointUrl ?? request.localEndpointUrl ?? null,
  });
  if (rule.runner_kind === "local_model_coding") {
    await ensureDefaultAgentToolsForAgent({
      agentId: agent.id,
      workspaceId: request.workspaceId,
      agentType: agent.agentType,
      toolProfile: toolProfileForAgentType(agent.agentType),
      runnerKind: rule.runner_kind,
      userId: req.userId ?? "",
    });
  }
  const state = await listWorkspaceCredentialReferenceState(request.workspaceId, req.userId);
  const localEndpointUrl =
    localModelRule?.endpointUrl ??
    (await getRoutingRuleLocalEndpointUrl({
      ruleId: rule.id,
      workspaceId: request.workspaceId,
    }));

  return buildCredentialReferenceResponse({
    agent,
    workspaceId: request.workspaceId,
    state,
    rule,
    localEndpointUrl,
    runnerKind: rule.runner_kind,
    provider: agent.provider,
    model: rule.model ?? agent.model,
  });
}

export async function saveStoredAgentCredentialReference(req: Request, res: Response) {
  try {
    const request = parseCredentialReferenceRequest(req);
    const response = await upsertCredentialReference(req, request);
    return res.status(200).json(response);
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_reference_save_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not save credential reference",
    });
  }
}

async function syncSavedCredentialIntoRouting(
  input: SaveCredentialRequest & {
    agentId: string;
    credentialRowId?: string | null;
    userId?: string | null;
  },
) {
  const agents = await listStoredAgentsFromSupabase();
  const agent = agents.find(
    (candidate) => candidate.id === input.agentId && candidate.workspaceId === input.workspaceId,
  );
  if (!agent || !agent.workspaceId || !input.credentialRowId) {
    return;
  }

  await syncCredentialIntoRoutingRuleForAgent({
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      agentType: agent.agentType,
      model: agent.model,
      provider: agent.provider,
    },
    credentialId: input.credentialRowId,
    provider: input.provider,
    userId: input.userId,
  });
}

async function ensureGatewayConfigForSavedCredential(input: { agentId: string; provider: string }) {
  try {
    const profile = await resolveExecutionProfile({
      agentId: input.agentId,
      skipCredentialCheck: true,
    });
    if (
      profile.missing.includes("gateway_config") &&
      profile.agent &&
      (profile.agent.role === "planning" || profile.agent.role === "coding")
    ) {
      await ensureGatewayConfigExists({
        agentId: input.agentId,
        role: profile.agent.role as DefaultAgentRole,
        provider: input.provider,
      });
    }
  } catch (gatewayError) {
    console.error("[credential-save] Failed to auto-create gateway config:", gatewayError);
  }
}

export async function saveStoredAgentCredential(req: Request, res: Response) {
  try {
    const request = parseSaveCredentialRequest(req);
    const agentId = requireRouteParam(req, "id");
    if (!ModelProviderSchema.safeParse(request.provider).success) {
      return res
        .status(400)
        .json(errorPayload("unsupported_credential_provider", "Agent credentials must use a model provider"));
    }

    const validation = await validateCredentialRecord({
      raw: {
        provider: request.provider,
      },
      provider: request.provider,
      apiKey: request.apiKey,
    });
    if (!validation.ok) {
      return res.status(400).json(
        errorPayload("credential_validation_failed", validation.message, {
          validation,
        }),
      );
    }

    const saved = await saveInlineCredentialForAgentInSupabase({
      agentId,
      workspaceId: request.workspaceId,
      provider: request.provider,
      apiKey: request.apiKey,
      validationState: "ok",
      validatedAt: validation.checkedAt,
    });

    await syncSavedCredentialIntoRouting({
      ...request,
      agentId,
      credentialRowId: saved.credentialRowId,
      userId: req.userId ?? null,
    });
    await ensureGatewayConfigForSavedCredential({
      agentId,
      provider: saved.provider ?? request.provider,
    });

    return res.status(200).json(buildSaveCredentialResponse(saved));
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_save_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not persist stored credential",
    });
  }
}
