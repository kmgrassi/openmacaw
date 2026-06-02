import { asRecord } from "../../../../../contracts/agent-helpers.js";

export function firstGatewayRunner(configJson: unknown) {
  const config = asRecord(configJson);
  const runners = config?.runners;
  if (Array.isArray(runners)) return asRecord(runners[0]);
  if (runners && typeof runners === "object") {
    const map = runners as Record<string, unknown>;
    // Prefer the canonical "manager" key (written by repairManagerGatewayConfig).
    const managerEntry = asRecord(map.manager);
    if (managerEntry) return managerEntry;
    for (const value of Object.values(map)) {
      const entry = asRecord(value);
      if (entry) return entry;
    }
  }
  return null;
}

export function legacyCredentialRef(runner: Record<string, unknown> | null) {
  const credentialId = typeof runner?.credential_id === "string" ? runner.credential_id.trim() : "";
  if (credentialId) return { type: "credential_id" as const, value: credentialId };

  const credentialAlias = typeof runner?.credential_alias === "string" ? runner.credential_alias.trim() : "";
  if (credentialAlias) return { type: "alias" as const, value: credentialAlias };

  return null;
}
