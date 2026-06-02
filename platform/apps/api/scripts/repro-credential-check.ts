// Live test for the OQ-04 credential schema-compat helper.
// Calls hasCredentialForAgent against the production database with
// the user's actual coding agent. Pre-fix this throws a 502 because
// `credential.agent_id` was dropped; post-fix it returns true/false
// depending on whether a matching credential exists in the new
// (workspace_id, kind) namespace.
//
// Usage:
//   tsx apps/api/scripts/repro-credential-check.ts
import "dotenv/config";

import { hasCredentialForAgent, countCredentialsForAgent } from "../src/services/credentials/agent-scope.js";

const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
  process.exit(2);
}

// The user's coding agent referenced in the failing /dashboard URL.
const agent = {
  id: "8232f930-cd70-43f9-a9a2-6d7cbdd983e5",
  workspace_id: "a8019dd7-5485-473c-81b9-4bf899401413",
  created_by_user_id: "5fba1deb-f915-48c9-a7a1-7c93f781c5d9",
  model_settings: { primary: "openai/gpt-5.2" },
};

async function main() {
  console.log(`[repro] checking credentials for agent=${agent.id}`);
  console.log(`[repro] derived provider from model_settings.primary='openai/gpt-5.2' -> openai`);
  try {
    const has = await hasCredentialForAgent(SERVICE_ROLE_KEY, agent);
    const count = await countCredentialsForAgent(SERVICE_ROLE_KEY, agent);
    console.log(`[repro] OK — hasCredentialForAgent=${has}, countCredentialsForAgent=${count}`);
    process.exit(0);
  } catch (error) {
    console.error("[repro] THREW:");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

void main();
