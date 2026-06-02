import type { CredentialProviderMetadata } from "../../../../contracts/credentials";

type ViteEnv = ImportMetaEnv & Record<string, string | undefined>;

function devEnvValue(name: string): string | null {
  if (!import.meta.env.DEV) return null;
  const value = (import.meta.env as ViteEnv)[name]?.trim();
  return value || null;
}

export function devApiKeyForProvider(
  metadata: Pick<CredentialProviderMetadata, "envVar"> | null | undefined,
): string | null {
  if (!metadata?.envVar) return null;
  return devEnvValue(`VITE_DEV_${metadata.envVar}`);
}

export function devOpenAICodexAccessToken(): string | null {
  return devEnvValue("VITE_DEV_OPENAI_CODEX_ACCESS_TOKEN");
}
