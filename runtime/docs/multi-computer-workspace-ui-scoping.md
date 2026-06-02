# Multi-Computer Workspace UI - Scoping

Status: scoping.

## Goal

Make it clear in the platform UI that one workspace can have more than one
local computer connected, and make it easy to understand which computer will
handle a local run.

The first product gap is visibility: users do not have a good mental model for:

- which computers are connected to the workspace,
- which capabilities each computer advertises,
- why a run used one computer instead of another,
- how to express a preference when the default routing decision is not what
  they want.

This scope is the UI/product companion for multi-computer local runtime usage.
It should be implemented primarily in `parallel-agent-platform`, with runtime
contract checks called out where the UI needs data that may not exist yet.

Important runtime caveat: current local relay dispatch is not yet a real
multi-helper scheduler. The registry indexes a single helper per
`{workspace_id, runner_kind}` in
`apps/orchestrator/lib/symphony_elixir/local_relay/registry.ex`, so two
connected computers advertising the same runner kind can overwrite each other,
and one disconnect can remove the lookup for that runner kind. The read-only
inventory UI can still show every registered machine, but run explanations,
fallback behavior, and machine preferences are blocked on the runtime registry
tracking all eligible helpers for a runner kind and selecting among them
deliberately.

## User Stories

- As a user with a home desktop and an office desktop, I can see both machines
  under the same workspace and tell which one is currently online.
- As a user starting a local model run, I can understand which computer is
  eligible before I send the message.
- As a user reviewing a run, I can see which computer handled it and the
  reason it was selected.
- As a user with one preferred machine for a specific workflow, I can choose a
  preference without needing to create a second workspace.
- As a user debugging why local execution did not work, I can see whether the
  blocker was "no computers online", "runner kind unavailable", or "preferred
  machine offline".

## Non-Goals

- Do not introduce separate workspaces per machine.
- Do not make users manage relay sockets, tokens, or helper internals from the
  main workflow.
- Do not build full scheduler policy editing in the first PR.
- Do not add backwards-compatible aliases for machine preference values. If a
  preference enum changes, update producers, consumers, and stored values in
  the same PR series.
- Do not make runtime infer machine selection from display names. Machine IDs
  remain the durable identifiers.

## Proposed UI Surfaces

### Connected Computers Panel

Add a workspace-level "Connected Computers" surface that lists every
`local_runtime_machine` visible to the workspace.

Suggested fields:

| Field | Source | Notes |
| --- | --- | --- |
| Display name | `local_runtime_machine.display_name` | User-facing machine label. |
| Presence | `last_seen_at` plus runtime heartbeat threshold | Online, recently seen, offline. |
| Runner kinds | `advertised_runner_kinds` | Show `codex`, `openclaw`, `manager`, etc. |
| Helper version | `helper_version` | Warn when stale once version policy exists. |
| Last run | Run/session metadata | Useful but can ship after the first panel. |

The panel should be reachable from workspace settings and from any local
runtime setup page. It should answer "what computers can this workspace use?"
without forcing the user into a diagnostic endpoint.

### Run-Level Routing Explanation

For every local run or failed local dispatch, show a compact routing
explanation:

```text
Computer: Office Mac Studio
Reason: selected automatically because it is online and advertises codex
```

Failure examples:

```text
No connected computer advertises planner for this workspace.
```

```text
Preferred computer Home MacBook is offline. Last seen 18 minutes ago.
```

This explanation should be derived from structured routing metadata, not from
free-form logs. If runtime does not currently persist the selected machine ID
and reason, add that to the relevant run/session metadata contract before the
UI depends on it.

### Machine Preference Control

Expose machine selection in phases. The first UI should make the current
automatic behavior legible before adding controls that can strand runs on an
offline machine.

Proposed preference values:

| Value | Meaning | First UI behavior |
| --- | --- | --- |
| `auto` | Use the current computer when it is known, online, and eligible. | Default. |
| `prefer_machine` | Use a specific machine when available, otherwise fall back to another eligible machine. | Phase 2. |
| `pin_machine` | Use only a specific machine; fail clearly if unavailable. | Phase 3 or admin/advanced only. |

