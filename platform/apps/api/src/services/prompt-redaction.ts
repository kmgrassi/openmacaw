import {
  listSavedCredentialsForAgentFromSupabase,
  listSavedModelProviderCredentialsForWorkspaceFromSupabase,
} from "./saved-credentials.js";
import { resolveStoredCredentialSecret } from "./stored-credentials.js";

type RedactableCredential = {
  secretValue: string;
  secretRef: string | null;
  aliases: string[];
};

export type PromptRedactionResult = {
  prompt: string;
  redactionCount: number;
};

const REDACTED_SECRET = "<redacted>";
const MIN_SECRET_LENGTH = 8;

function countOccurrences(value: string, search: string) {
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}

function uniqueSecrets(secrets: string[]) {
  return [
    ...new Set(
      secrets
        .map((secret) => secret.trim())
        .filter((secret) => secret.length >= MIN_SECRET_LENGTH && secret !== REDACTED_SECRET),
    ),
  ].sort((left, right) => right.length - left.length);
}

export function redactPromptCredentialSecrets(prompt: string, secrets: string[]): PromptRedactionResult {
  let redacted = prompt;
  let redactionCount = 0;

  for (const secret of uniqueSecrets(secrets)) {
    const occurrences = countOccurrences(redacted, secret);
    if (occurrences === 0) continue;

    redactionCount += occurrences;
    redacted = redacted.split(secret).join(REDACTED_SECRET);
  }

  return {
    prompt: redacted,
    redactionCount,
  };
}

async function resolveCredentialSecrets(credentials: RedactableCredential[]) {
  const secrets = await Promise.all(credentials.map(async (credential) => resolveStoredCredentialSecret(credential)));
  return secrets.filter((secret): secret is string => typeof secret === "string" && secret.trim().length > 0);
}

export async function redactOutboundPromptForWorkspace(input: {
  prompt: string;
  planningAgentId: string;
  workspaceId: string;
  userId: string;
}): Promise<PromptRedactionResult> {
  const [agentCredentials, workspaceCredentials] = await Promise.all([
    listSavedCredentialsForAgentFromSupabase(input.planningAgentId, input.workspaceId),
    listSavedModelProviderCredentialsForWorkspaceFromSupabase(input.workspaceId, input.userId),
  ]);

  const secrets = await resolveCredentialSecrets([...agentCredentials, ...workspaceCredentials]);
  return redactPromptCredentialSecrets(input.prompt, secrets);
}
