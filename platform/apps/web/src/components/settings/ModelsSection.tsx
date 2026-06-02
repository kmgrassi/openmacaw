import { useState } from "react";
import type {
  ModelCatalogEntry,
  ModelProvider,
  ModelProviderConnection,
} from "../../../../../contracts/model-catalog";
import {
  useModelCatalogQueries,
  useModelProviderCredentialMutation,
} from "../../hooks/useServerStateQueries";
import { devApiKeyForProvider } from "../../lib/dev-credentials";
import { useAuthStore } from "../../stores/auth";
import { CREDENTIAL_PROVIDER_REGISTRY } from "../../../../../contracts/credentials";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";

type ProviderFormState = {
  apiKey: string;
  endpoint: string;
  apiVersion: string;
  saving: boolean;
  error: string | null;
  success: boolean;
};

function emptyProviderForm(): ProviderFormState {
  return {
    apiKey: "",
    endpoint: "",
    apiVersion: "",
    saving: false,
    error: null,
    success: false,
  };
}

function ProviderCard({
  provider,
  form,
  disabled,
  onChange,
  onSave,
}: {
  provider: ModelProviderConnection;
  form: ProviderFormState;
  disabled: boolean;
  onChange: (patch: Partial<ProviderFormState>) => void;
  onSave: () => void;
}) {
  const status =
    provider.valid === true
      ? { label: "Connected", className: "text-green-300" }
      : provider.credentialConfigured
        ? { label: "Needs attention", className: "text-amber-300" }
        : { label: "Not connected", className: "text-slate-500" };
  const credentialMetadata =
    provider.id in CREDENTIAL_PROVIDER_REGISTRY
      ? CREDENTIAL_PROVIDER_REGISTRY[
          provider.id as keyof typeof CREDENTIAL_PROVIDER_REGISTRY
        ]
      : null;
  const devApiKey = devApiKeyForProvider(credentialMetadata);

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-200">
              {provider.name}
            </h3>
            {provider.valid && (
              <Badge variant="success">{provider.modelCount ?? 0} models</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">{provider.description}</p>
        </div>
        <span className={`shrink-0 text-xs ${status.className}`}>
          {status.label}
        </span>
      </div>

      {provider.lastError && (
        <Alert tone="warning" compact>
          {provider.lastError}
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {provider.requiresEndpoint && (
          <Input
            label="Endpoint"
            value={form.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
            placeholder="https://your-resource.openai.azure.com"
          />
        )}
        {provider.requiresEndpoint && (
          <Input
            label="API version"
            value={form.apiVersion}
            onChange={(event) => onChange({ apiVersion: event.target.value })}
            placeholder="2024-02-01"
          />
        )}
        <div className="md:col-span-2">
          <Input
            label="API key"
            type="password"
            value={form.apiKey}
            onChange={(event) => onChange({ apiKey: event.target.value })}
            placeholder="Paste key to validate and store server-side"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-h-4 text-xs">
          {form.error && <span className="text-red-400">{form.error}</span>}
          {form.success && (
            <span className="text-green-400">
              Credential validated and saved.
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {devApiKey && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onChange({ apiKey: devApiKey })}
            >
              Use dev credentials
            </Button>
          )}
          <Button
            size="sm"
            loading={form.saving}
            disabled={disabled || !form.apiKey.trim()}
            onClick={onSave}
          >
            {provider.credentialConfigured ? "Update key" : "Connect provider"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ModelsSection() {
  const { workspaceId } = useAuthStore();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { providers: providersQuery, catalog: catalogQuery } =
    useModelCatalogQueries({
      workspaceId,
      refresh: refreshNonce > 0,
      refreshToken: refreshNonce,
    });
  const saveProviderCredential =
    useModelProviderCredentialMutation(workspaceId);
  const [providerForms, setProviderForms] = useState<
    Record<string, ProviderFormState>
  >({});

  const providers = providersQuery.data?.providers ?? [];
  const models = catalogQuery.data?.models ?? [];
  const loading = providersQuery.isLoading || catalogQuery.isLoading;
  const refreshing = providersQuery.isFetching || catalogQuery.isFetching;
  const error = !workspaceId
    ? "Workspace context is required to manage model providers."
    : providersQuery.error || catalogQuery.error
      ? String(providersQuery.error ?? catalogQuery.error)
      : null;
  const providerErrors = catalogQuery.data?.errors ?? [];

  const updateForm = (
    provider: ModelProvider,
    patch: Partial<ProviderFormState>,
  ) => {
    setProviderForms((current) => ({
      ...current,
      [provider]: {
        ...(current[provider] ?? emptyProviderForm()),
        ...patch,
      },
    }));
  };

  const saveProvider = async (provider: ModelProvider) => {
    const form = providerForms[provider] ?? emptyProviderForm();
    if (!workspaceId || !form.apiKey.trim()) return;

    updateForm(provider, { saving: true, error: null, success: false });
    try {
      await saveProviderCredential.mutateAsync({
        provider,
        credential: {
          workspaceId,
          apiKey: form.apiKey.trim(),
          endpoint: form.endpoint.trim() || undefined,
          apiVersion: form.apiVersion.trim() || undefined,
        },
      });
      updateForm(provider, { apiKey: "", saving: false, success: true });
      setRefreshNonce((value) => value + 1);
    } catch (err) {
      updateForm(provider, {
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const grouped = models.reduce<Record<string, ModelCatalogEntry[]>>(
    (acc, model) => {
      (acc[model.provider] ??= []).push(model);
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models & Providers"
        description="Connect provider API keys once per workspace. Keys are sent to the API, validated server-side, stored in the credentials table, and never returned to the browser."
        contentClassName="max-w-2xl"
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={refreshing}
            disabled={!workspaceId || loading}
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            Refresh
          </Button>
        }
      />

      {loading && (
        <p className="text-sm text-slate-400">Loading provider catalog...</p>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {providerErrors.length > 0 && (
        <Alert tone="warning">
          Some connected providers could not be refreshed. Check the provider
          cards below for details.
        </Alert>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Provider Connections
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Only connected and valid providers contribute models to the picker.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              form={providerForms[provider.id] ?? emptyProviderForm()}
              disabled={!workspaceId}
              onChange={(patch) => updateForm(provider.id, patch)}
              onSave={() => void saveProvider(provider.id)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Available Models
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            This list is derived from your connected provider credentials.
          </p>
        </div>

        {Object.entries(grouped).map(([provider, entries]) => (
          <div key={provider} className="space-y-2">
            <h4 className="text-sm font-medium text-slate-300 capitalize">
              {entries[0]?.providerName ?? provider}
            </h4>
            <div className="grid gap-2">
              {entries.map((model) => (
                <Card key={model.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-200">
                        {model.name || model.id}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-slate-500">
                        {model.id}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {model.contextWindow && (
                        <Badge>
                          {(model.contextWindow / 1000).toFixed(0)}k ctx
                        </Badge>
                      )}
                      {model.reasoning && (
                        <Badge variant="success">reasoning</Badge>
                      )}
                      {model.input?.includes("image") && <Badge>vision</Badge>}
                      {model.input?.includes("document") && (
                        <Badge>documents</Badge>
                      )}
                      {model.recommended && (
                        <Badge variant="success">recommended</Badge>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))}

        {!loading && models.length === 0 && (
          <Card>
            <p className="text-sm text-slate-400">
              No provider models are available yet. Connect at least one
              provider API key above.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
