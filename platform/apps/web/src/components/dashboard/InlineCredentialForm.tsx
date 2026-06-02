import { useMemo, useState } from "react";

import { type CredentialProvider } from "../../../../../contracts/credentials";
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG_FALLBACK,
} from "../../../../../contracts/model-catalog";
import type { SetupResponse } from "../../../../../contracts/setup";
import {
  activateManagerAgentCredentials,
  configureAgentCredentials,
  fetchSetup,
} from "../../api/setup";
import { invalidateAgentData, queryClient } from "../../api/query-client";
import { queryKeys } from "../../api/query-keys";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { CredentialEditor } from "../settings/CredentialEditor";

type InlineCredentialFormProps = {
  setup: SetupResponse;
  onConfigured: (setup: SetupResponse) => void;
};

const PROVIDER_ORDER: CredentialProvider[] = [
  "openai",
  "anthropic",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "azure",
];

function providerModel(provider: CredentialProvider) {
  return (
    MODEL_CATALOG_FALLBACK.find((model) => model.provider === provider)?.id ??
    `${provider}/`
  );
}

function primaryModel(setup: SetupResponse) {
  if (
    !setup.agent.modelSettings ||
    typeof setup.agent.modelSettings !== "object"
  ) {
    return "";
  }
  const primary = (setup.agent.modelSettings as { primary?: unknown }).primary;
  return typeof primary === "string" ? primary.trim() : "";
}

export function InlineCredentialForm({
  setup,
  onConfigured,
}: InlineCredentialFormProps) {
  const existingModel = useMemo(() => primaryModel(setup), [setup]);
  const initialProvider = useMemo<CredentialProvider>(() => {
    const provider = existingModel.split("/", 1)[0] as CredentialProvider;
    return PROVIDER_ORDER.includes(provider) ? provider : "openai";
  }, [existingModel]);

  const [provider, setProvider] = useState<CredentialProvider>(initialProvider);
  const [model, setModel] = useState(
    existingModel || providerModel(initialProvider) || DEFAULT_MODEL_ID,
  );

  const catalogModelOptions = MODEL_CATALOG_FALLBACK.filter(
    (entry) => entry.provider === provider,
  ).map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.id})` }));
  const modelOptions =
    model.trim() &&
    !catalogModelOptions.some((option) => option.value === model.trim())
      ? [{ value: model.trim(), label: model.trim() }, ...catalogModelOptions]
      : catalogModelOptions;
  function handleProviderChange(nextProvider: CredentialProvider) {
    setProvider(nextProvider);
    setModel(providerModel(nextProvider) || DEFAULT_MODEL_ID);
  }

  return (
    <div className="mt-4 border-t border-slate-800/80 pt-4">
      <CredentialEditor
        agentId={setup.agent.id}
        workspaceId={setup.agent.workspaceId}
        initialProvider={provider}
        onProviderChange={handleProviderChange}
        providerOptions={PROVIDER_ORDER}
        submitLabel="Save Credentials"
        disabledReason={!model.trim() ? "Model is required." : null}
        apiKeyExtraFields={
          modelOptions.length > 0 ? (
            <Select
              label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              options={modelOptions}
            />
          ) : (
            <Input
              label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={`${provider}/model-name`}
            />
          )
        }
        onApiKeyCredential={async (credential) => {
          const trimmedModel = model.trim();
          let configured: SetupResponse;
          if (setup.agent.type === "manager") {
            await activateManagerAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider: credential.provider,
              model: trimmedModel,
              runnerKind: "llm_tool_runner",
              newCredential: {
                apiKey: credential.secret,
                label: credential.label ?? `${credential.provider} API key`,
              },
            });
            configured = await fetchSetup(setup.agent.id);
          } else {
            configured = await configureAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider: credential.provider,
              model: trimmedModel,
              label: credential.label ?? `${credential.provider} API key`,
              keyName: credential.keyName,
              secret: credential.secret,
            });
          }
          queryClient.setQueryData(
            queryKeys.setup.byAgent(configured.agent.id),
            configured,
          );
          await invalidateAgentData({
            agentId: configured.agent.id,
            workspaceId: configured.agent.workspaceId,
          });
          onConfigured(configured);
        }}
      />
    </div>
  );
}