The preference should be stored as structured data with a machine ID, not a
display name:

```json
{
  "mode": "prefer_machine",
  "machine_id": "local-machine-uuid"
}
```

Do not add alias values such as `preferred`, `specific`, or `local_runtime`.
If these values become persisted enums, update DB constraints and every
producer/consumer together.

`pin_machine` means "only run on this machine." If the pinned machine is
offline, revoked, or does not advertise the requested runner kind, the run
should fail with a clear routing explanation instead of silently falling back.
That is useful for workflows tied to a specific filesystem, credential store,
or hardware setup, but it is easy to misconfigure. Keep it out of the first
preference UI unless there is a strong advanced-user need.

## Runtime And API Contract Needs

The UI is only useful if it can read the following from stable contracts:

1. **Machine inventory.** Platform can query workspace machines with display
   name, revocation state, last seen time, helper version, and advertised
   runner kinds. The generated and live Supabase schemas already expose the
   first UI fields on `local_runtime_machine`: `display_name`, `last_seen_at`,
   `helper_version`, and `advertised_runner_kinds`. The older `runner_kinds`
   column also exists, but new UI should prefer `advertised_runner_kinds`
   because it reflects the helper's current heartbeat/register payload.
2. **Automatic local machine registration.** On local helper startup, the
   setup/register path should create or update the user's
   `local_runtime_machine` row automatically using the workspace ID, user ID,
   a stable machine identity, display name, helper version, and advertised
   runner kinds. The user should not have to manually create a computer before
   local runs work. The helper should then register with that
   `local_runtime_machine.id`, and the platform should be able to treat that
   ID as the current computer for interactive routing.
3. **Existing-user login backfill.** For users who already completed onboarding
   before this machine inventory existed, the first authenticated app session
   should check whether the current workspace/user has a
   `local_runtime_machine` row for this computer. If the browser/helper can
   identify a stable local machine identity and no non-revoked row exists,
   create one automatically and continue. This should be idempotent, should not
   create duplicate rows on every login, and should not require users to repeat
   local runtime setup just to populate the database.
4. **Multi-helper dispatch index.** Runtime local relay should track all helpers
   for `{workspace_id, runner_kind}` instead of a single helper ID, and removal
   of one helper must not delete other eligible helpers from the lookup.
5. **Machine selection policy.** Runtime needs an explicit selection step for
   multiple eligible helpers. The default policy should select the current
   computer the user is operating from when that machine ID is known, online,
   unrevoked, and advertises the requested runner kind. If the current computer
   cannot be identified, runtime should return a structured
   `current_machine_unknown` or `no_eligible_current_machine` reason rather
   than pretending it made a meaningful automatic choice. Background work that
   has no current user computer should use an explicit machine preference or a
   later scheduler policy.
6. **Presence threshold.** Platform should derive online/offline thresholds
   from the runtime heartbeat contract instead of hardcoding arbitrary UI
   values. If needed, expose `heartbeat_interval_ms` from a local runtime
   metadata endpoint.
7. **Selected machine metadata.** Runs that dispatch through local relay should
   record the selected machine ID and selected runner kind. For gateway chat,
   persist this on the assistant `message.metadata` for the row with the
   matching `run_id`; the `message` table already has `run_id`, `runner_kind`,
   `model`, `provider`, `metadata`, and `payload` fields. For scheduled runs,
   mirror the same object onto `scheduled_task_run.metadata` so background
   deliveries can be inspected without joining through chat messages. Do not
   use `work_items.metadata` as the canonical execution record; it describes
   planned work and routing hints, not the actual dispatch decision. A
   dedicated execution table can be deferred until analytics or retention needs
   exceed what message/run metadata can support.
8. **Routing reason.** Runtime or platform should produce a short structured
   reason code, such as `current_machine_selected`, `current_machine_unknown`,
   `no_eligible_current_machine`, `preferred_machine_online`,
   `preferred_machine_offline_fallback`, `pinned_machine_offline`, or
   `no_eligible_machine`.
