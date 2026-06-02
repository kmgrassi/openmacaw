import { useEffect, useMemo, useRef, useState } from "react";
import { type CredentialReference } from "../../api/credentials";
import {
  useCredentialMutations,
  useResolvedCredentialQuery,
} from "../../hooks/useServerStateQueries";
import {
  isCredentiallessRunnerKind,
  normalizeRunnerKind,
} from "../../../../../contracts/runner-kinds";
import { Card } from "../ui/Card";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { AddCredentialDialog } from "./credential-picker/AddCredentialDialog";
import { CredentialPickerMessages } from "./credential-picker/CredentialPickerMessages";
import {
  asCredentialProvider,
  credentialProviderLabel,
  credentialRefValue,
  credentialRowId,
  credentialValidationLabel,
  matchesProviderFilter,
} from "./credential-picker/credential-picker-utils";

type CredentialPickerProps = {
  agentId: string;
  workspaceId?: string | null;
  providerFilter?: string | null;
  runnerKind?: string;
  model?: string | null;
  refreshKey?: number;
  onSaved?: () => Promise<void> | void;
};

export function CredentialPicker({
  agentId,
  workspaceId,
  providerFilter,
  runnerKind,
  model,
  refreshKey = 0,
  onSaved,
}: CredentialPickerProps) {
  const credentialQuery = useResolvedCredentialQuery(
    agentId,
    workspaceId,
    refreshKey,
  );
  const credentialMutations = useCredentialMutations(agentId, workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [referenceSuccess, setReferenceSuccess] = useState(false);
  const [selectedRef, setSelectedRef] = useState("");
  const [resolvedRunnerKind, setResolvedRunnerKind] = useState<string | null>(
    runnerKind ?? null,
  );
  const [resolvedProvider, setResolvedProvider] = useState<string | null>(
    providerFilter ?? null,
  );
  const [resolvedModel, setResolvedModel] = useState<string | null>(
    model ?? null,
  );
  const [addingCredential, setAddingCredential] = useState(false);
  const skipNextReferenceSyncRef = useRef(false);

  const credentials = credentialQuery.data?.credentials ?? [];
  const aliases = credentialQuery.data?.aliases ?? [];
  const referenceLoading =
    credentialQuery.isLoading || credentialQuery.isFetching;
  const referenceSaving = credentialMutations.saveReference.isPending;

  useEffect(() => {
    if (!workspaceId) {
      setSelectedRef("");
      return;
    }
    if (credentialQuery.error) {
      setError(
        credentialQuery.error instanceof Error
          ? credentialQuery.error.message
          : String(credentialQuery.error),
      );
      return;
    }
    if (!credentialQuery.data) return;
    setError(null);
    if (skipNextReferenceSyncRef.current) {
      skipNextReferenceSyncRef.current = false;
    } else {
      setSelectedRef(
        credentialRefValue(credentialQuery.data.reference.credentialRef),
      );
    }
    setResolvedRunnerKind(
      credentialQuery.data.reference.runnerKind ?? runnerKind ?? null,
    );
    setResolvedProvider(
      credentialQuery.data.reference.provider ?? providerFilter ?? null,
    );
    setResolvedModel(credentialQuery.data.reference.model ?? model ?? null);
  }, [
    credentialQuery.data,
    credentialQuery.error,
    model,
    providerFilter,
    refreshKey,
    runnerKind,
    workspaceId,
  ]);

  const effectiveRunnerKind = resolvedRunnerKind ?? runnerKind;
  const normalizedRunnerKind = normalizeRunnerKind(effectiveRunnerKind);
  const credentiallessRunner = normalizedRunnerKind
    ? isCredentiallessRunnerKind(normalizedRunnerKind)
    : false;
  const effectiveProviderFilter = credentiallessRunner
    ? null
    : (resolvedProvider ?? providerFilter);

  const filteredCredentials = useMemo(
    () =>
      credentials.filter((credential) =>
        matchesProviderFilter(credential, effectiveProviderFilter),
      ),
    [credentials, effectiveProviderFilter],
  );

  const filteredAliases = useMemo(
    () =>
      aliases.filter((alias) =>
        matchesProviderFilter(alias.credential, effectiveProviderFilter),
      ),
    [aliases, effectiveProviderFilter],
  );

  const selectedCredential = useMemo(() => {
    if (!selectedRef) return null;
    const [type, value] = selectedRef.split(":", 2);
    if (type === "credential_id") {
      return (
        credentials.find(
          (credential) => credentialRowId(credential) === value,
        ) ?? null
      );
    }
    if (type === "alias") {
      return aliases.find((alias) => alias.alias === value)?.credential ?? null;
    }
    return null;
  }, [aliases, credentials, selectedRef]);

  const selectedRefAllowed =
    !selectedRef ||
    matchesProviderFilter(selectedCredential, effectiveProviderFilter);
  const selectedReferenceMissingCredential =
    Boolean(selectedRef) && !selectedCredential;
  const canClearSelectedReference =
    Boolean(selectedRef) &&
    (selectedReferenceMissingCredential || !selectedRefAllowed);
  const canAttachSelectedCredential =
    !selectedRef ||
    (effectiveRunnerKind !== "codex" && !selectedReferenceMissingCredential) ||
    selectedCredential?.launchableKind === "codex";
  const canSaveReference =
    canClearSelectedReference ||
    (canAttachSelectedCredential && selectedRefAllowed);

  const credentialOptions = [
    { value: "", label: "No credential reference" },
    ...filteredAliases.map((alias) => ({
      value: `alias:${alias.alias}`,
      label: `Alias: ${alias.alias}${alias.credential ? ` (${credentialProviderLabel(alias.credential)} - ${alias.credential.label})` : ""}`,
    })),
    ...filteredCredentials.map((credential) => ({
      value: `credential_id:${credentialRowId(credential)}`,
      label: `${credentialProviderLabel(credential)} - ${credential.label} (${credentialValidationLabel(credential)})`,
    })),
  ];

  if (
    selectedRef &&
    selectedCredential &&
    !selectedRefAllowed &&
    credentialOptions.every((option) => option.value !== selectedRef)
  ) {
    credentialOptions.push({
      value: selectedRef,
      label: `${credentialProviderLabel(selectedCredential)} - ${selectedCredential.label} (provider mismatch)`,
    });
  }

  const handleReferenceSave = async () => {
    if (!workspaceId || !canSaveReference) {
      return;
    }
    const [type, value] = selectedRef.split(":", 2);
    const credentialRef: CredentialReference | null =
      !canClearSelectedReference &&
      (type === "alias" || type === "credential_id") &&
      value
        ? { type, value }
        : null;

    setError(null);
    setReferenceSuccess(false);
    try {
      const response = await credentialMutations.saveReference.mutateAsync({
        agentId,
        workspaceId,
        runnerKind: effectiveRunnerKind,
        provider:
          selectedCredential?.provider ??
          resolvedProvider ??
          providerFilter ??
          null,
        model: resolvedModel ?? model,
        credentialRef,
      });
      setSelectedRef(credentialRefValue(response.reference.credentialRef));
      setReferenceSuccess(true);
      await onSaved?.();
      setTimeout(() => setReferenceSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const emptyFilteredCredentials =
    filteredCredentials.length === 0 && filteredAliases.length === 0;
  const addCredentialProvider = asCredentialProvider(effectiveProviderFilter);

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-300">
            Execution Credential Reference
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Attach a stored workspace credential or alias to this agent without
            copying the secret.
          </p>
        </div>
        {effectiveRunnerKind && <Badge>{effectiveRunnerKind}</Badge>}
      </div>
      <div className="space-y-3">
        {!credentiallessRunner && (
          <Select
            label="Credential reference"
            value={selectedRefAllowed ? selectedRef : ""}
            onChange={(event) => setSelectedRef(event.target.value)}
            options={credentialOptions}
            disabled={!workspaceId || referenceLoading}
          />
        )}

        <CredentialPickerMessages
          credentiallessRunner={credentiallessRunner}
          referenceLoading={referenceLoading}
          canClearSelectedReference={canClearSelectedReference}
          selectedRefAllowed={selectedRefAllowed}
          canAttachSelectedCredential={canAttachSelectedCredential}
          selectedReferenceMissingCredential={
            selectedReferenceMissingCredential
          }
          selectedCredential={selectedCredential}
          emptyFilteredCredentials={emptyFilteredCredentials}
          effectiveProviderFilter={effectiveProviderFilter}
          error={error}
          referenceSuccess={referenceSuccess}
          workspaceId={workspaceId}
        />

        <div className="flex justify-end">
          <Button
            className="mr-2"
            size="sm"
            variant="secondary"
            disabled={!workspaceId || credentiallessRunner}
            onClick={() => setAddingCredential(true)}
          >
            Add new
          </Button>
          <Button
            size="sm"
            loading={referenceSaving}
            disabled={
              !workspaceId ||
              referenceLoading ||
              credentiallessRunner ||
              !canSaveReference
            }
            onClick={handleReferenceSave}
          >
            Save reference
          </Button>
        </div>
      </div>

      <AddCredentialDialog
        open={addingCredential}
        agentId={agentId}
        workspaceId={workspaceId}
        initialProvider={addCredentialProvider ?? "openai"}
        providerOptions={
          addCredentialProvider ? [addCredentialProvider] : undefined
        }
        credentialMutations={credentialMutations}
        skipNextReferenceSyncRef={skipNextReferenceSyncRef}
        onSaved={onSaved}
        onClose={() => setAddingCredential(false)}
        onCredentialSaved={(credential) => {
          setSelectedRef(`credential_id:${credentialRowId(credential)}`);
        }}
        onOAuthConnected={async () => {
          await credentialQuery.refetch();
        }}
      />
    </Card>
  );
}
