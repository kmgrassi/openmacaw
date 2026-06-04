// Live test for the OQ-04 credential schema-compat helper.
// Calls hasCredentialForAgent against the configured database with an explicit
// agent/workspace/user tuple. Pre-fix this throws a 502 because
// `credential.agent_id` was dropped; post-fix it returns true/false depending
// on whether a matching credential exists in the new (workspace_id, kind)
// namespace.
//
// Usage:
//   REPRO_AGENT_ID=... REPRO_WORKSPACE_ID=... REPRO_USER_ID=... \
//     tsx apps/api/scripts/repro-credential-check.ts
import "dotenv/config";

import { hasCredentialForAgent, countCredentialsForAgent } from "../src/services/credentials/agent-scope.js";

const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const agentId = (process.env.REPRO_AGENT_ID ?? "").trim();
const workspaceId = (process.env.REPRO_WORKSPACE_ID ?? "").trim();
const userId = (process.env.REPRO_USER_ID ?? "").trim();
const primaryModel = (process.env.REPRO_PRIMARY_MODEL ?? "openai/gpt-5.2").trim();

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
  process.exit(2);
}

for (const [name, value] of [
  ["REPRO_AGENT_ID", agentId],
  ["REPRO_WORKSPACE_ID", workspaceId],
  ["REPRO_USER_ID", userId],
] as const) {
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
}

const agent = {
  id: agentId,
  workspace_id: workspaceId,
  created_by_user_id: userId,
  model_settings: { primary: primaryModel },
};

async function main() {
  console.log(`[repro] checking credentials for agent=${agent.id}`);
  console.log(`[repro] derived provider from model_settings.primary='${primaryModel}'`);
  try {
    const has = await hasCredentialForAgent(SERVICE_ROLE_KEY, userId, agent);
    const count = await countCredentialsForAgent(SERVICE_ROLE_KEY, userId, agent);
    console.log(`[repro] OK — hasCredentialForAgent=${has}, countCredentialsForAgent=${count}`);
    process.exit(0);
  } catch (error) {
    console.error("[repro] THREW:");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

void main();
