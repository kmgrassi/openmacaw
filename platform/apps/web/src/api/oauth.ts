import {
  ImportOpenAICodexOAuthResponseSchema,
  PollOpenAICodexOAuthResponseSchema,
  StartOpenAICodexOAuthResponseSchema,
  type ImportOpenAICodexOAuthResponse,
  type PollOpenAICodexOAuthResponse,
  type StartOpenAICodexOAuthResponse,
} from "../../../../contracts/credentials-oauth";
import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { ROUTES } from "./routes";

async function readJsonError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text ? `${response.status}: ${text}` : `${response.status}`;
}

export async function startOpenAICodexOAuth(input: {
  agentId: string;
  workspaceId: string;
}): Promise<StartOpenAICodexOAuthResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.openaiCodexOAuthStart}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not start OAuth (${await readJsonError(response)})`);
  }
  return StartOpenAICodexOAuthResponseSchema.parse(await response.json());
}

export async function pollOpenAICodexOAuth(
  sessionId: string,
): Promise<PollOpenAICodexOAuthResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.openaiCodexOAuthPoll}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not poll OAuth (${await readJsonError(response)})`);
  }
  return PollOpenAICodexOAuthResponseSchema.parse(await response.json());
}

export async function importOpenAICodexOAuth(input: {
  agentId: string;
  workspaceId: string;
  accessToken: string;
}): Promise<ImportOpenAICodexOAuthResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.openaiCodexOAuthImport}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not import OAuth token (${await readJsonError(response)})`,
    );
  }
  return ImportOpenAICodexOAuthResponseSchema.parse(await response.json());
}
