# OPENCLAW_STATE_DIR Removal Plan (harper-openclaw-client)

## Scope in this repo
Client has no direct `OPENCLAW_STATE_DIR` usage. Impact is contract/UI behavior when runtime stops reporting local file-based session paths.

## Required changes
1. Remove any UI assumptions that `health.sessions.path` is meaningful/required.
2. Treat session health as API-derived state, not filesystem diagnostics.
3. Update debugging surfaces to show state API source + IDs (agent/workspace/session), not local paths.
4. Ensure onboarding/runtime readiness UX still works when local store counts are absent.

## Contract expectations
- Health payload should prioritize logical state (counts, recency, source) over local path strings.
- If path is retained temporarily, mark as legacy/non-authoritative.

## Validation
- Build/typecheck passes.
- Manual control UI verification: no broken rendering when `sessions.path` is missing.
- Session list/recent activity still visible via state-backed endpoints.
