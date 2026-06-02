import type { ExecutionProfileResolution } from "../../../../../../contracts/execution-profile.js";

/**
 * Snake-cased execution profile block embedded in `gateway_config.config_json`.
 *
 * The runtime (`apps/orchestrator/lib/symphony_elixir/execution_profile.ex`)
 * reads this block via `explicit_profile/1` so the launcher can resolve a
 * credential at launch time without falling back to the legacy
 * gateway-config-runner code path. Only the credential **id** is stored
 * here — the runtime resolves the actual secret from the `credential` table
 * at launch time. Never include `api_key` / `key_value` here.
 */
export type ResolvedExecutionProfileBlock = {
  runner_kind: string;
  provider: string;
  model: string;
  tool_profile: string;
  credential_id?: string;
  credential_alias?: string;
};

/**
 * Build the snake-cased `execution_profile` block from a resolver result.
 *
 * Returns `null` when the resolver could not produce a profile (e.g. no
 * routing rule and no gateway_config runner) — callers should omit the
 * block from `config_json` in that case rather than writing a partial
 * block that would mislead the runtime.
 */
export function buildExecutionProfileBlock(
  resolution: ExecutionProfileResolution | null,
): ResolvedExecutionProfileBlock | null {
  if (!resolution?.profile) return null;
  const { profile } = resolution;
  if (!profile.runnerKind || !profile.provider || !profile.model) return null;

  const block: ResolvedExecutionProfileBlock = {
    runner_kind: profile.runnerKind,
    provider: profile.provider,
    model: profile.model,
    tool_profile: profile.toolProfile,
  };

  if (profile.credentialRef?.type === "credential_id") {
    block.credential_id = profile.credentialRef.value;
  } else if (profile.credentialRef?.type === "alias") {
    block.credential_alias = profile.credentialRef.value;
  }

  return block;
}
