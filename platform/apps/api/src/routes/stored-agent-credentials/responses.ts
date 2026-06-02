import { deriveProviderFromModel } from "../../../../../contracts/agent-helpers.js";
import { defaultRunnerKindForAgentType } from "../../../../../contracts/agent-runner-defaults.js";
import {
  AgentCredentialReferenceResponseSchema,
  SaveCredentialResponseSchema,
  type SavedCredential,
} from "../../../../../contracts/credentials.js";
import { credentialRefFromRoutingRule, type AgentCredentialReferenceRule } from "../../repositories/routing-rules.js";
import { credentialProviderForRow } from "../../services/stored-agent-credential-state.js";
import type { ResolvedSavedCredential } from "../../services/saved-credentials.js";
import type { StoredAgentRouteRecord } from "./authz.js";

type CredentialReferenceState = {
  credentials: SavedCredential[];
  aliases: Array<{
    workspaceId: string | null;
    alias: string;
    credentialId: string;
    createdAt: string;
    updatedAt: string;
    credential: SavedCredential | null;
  }>;
  credentialByRowId: Map<string, SavedCredential>;
};
type CredentialReferenceRule = AgentCredentialReferenceRule | null;

function selectedCredentialForReference(
  state: CredentialReferenceState,
  credentialRef: ReturnType<typeof credentialRefFromRoutingRule>,
) {
  if (credentialRef?.type === "credential_id") {
    return state.credentialByRowId.get(credentialRef.value) ?? null;
  }
  if (credentialRef?.type === "alias") {
    return state.aliases.find((alias) => alias.alias === credentialRef.value)?.credential ?? null;
  }
  return null;
}

export function buildCredentialReferenceResponse(input: {
  agent: StoredAgentRouteRecord;
  workspaceId: string;
  state: CredentialReferenceState;
  rule: CredentialReferenceRule;
  localEndpointUrl: string | null;
  runnerKind: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
}) {
  const credentialRef = credentialRefFromRoutingRule(input.rule);
  const selectedCredential = selectedCredentialForReference(input.state, credentialRef);

  return AgentCredentialReferenceResponseSchema.parse({
    reference: {
      agentId: input.agent.id,
      workspaceId: input.workspaceId,
      runnerKind: input.rule?.runner_kind ?? input.runnerKind ?? defaultRunnerKindForAgentType(input.agent.agentType),
      provider:
        input.rule?.provider ??
        credentialProviderForRow(selectedCredential) ??
        input.provider ??
        input.agent.provider ??
        deriveProviderFromModel(input.agent.model),
      model: input.rule?.model ?? input.model ?? input.agent.model,
      credentialRef,
      localEndpointUrl: input.localEndpointUrl,
      credential: selectedCredential,
      updatedAt: input.rule?.updated_at ?? null,
    },
    credentials: input.state.credentials,
    aliases: input.state.aliases,
  });
}

export function buildSaveCredentialResponse(saved: ResolvedSavedCredential) {
  return SaveCredentialResponseSchema.parse({
    credential: {
      id: saved.id,
      credentialRowId: saved.credentialRowId,
      agentId: saved.agentId,
      workspaceId: saved.workspaceId,
      provider: saved.provider,
      label: saved.label,
      envVar: saved.envVar,
      updatedAt: saved.updatedAt,
      validationState: saved.validationState,
      validatedAt: saved.validatedAt,
      launchableKind: saved.launchableKind,
    },
  });
}
