# Canonical Supabase Types Migration Plan

This document turns the Supabase type audit into branch-sized work items that can be executed by parallel agents without stepping on each other.

The canonical schema source remains `supabase/generated/types.ts`. The remaining duplication is mostly in Elixir PostgREST adapters, so the first step is to generate a small bridge artifact that those adapters can consume.

## Current state

- There are no meaningful handwritten JS or TS database row typedefs left outside `supabase/generated/types.ts`.
- The main duplication lives in Elixir modules that hand-maintain Supabase field lists and row expectations.
- `agent` and `credential` already exist in the generated Supabase schema and are the best first migration targets.
- `work_items` is not present in the current generated schema, so tracker cleanup should come after the bridge pattern is proven on `agent_inventory`.

## Proposed execution order

1. Land the bridge artifact generator.
2. Split `agent_inventory` cleanup into separate PRs with disjoint ownership.
3. Tackle follow-up consumers after the first pattern is stable.

## Branch and PR plan

### PR 1: Generate canonical bridge metadata

Branch: `codex/canonical-types-bridge`

Goal: create a generated, language-neutral artifact derived from `supabase/generated/types.ts` that Elixir can use for selected columns and table metadata.

Suggested ownership:
- `scripts/append-supabase-jsdoc-types.mjs`
- new generator script if needed
- new generated manifest file under `supabase/generated/`
- any docs that explain the manifest contract

Definition of done:
- [ ] Add a generator that emits canonical metadata for at least `public.agent` and `public.credential`
- [ ] Commit the generated artifact to the repo
- [ ] Wire the generator into `pnpm run supabase:schema:sync`
- [ ] Document the artifact format and intended consumers
- [ ] Verify the generator is idempotent

Notes:
- Keep this PR focused on generation only.
- Do not refactor Elixir consumers in this branch.
- This PR is the dependency for the parallel cleanup PRs below.

### PR 2: Replace handwritten `agent` column selection with canonical metadata

Branch: `codex/canonical-agent-columns`

Depends on: PR 1

Goal: stop hand-maintaining the `agent` PostgREST select list in the agent inventory adapter.

Suggested ownership:
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/database.ex`
- tests covering `list_agents/0` and `get_agent/1`

Definition of done:
- [ ] Replace the handwritten `agent` select string with data sourced from the generated bridge artifact
- [ ] Keep request behavior unchanged for `list_agents/0`
- [ ] Keep request behavior unchanged for `get_agent/1`
- [ ] Update or add tests that would fail if the selected field list drifts from the generated metadata
- [ ] Avoid modifying credential logic in this branch

Notes:
- This branch should only own the `agent` table selection path.
- Leave `Agent.from_row/2` alone unless a change is strictly required for compatibility.

### PR 3: Replace handwritten `credential` column selection with canonical metadata

Branch: `codex/canonical-credential-columns`

Depends on: PR 1

Goal: stop hand-maintaining the `credential` PostgREST select list in the agent inventory adapter.

Suggested ownership:
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/database.ex`
- tests covering `list_credentials/1`

Definition of done:
- [ ] Replace the handwritten `credential` select string with data sourced from the generated bridge artifact
- [ ] Preserve current redaction behavior and credential mapping behavior
- [ ] Update or add tests that pin the selected canonical field list
- [ ] Avoid modifying `agent` selection logic in this branch

Notes:
- This touches the same Elixir module as PR 2, so sequence or merge order matters.
- If parallel agents are used, one agent should stack on top of the other branch or wait for PR 2 to merge before rebasing.

### PR 4: Tighten `Agent` struct assumptions against canonical metadata

Branch: `codex/canonical-agent-struct`

Depends on: PR 2

Goal: reduce drift between the handwritten `Agent` struct contract and the canonical `agent` row shape.

Suggested ownership:
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/agent.ex`
- any tests that exercise row decoding or public map output

Definition of done:
- [ ] Review every field in `Agent.t()` against canonical `public.agent`
- [ ] Remove any stale field assumptions or document intentional deviations
- [ ] Ensure `from_row/2` only depends on fields that are actually canonical or intentionally derived
- [ ] Ensure `to_public_map/1` still returns the expected launcher API shape

Notes:
- This PR is about shape alignment, not broad API redesign.
- It is acceptable to keep an application-facing struct that differs from raw DB rows, as long as the difference is explicit.

### PR 5: Tighten `StoredCredential` assumptions against canonical metadata

Branch: `codex/canonical-credential-struct`

Depends on: PR 3

Goal: make the redacted credential view clearly derived from the canonical `credential` row contract rather than an independently maintained shape.

Suggested ownership:
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/stored_credential.ex`
- tests covering credential public output

Definition of done:
- [ ] Review `StoredCredential.t()` against canonical `public.credential`
- [ ] Document which fields are canonical vs. derived vs. redacted
- [ ] Preserve current public API behavior unless a deliberate cleanup is called out in the PR
- [ ] Add or update tests that pin the redacted output contract

Notes:
- The `StoredCredential` struct is intentionally not a raw DB row.
- The point here is to remove silent schema drift, not to eliminate the struct entirely.

### PR 6: Tracker follow-up after schema coverage exists

Branch: `codex/canonical-tracker-work-items`

Depends on: separate schema decision

Goal: migrate `Tracker.Database` only after `work_items` is represented in canonical generated schema or a separate schema source is defined.

Suggested ownership:
- `apps/orchestrator/lib/symphony_elixir/tracker/database.ex`
- `apps/orchestrator/lib/symphony_elixir/work_item.ex`
- tracker database tests

Definition of done:
- [ ] Decide whether `work_items` should be added to the canonical Supabase schema flow
- [ ] If yes, extend the bridge artifact to cover it
- [ ] Replace handwritten tracker row assumptions with canonical metadata
- [ ] Update tests to pin the new source of truth

Notes:
- This is not ready to implement yet.
- Do not start this branch until the schema-source question is resolved.

## Parallelization guidance

Safe parallel split after PR 1 lands:

- Agent A: PR 2 `codex/canonical-agent-columns`
- Agent B: PR 4 `codex/canonical-agent-struct` after rebasing on PR 2
- Agent C: PR 3 `codex/canonical-credential-columns`
- Agent D: PR 5 `codex/canonical-credential-struct` after rebasing on PR 3

Constraints:

- PR 2 and PR 3 both touch `agent_inventory/database.ex`, so they should not be merged blindly in parallel without rebasing.
- PR 4 and PR 5 are safer to run in parallel because they own different files.
- PR 6 should stay blocked.

## Checkpoint list

Use this as the high-level rollout tracker:

- [ ] PR 1 landed: bridge artifact generation
- [ ] PR 2 landed: canonical `agent` column selection
- [ ] PR 3 landed: canonical `credential` column selection
- [ ] PR 4 landed: `Agent` struct aligned with canonical metadata
- [ ] PR 5 landed: `StoredCredential` struct aligned with canonical metadata
- [ ] PR 6 scoped: tracker migration decision made
