import { useCallback, useEffect, useState } from "react";
import {
  useSaveAgentCredentialMutation,
  type Agent,
} from "../../hooks/useAgents";
import { useAuthStore } from "../../stores/auth";
import {
  getAgentCredentialReference,
  saveCredentialAlias,
  saveStoredCredential,
  type CredentialAlias,
  type CredentialProvider,
  type SavedCredential,
} from "../../api/credentials";
import { CREDENTIAL_PROVIDERS } from "../../../../../contracts/credentials";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";
import { SurfaceLabel, SurfaceList, SurfaceListItem } from "../ui/SurfaceList";
import { FieldMessage } from "../ui/FieldMessage";
import {
  credentialProviderLabel,
  credentialRowId,
  credentialValidationLabel,
} from "./credential-picker/credential-picker-utils";
import { CredentialEditor } from "./CredentialEditor";

type AgentCredentialsProps = {
  agent: Agent;
  onSaved?: () => Promise<void> | void;
};

export function AgentCredentials({ agent, onSaved }: AgentCredentialsProps) {
  const saveCredential = useSaveAgentCredentialMutation();
  const { workspaceId } = useAuthStore();
  const [credentialScope, setCredentialScope] = useState<"workspace" | "agent">(
    "workspace",
  );
  const [referenceSaving, setReferenceSaving] = useState(false);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceSuccess, setReferenceSuccess] = useState(false);
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [aliases, setAliases] = useState<CredentialAlias[]>([]);
  const [aliasName, setAliasName] = useState("");
  const [aliasCredentialId, setAliasCredentialId] = useState("");

  const initialProvider = CREDENTIAL_PROVIDERS.some(
    (candidate) => candidate.provider === agent.provider,
  )
    ? (agent.provider as CredentialProvider)
    : "openai";

  const loadCredentialReferences = useCallback(async () => {
    if (!workspaceId) {
      setCredentials([]);
      setAliases([]);
      return;
    }

    setReferenceLoading(true);
    setError(null);
    try {
      const response = await getAgentCredentialReference(agent.id, workspaceId);
      setCredentials(response.credentials);
      setAliases(response.aliases);
      setAliasCredentialId(
        response.credentials[0] ? credentialRowId(response.credentials[0]) : "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReferenceLoading(false);
    }
  }, [agent.id, workspaceId]);

  useEffect(() => {
    void loadCredentialReferences();
  }, [loadCredentialReferences]);

  const aliasCredentialOptions = credentials.map((credential) => ({
    value: credentialRowId(credential),
    label: `${credential.label} (${credentialProviderLabel(credential)} - ${credentialValidationLabel(credential)})`,
  }));

  const handleAliasSave = async () => {
    if (!workspaceId || !aliasName.trim() || !aliasCredentialId) return;
    setReferenceSaving(true);
    setError(null);
    setReferenceSuccess(false);
    try {
      await saveCredentialAlias({
        workspaceId,
        alias: aliasName.trim(),
        credentialId: aliasCredentialId,
      });
      await loadCredentialReferences();
      setAliasName("");
      setReferenceSuccess(true);
      await onSaved?.();
      setTimeout(() => setReferenceSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReferenceSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <h4 className="mb-3 text-sm font-medium text-slate-300">
          Credential Aliases
        </h4>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_1.4fr]">
            <Input
              label="Alias"
              value={aliasName}
              onChange={(event) => setAliasName(event.target.value)}
              placeholder="default-claude"
            />
            <Select
              label="Credential"
              value={aliasCredentialId}
              onChange={(event) => setAliasCredentialId(event.target.value)}
              options={aliasCredentialOptions}
              disabled={referenceLoading || aliasCredentialOptions.length === 0}
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              loading={referenceSaving}
              disabled={!workspaceId || !aliasName.trim() || !aliasCredentialId}
              onClick={handleAliasSave}
            >
              Save alias
            </Button>
          </div>

          {aliases.length > 0 && (
            <SurfaceList>
              {aliases.map((alias) => (
                <SurfaceListItem key={alias.alias} density="compact">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-slate-300">
                      {alias.alias}
                    </span>
                    <span className="truncate text-xs text-slate-500">
                      {alias.credential?.label ?? alias.credentialId}
                    </span>
                  </div>
                </SurfaceListItem>
              ))}
            </SurfaceList>
          )}
        </div>
      </Card>

      <Card>
        <h4 className="text-sm font-medium text-slate-300 mb-3">
          Provider Credentials
        </h4>
        <CredentialEditor
          agentId={agent.id}
          workspaceId={workspaceId}
          initialProvider={initialProvider}
          enabledFormats={["api_key", "oauth"]}
          disabledReason={
            workspaceId
              ? null
              : "Workspace context is required to save credentials."
          }
          apiKeyExtraFields={
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Scope
              </legend>
              <SurfaceLabel
                density="compact"
                className="flex items-start gap-3"
              >
                <input
                  className="mt-1"
                  type="radio"
                  name={`credential-scope-${agent.id}`}
                  value="workspace"
                  checked={credentialScope === "workspace"}
                  onChange={() => setCredentialScope("workspace")}
                />
                <span>
                  <span className="block text-sm text-slate-200">
                    For this workspace
                  </span>
                  <span className="block text-xs text-slate-500">
                    Available to routing rules and aliases across the workspace.
                  </span>
                </span>
              </SurfaceLabel>
              <SurfaceLabel
                density="compact"
                className="flex items-start gap-3"
              >
                <input
                  className="mt-1"
                  type="radio"
                  name={`credential-scope-${agent.id}`}
                  value="agent"
                  checked={credentialScope === "agent"}
                  onChange={() => setCredentialScope("agent")}
                />
                <span>
                  <span className="block text-sm text-slate-200">
                    For this agent only
                  </span>
                  <span className="block text-xs text-slate-500">
                    Saved directly on this agent and synced into its routing
                    rule.
                  </span>
                </span>
              </SurfaceLabel>
            </fieldset>
          }
          onApiKeyCredential={async (credential) => {
            if (!workspaceId) return;
            if (credentialScope === "agent") {
              await saveCredential.mutateAsync({
                agentId: agent.id,
                workspaceId,
                provider: credential.provider,
                apiKey: credential.secret,
              });
              return;
            }

            await saveStoredCredential({
              scope: { kind: "workspace", workspaceId },
              provider: credential.provider,
              apiKey: credential.secret,
            });
          }}
          onOAuthConnected={async () => {
            await loadCredentialReferences();
          }}
          onSaved={async () => {
            await loadCredentialReferences();
            await onSaved?.();
          }}
        />
        <div className="mt-3 space-y-3">
          {error && <FieldMessage tone="error">{error}</FieldMessage>}
          {referenceSuccess && (
            <FieldMessage tone="success">Credential alias saved.</FieldMessage>
          )}
        </div>
      </Card>
    </div>
  );
}
