# Onboarding Flow Scope

Status: draft / boilerplate. This is a starting point for the coding agents
that will implement first-run onboarding. Tighten the open questions before
opening PRs.

## Goal

Give a brand-new user the shortest possible path from "I just heard about
this product" to "I'm talking to my planning agent."

The flow has to cover the three things a first-time user needs to do:

1. Create an account (sign up).
2. Sign in.
3. Provision agents that can actually run — which means either supplying
   a cloud model API key, **or** routing to a locally hosted model so the
   user can try the product without handing over a key. Either path
   configures **all three default agents** (planning, coding, manager) in
   one shot, and lands the user in a conversation with the planning agent.
   The planning agent is the surface the user actually talks to; the
   coding and manager agents work in the background.

**Design rule: one decision per card.** The current
`apps/web/src/components/OnboardingWizard/index.tsx` is a single kitchen-sink
form (workspace, agent name, model, workflow template, repo URL, tracker
kind, tracker project, tracker endpoint, tracker token, two API keys, runner
kind, runner model, max concurrency) on one screen. That is the explicit
anti-pattern this scope replaces. Each card shows one thing, asks for one
answer, and advances.

## Non-Goals

- Team/workspace invites or multi-user collaboration onboarding.
- Billing or plan-selection screens.
- Tracker integration setup (GitHub/Linear). Tracker defaults to in-memory
  for first-run; integrations belong in settings, not onboarding.
- Reworking the default-agent bootstrap backend — that already shipped in
  [shipped/default-agents-onboarding-plan.md](../shipped/default-agents-onboarding-plan.md).
  This scope is the **UX layer** on top of those backend primitives.
- Email verification UX polish beyond what Supabase ships by default.

## What Already Exists

So coding agents don't reinvent these:

- `apps/web/src/components/Login.tsx` — email/password sign-in, dev-credential
  shortcut in `VITE_DEV_LOGIN_EMAIL` / `VITE_DEV_LOGIN_PASSWORD` mode.
- `apps/web/src/components/SignUp.tsx` — email/password sign-up with
  confirm-password.
- `apps/web/src/routes/Onboarding.tsx` + `components/OnboardingWizard/` —
  the single-page kitchen-sink wizard this scope replaces.
- `/api/auth/state` — already provisions a default planning agent and a
  default coding agent in the user's first workspace, and reports
  `onboarding.required` / `defaultAgents.*.configured`. See
  [shipped/default-agents-onboarding-plan.md](../shipped/default-agents-onboarding-plan.md).
- `POST /api/default-agents/credentials` — already applies one API key to
  selected default agents.
- `apps/web/src/components/settings/LocalModelsSection.tsx` +
  `local-runtime-helper` repo — the local-model bypass plumbing exists; the
  onboarding flow should reuse it, not duplicate it.

## Card-By-Card Flow

Cards are sequential. Each card has one input or one decision. "Back" is
always available except after irreversible steps. Progress (e.g. "3 of 5")
is shown in a header.

### Card 1 — Sign Up

Route: `/signup` (already exists; trim to match this design).

Shown to: anyone hitting `/signup` or `/` when not authenticated and choosing
"Create account."

Contents:

- Email input.
- Password input.
- Confirm-password input.
- "Create account" button.
- Footer link: "Already have an account? Sign in."

On submit: call Supabase sign-up. On success, show Card 2.

Assumption: email confirmation is **off** on the Supabase project for the
first cut. If it is later turned on, add a "check your inbox" interstitial;
do not block this scope on it.

Out of scope: SSO, OAuth providers, magic links. Stay email + password for
the first cut.

### Card 2 — Sign In

Route: `/login` (already exists; keep).

Contents:

- Email input.
- Password input.
- "Sign in" button.
- "Use dev credentials" button when `VITE_DEV_LOGIN_EMAIL` /
  `VITE_DEV_LOGIN_PASSWORD` are set (already implemented; keep).
- Footer link: "Don't have an account? Sign up."

On success: call `/api/auth/state`. The backend has already provisioned
default agents and returns `onboarding.required`. Branch on the response:

- `onboarding.required === false` → route to `/dashboard/<agent-id>`. Done.
- `onboarding.required === true` → route to `/onboarding`, which starts at
  Card 3.

### Card 3 — Choose How To Run Your Agent

