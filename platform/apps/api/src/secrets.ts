import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractSecretValue(secretString: string, aliases: string[]): string | null {
  const trimmed = secretString.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    if (!record) return trimmed;

    for (const alias of aliases) {
      const value = record[alias];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    for (const fallback of ["value", "secret", "api_key"]) {
      const value = record[fallback];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  } catch {
    return trimmed;
  }
}

export async function resolveSecretReference(secretRef: string, aliases: string[]): Promise<string | null> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: secretRef,
    }),
  );

  if (typeof response.SecretString === "string") {
    return extractSecretValue(response.SecretString, aliases);
  }

  return null;
}
