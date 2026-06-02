import {
  getCredentialProviderMetadata,
  normalizeCredentialProvider,
  type CredentialKey,
} from "../../../../../../contracts/credentials.js";
import type { SetupRequest } from "../../../../../../contracts/setup.js";

export function buildCredentialJson(credential: SetupRequest["credentials"][number]): CredentialKey {
  const normalizedSecret = credential.secret.trim();
  const provider = normalizeCredentialProvider(credential.provider);
  if (!provider || provider === "openai_codex") {
    throw new Error(`Unsupported API key credential provider: ${credential.provider}`);
  }
  const providerMetadata = getCredentialProviderMetadata(provider);
  return {
    format: "api_key",
    provider,
    secret: normalizedSecret,
    label: credential.label ?? providerMetadata?.label ?? credential.provider,
    keyLast4: normalizedSecret.slice(-4),
  };
}