Route: `/onboarding` (replace today's monolithic wizard).

Contents:

- Heading: "How do you want to run your agent?"
- Two large picker cards, exactly one selectable:
  1. **Use a cloud model** — "Bring an OpenAI or Anthropic API key." Subtext:
     "Fastest path. Costs go to your provider account."
  2. **Use a local model** — "Run a model on this machine, no API key
     required." Subtext: "Requires installing the local-runtime-helper."
- "Continue" button (disabled until a choice is made).

On submit: route to Card 4a or Card 4b based on the choice. Persist the
choice in the onboarding store so a Back from Card 4 returns here with the
selection intact.

### Card 4a — Add an API Key (cloud path)

This single submission configures **all three default agents** — coding,
manager, and planning — with the same provider and key. The platform
already creates these three at sign-up (see "What Already Exists" — auth
state exposes `defaultAgents.planning`, `defaultAgents.coding`, and
`managerAgent`). The card is the UX that wires credentials onto all of
them in one shot.

Contents:

- Provider dropdown:
  1. OpenAI (default — confirmed).
  2. Anthropic.
  3. Other supported providers, alphabetical.
- API key input (single field, type=password).
- A read-only list of the three default agents the key will configure,
  with a brief role description that mirrors how the user is expected to
  interact with each:
  - **Planning agent** — "This is the agent you talk to. It plans work
    and hands coding tasks off to your coding agent."
  - **Coding agent** — "Works in the background. The planning agent
    sends it coding tasks; you rarely need to message it directly."
  - **Manager agent** — "Works in the background to coordinate work
    across your agents."

  All three are configured by default. The first cut does **not** expose
  per-agent checkboxes — the goal is one decision per card, and "which
  agents to configure" is not a decision the user should be making on
  their first run. If a user wants to leave one unconfigured, they can do
  it in settings later.

- "Save key and continue" button.

**Required payload.** `DefaultAgentCredentialApplicationRequestSchema` in
`contracts/setup.ts` requires `workspaceId`, `provider`, `model`,
`keyName`, `secret`, and `agentIds` (all camelCase, per the API-boundary
convention in `CLAUDE.md`). The user only types the API key on this card.
Everything else is supplied by the frontend without prompting:

| Field | Source on Card 4a |
| --- | --- |
| `workspaceId` | `auth.workspaceId` from the `/api/auth/state` response. |
| `provider` | Provider dropdown selection. Default `openai`. |
| `model` | Client-side default-model lookup keyed by provider — e.g. `openai` → `openai/gpt-5.2`, `anthropic` → `anthropic/claude-sonnet-4-6`. Lives in a small constant table in the onboarding store. PR6 (smart per-agent defaults) is allowed to delete this table and move the lookup server-side — until then, keep it client-side. |
| `keyName` | Derived from the provider — e.g. `openai` → `OPENAI_API_KEY`, `anthropic` → `ANTHROPIC_API_KEY`. Same client-side table. |
| `secret` | The API key the user typed. |
| `agentIds` | `[planningAgentId, codingAgentId, managerAgentId]` — read from `auth.defaultAgents.planning.agentId`, `auth.defaultAgents.coding.agentId`, and `auth.managerAgent.agentId`. |
| `label` (optional) | Skip on first run. |

Concretely, the submit body looks like:

```ts
{
  workspaceId: auth.workspaceId,
  provider: "openai",                       // from dropdown
  model: DEFAULT_MODEL_BY_PROVIDER["openai"], // client-side table
  keyName: KEY_NAME_BY_PROVIDER["openai"],    // client-side table
  secret: typedKey,
  agentIds: [
    auth.defaultAgents.planning.agentId,
    auth.defaultAgents.coding.agentId,
    auth.managerAgent.agentId,
  ],
}
```

The endpoint already accepts an `agentIds` array — no contract change
needed for this PR. On success, advance to Card 5. On error, surface the
message inline and stay on this card so the user can fix the key without
losing the path selection (this is the "fail on the given step" rule from
Card 5 below).

Out of scope on this card:

- Letting the user choose a model. Card 4a always submits the client-side
  default for the chosen provider; a "change model" affordance lives in
  settings.
- **Smart per-agent defaults.** For the first cut, all three agents get
  the same provider/model. A follow-up PR will swap in type-specific
  defaults (different model per role, different `tool_policy`, different
  `workflow_template`). That belongs in its own PR — see PR Sequence below.
- Per-agent opt-out. Configure all three or none.

`resolvedAgentId` change: the shipped `default-agents-onboarding-plan.md`
defines `resolvedAgentId` preference as **coding first, planning second**.
That is wrong for the product direction. The implementing PR should
**flip the preference order** so a configured planning default wins over
a configured coding default. New preference order:

1. configured planning default
2. configured coding default
3. planning default
4. coding default
5. existing fallback behavior

Call this out explicitly in the PR description and ship the change in
the same PR that wires Card 4a. The flip is necessary so that on first
landing after onboarding, the user is dropped into the planning agent's
conversation surface — the coding agent is background-only in normal use.

### Card 4b — Set Up a Local Model (no-key path)

Contents:

- Heading: "Run a model on this machine."
- A short, numbered checklist with copy-buttons:
  1. Install Ollama (or another local OpenAI-compatible server) and pull a
     model (e.g. `ollama pull qwen2.5-coder`).
  2. Clone and start `local-runtime-helper` (`pnpm run start:local-helper`
     from that repo).
  3. Click "Connect helper" below.
- **"Test connection" button** (explicit, single-click). On click, fire a
  one-shot probe against the same endpoint `LocalModelsSection` uses
  today. Show the result inline immediately:
  - ✅ "Helper online — model `<name>` detected."
  - ❌ "Couldn't reach the helper at `<endpoint>`." + the specific reason.

  Continuous polling runs in the background once the test passes, so the
  status stays fresh, but the user always has an immediate-feedback button
  they can click on demand. Don't make the user wait on a silent polling
  interval to know if their setup worked.

- Skip link: "I'll set this up later." Marks onboarding non-blocking and
  sends the user to the dashboard with a persistent nudge (see Nudge below).

On helper-online + a successful test: register the local model against
**all three default agents** through the same path `LocalModelsSection`
uses today, mirroring Card 4a's "configure all three" rule. Advance to
Card 5.

Reuse `LocalModelsSection` logic — do not fork it. The onboarding card is a
slimmed presentation of the same calls.

### Card 5 — Launch Your First Agent

Contents:

- Heading: "You're ready. Land in your dashboard."
- Read-only summary:
  - All three default agents that were just configured (planning, coding,
    manager) with a check next to each.
  - Provider / model that was just configured.
  - Workspace name.
- "Go to dashboard" button.

On submit: route to the dashboard view where the **planning agent** is
the active conversation surface. The user lands talking to planning —
not to coding, not to manager. (Per the `resolvedAgentId` flip on
Card 4a, planning wins the preference order, so the dashboard route
falls out of that change automatically.) Whichever agents need a runtime
launch happen here too, using the same call path as today's
`OnboardingWizard.handleSubmit` → `submit()` → `pollUntilRunning()`.

**Failure handling — fail on the given step, not overall.**

If something goes wrong on this card (launch fails, runtime never reports
running, etc.), do **not** bounce the user back to Card 3 or restart
onboarding. Show the error inline on Card 5 with:

- A specific, deterministic message from the backend.
- "Retry" — re-attempts the launch.
- "Back" — returns to Card 4a (cloud path) or Card 4b (local path) in
  **edit mode**, so the user can fix the credential or helper config that
  caused the failure without losing the path selection or any other
  previously-entered field. Then a single "Save and continue" returns
  them to Card 5 to retry the launch.

The general rule: each card owns the failure mode for its own step.
Cards never silently regress to an earlier step. The user can always
Back up themselves, but a failed launch on Card 5 is a Card 5 problem
until the user explicitly chooses to revisit Card 4.

## Nudge / Partial-Completion Behavior

Onboarding stays non-blocking, matching the shipped default-agents plan.

For the first cut, partial-completion comes from one path only: the user
took the "I'll set this up later" exit on Card 4b (local helper).
Card 4a configures all three agents in one shot — there is no per-agent
opt-out on first run.

If the user reaches the dashboard without completing the flow, show a
persistent dismissible banner:

> Finish setting up your agents — add an API key or connect a local model
> to start using your planning agent.

The banner deep-links back to the card the user left.

(If a later PR re-introduces per-agent opt-out — e.g. user wants to use
OpenAI for coding but Anthropic for planning — extend the nudge then.)

## Routing Rules

| State | Lands at |
| --- | --- |
| Not authenticated | `/login` |
| Authenticated, `onboarding.required = true`, no choice yet | `/onboarding` → Card 3 |
| Authenticated, cloud path chosen, no credential | `/onboarding` → Card 4a |
| Authenticated, local path chosen, helper offline | `/onboarding` → Card 4b |
| Authenticated, at least one default configured | `/dashboard/<agent-id>` (with nudge if partial) |

The frontend store should hold the current card and the chosen path so a
refresh mid-flow resumes on the same card rather than restarting from Card 3.

## Backend Scope

The default-agents backend already provides what we need for PR1–PR5.
This scope adds **only** what the new UX requires that the backend can't
already serve:

1. `/api/auth/state` already returns `onboarding.required` and
   `defaultAgents.*.configured` (camelCase, per the API-boundary
   convention in `CLAUDE.md`). No change needed.
2. `POST /api/default-agents/credentials` already accepts every field the
   onboarding flow needs (`workspaceId`, `provider`, `model`, `keyName`,
   `secret`, `agentIds`). The frontend supplies all of them — see the
   payload table on Card 4a. No backend change in PR1–PR5.
3. Local-model registration uses the existing local-runtime endpoints
   exercised by `LocalModelsSection`. No new endpoints.

PR6 (smart per-agent defaults) introduces the **only** backend change in
this scope: a server-side provider→default-model + provider→default
`tool_policy`/`workflow_template` mapping per agent type, so the
client-side default-model table on Card 4a can move server-side. Until
PR6 lands, the client-side table is the source of truth. The endpoint
contract stays the same; PR6 changes what the service does with `model`
when applying it to each agent in `agentIds`.

## Frontend Scope

1. Replace `OnboardingWizard` with a card-stepper component. New layout in
   `apps/web/src/components/OnboardingWizard/` (or rename to
   `OnboardingCards/`).
2. Add a small `onboarding` store slice with:
   - `currentCard: "choose-path" | "cloud-key" | "local-helper" | "launch"`
   - `path: "cloud" | "local" | null`
   - `selectedAgentIds: string[]`
   - actions for next/back, persisted to `localStorage`.
3. Card components, one per file:
   - `ChoosePathCard.tsx`
   - `CloudKeyCard.tsx`
   - `LocalHelperCard.tsx`
   - `LaunchAgentCard.tsx`
4. Reuse `Input`, `Select`, `Button`, `Card`, `Badge` from `components/ui/`.
5. Trim `Login.tsx` and `SignUp.tsx` to match the visual design of the new
   cards (typography, spacing, button styles). Behavior stays the same.
6. Dashboard nudge component for partial completions.

## Contracts

No new contracts. Reuse:

- `SetupAuthStateSchema` (already includes `defaultAgents` and
  `onboarding`).
- The credential-application request/response from
  `default-agents-onboarding-plan.md`.

If the local-helper path needs a typed status payload that doesn't already
exist, add it to `contracts/` rather than typing it locally in
`LocalModelsSection`.

## Testing Plan

Manual (required for any UI change per `CLAUDE.md`):

- New-user signup → Card 3 → cloud → key → launch. Land on dashboard with
  a running agent.
- New-user signup → Card 3 → local → start helper → launch. Land on
  dashboard with a running agent backed by Ollama (or compatible).
- Refresh mid-onboarding → resume on the same card.
- Skip from Card 4b → dashboard shows resume nudge.
- Uncheck planning on Card 4a → dashboard shows planning nudge.
- Back button on every card behaves and preserves field values.
- Dev-credentials button still works in dev mode.

Automated:

- Component tests for each card's submit/disable rules.
- Store tests for path/card transitions, persistence, and reset on sign-out.
- Existing API contract tests already cover the backend calls; no new
  backend tests required unless we add the optional `/api/onboarding/progress`
  endpoint.

## Proposed PR Sequence

Keep each PR small. The first three should be independently mergeable.

### PR1 — Card scaffold and routing

- New `OnboardingCards` component with placeholder cards.
- Onboarding store slice with card/path state and `localStorage`
  persistence.
- Routing rules from the table above.
- No behavior change to credential or local-helper calls yet — placeholder
  cards just advance through the stepper.

### PR2 — Card 3 (Choose Path) and Card 4a (Cloud API Key)

- Replace placeholder content for Card 3 with the two-option picker.
- Replace placeholder content for Card 4a with the provider + key form
  wired to `POST /api/default-agents/credentials`. Submit the full
  `DefaultAgentCredentialApplicationRequestSchema` payload (see the
  payload table on Card 4a) — including `model` and `keyName` looked up
  from a small client-side table keyed by `provider`, and
  `agentIds = [planning, coding, manager]` from `auth.defaultAgents` +
  `auth.managerAgent`.
- Read-only list of the three agents with role descriptions; no per-agent
  checkboxes in this PR.
- **Flip `resolvedAgentId` preference** to planning-first (full new
  order in Card 4a's `resolvedAgentId` change note). Add/update the
  default-agents service test that asserts the new order.
- Inline error handling that keeps the user on Card 4a on failure
  (including 400s from the schema rejecting the payload — surface the
  validator's message instead of a generic "something went wrong").
- Visual unit tests.

### PR3 — Card 4b (Local Helper) and Card 5 (Launch)

- Replace placeholder content for Card 4b with the helper checklist plus
  the explicit "Test connection" button (immediate inline feedback) and
  background polling once the test passes.
- Wire the local-model registration to all three default agents in one
  shot, mirroring Card 4a.
- Reuse existing local-runtime calls; do not duplicate.
- Card 5 wires the existing launch + poll-until-running path with the
  "fail on the given step" failure model: errors stay on Card 5 with
  Retry, and Back returns to Card 4a/4b in edit mode.
- Manual local end-to-end pass with Ollama.

### PR4 — Dashboard Nudges + Sign-Up/Login Polish

- Add the partial-completion nudge component to the dashboard.
- Add the "resume onboarding" banner.
- Tighten `Login.tsx` / `SignUp.tsx` styling to match the new cards.

### PR5 — Remove Legacy Wizard

- Delete the old kitchen-sink `OnboardingWizard` once the new flow is the
  default and validated locally + against a dev Supabase project.
- Remove now-dead fields from `useOnboardingStore` (tracker config,
  workflow template, max concurrency on this surface — those live in
  settings).

### PR6 — Smart Per-Agent Defaults

Standalone, not blocking PR1–PR5. Punts the "all three agents get the
same provider/model" simplification.

- Server-side: when `POST /api/default-agents/credentials` applies a
  credential to multiple default agents, choose **per-agent-type**
  defaults instead of using the single `model` from the request body for
  all of them.
  - Planning agent: model tuned for reasoning + planning (e.g. a higher
    "thinking" tier), `tool_policy` matching planning capabilities.
  - Coding agent: model tuned for code generation, default tool policy
    plus filesystem/shell.
  - Manager agent: model + tool policy for orchestration.
- Delete the client-side default-model + default-key-name tables added
  in PR2 once the server-side lookup is in place. PR2's payload now
  lets the server decide; the request body's `model` and `keyName`
  become an explicit user override rather than a forced default.
- No UI change on Card 4a — the user still submits one key and lands
  with three correctly-configured agents. The change is invisible to the
  onboarding flow but visible in agent settings after the fact.
- Validate by inspecting each default agent's `model_settings` and
  `gateway_config` after a fresh onboarding.

## Decisions

Decisions made during scoping. Captured here so the implementing PRs
don't relitigate them.

- **Provider default on Card 4a:** OpenAI. Always. No region detection,
  no "remember last choice" smarts.
- **Local-helper test connection:** explicit "Test connection" button
  with immediate inline feedback. Background polling runs once the test
  passes; the button is always there for on-demand re-checks.
- **Failure model:** fail on the given step, not overall. Errors stay on
  the card that produced them. Back to a previous card loads it in edit
  mode without losing other field state.
- **Default agents on Card 4a:** configure all three (planning, coding,
  manager) in one key submission. No per-agent checkboxes on first run.
- **Planning is the user's default agent.** The user interacts with the
  planning agent; the planning agent generates coding tasks for the
  coding agent. The coding agent works in the background and should
  rarely be messaged directly. The manager agent also runs in the
  background. This means PR2 flips the `resolvedAgentId` preference order
  in the shipped default-agents service to prefer planning over coding —
  see the `resolvedAgentId` change note on Card 4a for the new order.
- **Smart per-agent defaults:** deferred to PR6. PR2 wires the same
  provider/model to all three; PR6 swaps in type-specific model and
  tool-policy defaults server-side without touching the UI.
- **Cross-device onboarding state:** out of scope. `localStorage` is
  fine. Revisit in a future scope doc if telemetry shows real cross-device
  bouncing.
- **Email confirmation:** turned off on the Supabase project for now.
  No interstitial. If confirmation is later enabled, add a "check your
  inbox" card then.

## Open Questions

Remaining questions that aren't blocking but should be answered before the
PR they affect lands.

- **Dashboard nudge cadence (PR4).** Persistent vs. periodic resurface is
  deferred. PR4 ships the nudge as persistent + manually dismissible;
  revisit cadence in a later PR if it turns out users dismiss and forget.
- **Per-agent model overrides in settings (PR6 and beyond).** If a user
  wants OpenAI for coding and Anthropic for planning, what does the
  settings UI look like? Not an onboarding concern, but PR6's smart
  defaults should land in a way that doesn't make this harder later.

## References

- [shipped/default-agents-onboarding-plan.md](../shipped/default-agents-onboarding-plan.md)
  — backend default-agent bootstrap and credential application (already
  shipped; this scope is the UX layer on top).
- [reference/auth-jwt-design.md](../reference/auth-jwt-design.md) — auth
  model used by `/api/auth/state`.
- [reference/auth-user-vs-app-user.md](../reference/auth-user-vs-app-user.md)
  — identity model: Supabase auth user vs application user.
- [reference/product-vision.md](../reference/product-vision.md) — product
  principles to align onboarding copy against.