9. **Capability mismatch detail.** When no machine can run the request, the UI
   needs the requested runner kind and the machines that were considered.
10. **Current machine identity.** The platform/runtime boundary needs a trusted
   way to know the current computer for interactive requests, most likely by
   passing the active `local_runtime_machine.id` from the logged-in local
   helper/browser context into local relay dispatch. Without that field,
   `auto` cannot mean "this computer" in a multi-machine workspace.

Preference resolution split:

- Platform owns user preference storage and display.
- Runtime owns final liveness-aware dispatch because it has the freshest relay
  presence.
- Runtime returns selected machine metadata so the platform can explain the
  decision.

Preference scope:

- Store machine preference on the routing rule first, because routing rules are
  already the place where the platform resolves runner kind, provider, model,
  transport, execution location, and fallback behavior.
- Agent-level UI can expose a simple default by writing to the routing rule
  that targets that agent. Avoid a separate agent-only preference store in v1;
  it would create precedence rules that duplicate routing.
- Workspace-level defaults can come later if there is a real need, but they
  should be lower precedence than routing-rule preferences.

No-shim rollout:

- Prefer a no-shim rollout. Add one canonical structured preference shape,
  update platform writers/readers and runtime readers in the same PR series,
  and regenerate schema artifacts in this repo after the `harper-server`
  migration lands.
- Because this is a new preference surface, there should be no existing
  persisted values to normalize. Do not accept aliases like `preferred`,
  `specific`, `local_runtime`, or `openai-compatible`.
- If a temporary compatibility path becomes unavoidable during deployment,
  keep it behind a short-lived migration flag with a removal PR already scoped;
  do not leave dual-format support in normal runtime code.

## Implementation Plan

### PR1 - Read-Only UI

- Make local helper startup create or update the user's
  `local_runtime_machine` row automatically and register relay connections with
  that machine ID.
- Add an existing-user login backfill that checks for a current-computer
  machine row and creates it when missing.
- Add a Connected Computers panel in the platform.
- List machine display name, presence, advertised runner kinds, and helper
  version when available.
- Add empty states for no machines and no online machines.
- Link to existing local runtime setup/wizard flows.
- No preference editing yet.

Acceptance criteria:

- Starting the local helper creates or updates the current computer row without
  manual user configuration.
- An already-onboarded user who logs in from a machine without a
  `local_runtime_machine` row gets one created automatically, without duplicate
  rows on subsequent logins.
- A workspace with two connected helpers shows both machines.
- Revoked or offline machines are visually distinct from online machines.
- The UI makes it clear that multiple machines belong to the same workspace.

### PR2 - Run Explanation

- Change runtime local relay registry/dispatch to support multiple helpers per
  `{workspace_id, runner_kind}`.
- Ensure helper removal only removes that helper from the eligible set and does
  not clear the whole runner-kind lookup while other helpers remain connected.
- Pass the current local runtime machine ID for interactive requests.
- Add automatic selection that chooses the current computer when it is known,
  online, unrevoked, and eligible.
- Persist selected machine metadata on `message.metadata` for chat runs and
  `scheduled_task_run.metadata` for scheduled runs.
- Add structured routing reason codes.
- Show the selected machine and reason in run details or the relevant chat/run
  status surface.
- Show clear failure explanations when no eligible machine exists.

Acceptance criteria:

- A successful local run from an eligible connected computer shows that current
  computer as the selected machine.
- A failed local run distinguishes no online machine from no matching runner
  kind and unknown current machine.
- Two connected helpers advertising the same runner kind remain independently
  eligible, and disconnecting one does not make the other unreachable.
- The explanation uses stable fields, not log parsing.

### PR3 - Preference Controls

- Build on PR2's multi-helper dispatch; do not expose preferences while runtime
  can only look up one helper per runner kind.
- Add `auto` and `prefer_machine` controls to routing-rule configuration.
- Let agent-level UI edit the matching routing rule when users expect a
  per-agent preference.
