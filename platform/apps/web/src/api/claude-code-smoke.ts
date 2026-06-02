import {
  ClaudeCodeSmokeResponseSchema,
  type ClaudeCodeSmokeResponse,
} from "../../../../contracts/claude-code-smoke";
import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { ROUTES } from "./routes";

export async function getClaudeCodeSmoke(): Promise<ClaudeCodeSmokeResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.claudeCodeSmoke}`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load Claude Code smoke fixture (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return ClaudeCodeSmokeResponseSchema.parse(await response.json());
}
