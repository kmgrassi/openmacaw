import type {
  CredentialProvider,
  SavedCredential,
} from "../../../api/credentials";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { CredentialEditor } from "../CredentialEditor";
import {
  CADENCE_OPTIONS,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODELS,
  providerLabel,
  providerOptions,
  type SchedulerRuntimeProvider,
} from "./utils";

type CredentialOption = {
  value: string;
  label: string;
};

type ManagerAgentDefaultsProps = {
  agentId: string | null;
  workspaceId: string | null | undefined;
  provider: SchedulerRuntimeProvider;
  setProvider: (provider: SchedulerRuntimeProvider) => void;
  model: string;
  setModel: (model: string) => void;
  baseUrl: string;
  setBaseUrl: (baseUrl: string) => void;
  cadenceMs: string;
  setCadenceMs: (cadenceMs: string) => void;
  credentialMode: "reuse" | "new";
  setCredentialMode: (mode: "reuse" | "new") => void;
  selectedRef: string;
  setSelectedRef: (selectedRef: string) => void;
  localProvider: boolean;
  credentialOptions: CredentialOption[];
  filteredCredentials: SavedCredential[];
  loadingCredentials: boolean;
  activationError: string | null;
  activationSuccess: boolean;
  activating: boolean;
  canActivate: boolean;
  onActivate: () => void;
  onActivateWithCredential: (input: {
    apiKey: string;
    label?: string;
  }) => Promise<void> | void;
};

export function ManagerAgentDefaults({
  agentId,
  workspaceId,
  provider,
  setProvider,
  model,
  setModel,
  baseUrl,
  setBaseUrl,
  cadenceMs,
  setCadenceMs,
  credentialMode,
  setCredentialMode,
  selectedRef,
  setSelectedRef,
  localProvider,
  credentialOptions,
  filteredCredentials,
  loadingCredentials,
  activationError,
  activationSuccess,
  activating,
  canActivate,
  onActivate,
  onActivateWithCredential,
}: ManagerAgentDefaultsProps) {
  const credentialProvider: CredentialProvider =
    provider === "anthropic" || provider === "openai_codex"
      ? provider
      : "openai";

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Runtime Profile
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Save the provider, model, backup cadence, and credential used for
            scheduled turns.
          </p>
        </div>
        <Badge>llm_tool_runner</Badge>
      </div>

      {!agentId && (
        <div className="mb-4 rounded-md border border-amber-600/30 bg-amber-900/20 px-3 py-2 text-sm text-amber-300">
          The manager agent has not been created for this workspace yet.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Select
          label="Provider"
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value as SchedulerRuntimeProvider;
            setProvider(nextProvider);
            setModel(DEFAULT_MODELS[nextProvider]);
          }}
          options={providerOptions}
        />
        <Input
          label="Model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={DEFAULT_MODELS[provider]}
        />
        {localProvider && (
          <Input
            label="Base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_LOCAL_BASE_URL}
          />
        )}
        <Select
          label="Backup default cadence"
          value={cadenceMs}
          onChange={(event) => setCadenceMs(event.target.value)}
          options={CADENCE_OPTIONS}
        />
      </div>

      {!localProvider ? (
        <div className="mt-4 space-y-3">
          <div className="text-xs font-medium text-slate-400">Credential</div>
          <SegmentedControl
            ariaLabel="Credential mode"
            value={credentialMode}
            onValueChange={setCredentialMode}
            options={[
              { value: "reuse", label: "Reuse existing" },
              { value: "new", label: "Paste new key" },
            ]}
            columns={2}
            fullWidth
          />

          {credentialMode === "reuse" ? (
            <div className="space-y-2">
              <Select
                label="Workspace credential"
                value={selectedRef}
                onChange={(event) => setSelectedRef(event.target.value)}
                options={credentialOptions}
                disabled={
                  !agentId ||
                  loadingCredentials ||
                  filteredCredentials.length === 0
                }
              />
              {filteredCredentials.length === 0 && !loadingCredentials && (
                <p className="text-xs text-slate-500">
                  No saved {providerLabel(provider)} credential is available in
                  this workspace.
                </p>
              )}
            </div>
          ) : (
            <CredentialEditor
              agentId={agentId}
              workspaceId={workspaceId}
              initialProvider={credentialProvider}
              providerOptions={[credentialProvider]}
              showLabelField
              defaultLabel={`${providerLabel(provider)} manager key`}
              submitLabel="Save profile"
              successMessage="Manager settings saved."
              disabledReason={
                !agentId
                  ? "Manager agent is required."
                  : !model.trim()
                    ? "Model is required."
                    : null
              }
              onApiKeyCredential={async (credential) => {
                await onActivateWithCredential({
                  apiKey: credential.secret,
                  label: credential.label,
                });
              }}
            />
          )}
        </div>
      ) : null}

      {activationError && (
        <p className="mt-3 text-xs text-red-400">{activationError}</p>
      )}
      {activationSuccess && (
        <p className="mt-3 text-xs text-green-400">Manager settings saved.</p>
      )}

      {(localProvider || credentialMode === "reuse") && (
        <div className="mt-4 flex justify-end">
          <Button
            loading={activating}
            disabled={!canActivate}
            onClick={() => void onActivate()}
          >
            Save profile
          </Button>
        </div>
      )}
    </Card>
  );
}