- Store preference as `{mode, machine_id}`.
- Add fallback explanation when the preferred machine is offline and another
  machine is selected.
- Keep `pin_machine` behind a later phase unless there is a strong workflow
  need.

Acceptance criteria:

- Default behavior remains `auto`.
- Selecting `prefer_machine` chooses that machine when online and eligible.
- If the preferred machine is offline, the run falls back and explains why.

### PR4 - Pinning And Admin Controls

- Add `pin_machine` only after the failure UX has proven clear.
- Consider admin-only controls for revoking stale machines and renaming
  display names.
- Add diagnostic links for advanced debugging.

Acceptance criteria:

- Pinned runs fail clearly when the pinned machine is unavailable.
- Users can recover by switching back to `auto` without editing raw config.

## Observability

Track these events or equivalent structured logs:

- connected computers panel viewed,
- local run selected current machine automatically,
- local run could not identify current machine,
- local run used preferred machine,
- local run fell back from preferred machine,
- local run failed because pinned machine was unavailable,
- local run failed because no eligible machine advertised the runner kind.

Operational dashboards should be able to answer:

- how many workspaces have more than one local machine,
- how often automatic selection uses the current computer,
- how often current-computer selection fails because the machine is unknown,
  offline, revoked, or missing the runner kind,
- how often preferences cause fallback or failure,
- which runner kinds most often lack an online machine.

## Risks

- **Stale presence makes the UI lie.** Mitigate by deriving thresholds from
  runtime heartbeat contracts and showing "last seen" where useful.
- **Preferences create brittle routing.** Ship read-only visibility first,
  then `prefer_machine`, then `pin_machine`.
- **Display names are ambiguous.** Always store and route by machine ID.
- **Runtime and platform disagree on eligibility.** Keep final dispatch
  liveness-aware in runtime and return selected-machine metadata to platform.
- **UI promises multi-machine fallback before runtime can honor it.** Gate run
  explanation and preference controls on a runtime registry/indexing change
  that stores all eligible helpers for a runner kind.
- **Current computer identity is missing.** `auto` cannot select "the computer
  the user is running on" unless interactive requests include a trusted
  `local_runtime_machine.id`. Treat missing identity as an explicit routing
  reason, not as a silent fallback to an arbitrary helper.
- **Machine creation is too manual.** Mitigate by upserting the current
  `local_runtime_machine` during helper startup/setup and registering with that
  ID for all relay connections.
- **Already-onboarded users have no machine row.** Mitigate with an idempotent
  first-login check that creates the current computer row when missing.
- **Schema changes land in the wrong repo.** Database migrations belong in
  `harper-server`; this repo only vendors regenerated schema artifacts after
  migration.

## Resolved Questions

1. `local_runtime_machine` already contains the first UI fields:
   `display_name`, `last_seen_at`, `helper_version`, and
   `advertised_runner_kinds`.
2. Persist selected machine metadata on `message.metadata` for chat runs and
   mirror it to `scheduled_task_run.metadata` for scheduled/background runs.
   Do not use `work_items.metadata` as the canonical execution record.
3. Scope preferences to routing rules first. Agent-level controls should edit
   the matching routing rule instead of creating a second preference system.
4. `pin_machine` means no fallback. Keep it advanced/later-phase because it can
   intentionally fail runs when the pinned machine is offline or ineligible.
5. Use a no-shim rollout for the new preference shape. If deployment forces
   temporary compatibility, keep it flagged and remove it in a scoped follow-up.
6. Automatic selection should choose the current computer for interactive runs
   when the current machine ID is known and eligible. Missing current-machine
   identity is a contract gap to fix, not a reason to pick an arbitrary helper.

## First PR Definition Of Done

- Platform has a Connected Computers panel reachable from workspace/local
  runtime settings.
- The panel works for zero, one, and multiple machines.
- Presence and runner-kind display are based on structured fields.
- The UI does not expose preference editing yet.
- Any missing runtime/schema contract is documented as a blocker or follow-up
  with an owner repo.
