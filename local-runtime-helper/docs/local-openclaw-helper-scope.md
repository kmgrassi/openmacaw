# Local OpenClaw via helper — scope

> Branch: `local-openclaw-scope` across `parallel-agent-platform`,
> `parallel-agent-runtime`, `local-runtime-helper`.

## Problem

A user with a local OpenClaw install today *cannot* register it through the
dashboard. The plumbing exists end-to-end — the `local-runtime-helper` Go
daemon already has an `openclaw` runner adapter
(`local-runtime-helper/internal/runner/openclaw/openclaw.go`), the cloud relay
already accepts `runner_kind: "openclaw"` in `RegisterFrame.runner_kinds`
(`parallel-agent-runtime/apps/orchestrator/lib/.../local_relay_socket.ex`),
and the `local_relay` runner kind is defined in
`contracts/runner-kinds.ts:155`.

The gap is the *user-facing* surface:

1. **`LocalModelsSection` is model-only.** `LocalModelRegistrationCard.tsx`
   asks for endpoint URL (defaulting to `http://localhost:11434/v1`), model
   name, provider, repo path, and tool-call support. There is no path for
   "I have an OpenClaw HTTP server on `:7100`."
2. **The install-command generator only emits a `[runner.openai_compatible]`
   stanza.** It cannot produce a `[runner.openclaw]` stanza.
3. **The routing-rule editor surfaces `local_relay` but not a target runner
   selector.** Users must hand-edit rules to send work to a local OpenClaw.

This is the
[OQ-02](../open-questions/oq-02-local-runtime-connector.md) generalization
the design doc anticipated — "OpenClaw running on a local box is one runner
kind sitting behind a generic relay transport."

## Goal

A user can:

1. Open settings → Local runtimes.
2. Pick **OpenClaw** as the runtime kind (vs. local model).
3. Enter endpoint URL + optional API key.
4. Receive a copy-pastable install + start command that writes the right
   TOML.
5. See the helper come online with `runner_kind: openclaw` advertised.
6. Bind an agent to the local OpenClaw via the routing-rule editor (no
   hand-edited DB rows).

Renaming `LocalModelsSection` → "Local Runtimes" is part of the cleanup
(see "Refactor Over Quick Fixes" — we don't want a parallel section).

## Out of scope

- Other local tools mentioned in the product vision (Figma, DaVinci,
  browser-control). The relay protocol already supports them via the same
  pattern; this scope just adds OpenClaw as the second concrete runner kind.

## DB: no migration required

After investigating `harper-server`:

- There is **no `local_models` table**. The "Local Models" wizard writes to
  `local_runtime_machine`, whose `runner_kinds text[]` column is unconstrained
  at the element level and already documented as accepting `{openclaw}`:
  > "Runner kinds advertised by the daemon at WS register time (e.g.
  > `{openai_compatible, openclaw}`)." —
  > `supabase/migrations/20260425140000_oq02_local_runtime_tables.sql:43-44`
- `routing_rule.runner_kind` check constraint **already permits**
  `openclaw`, `openclaw_ws`, `openclaw_http_sse`, and `local_relay`. See
  `supabase/migrations/20260513150000_expand_routing_rule_provider_check.sql:60-72`.
- `routing_rule_default_runner_family`, `_execution_location`, and
  `_transport` already classify `openclaw*` runner kinds (`custom_runtime` /
  `external` / `websocket` or `http_sse`).

Conclusion: the entire DB story is in place. **No new migration is needed
in this scope.** The bottleneck is the platform's UI and API surface, which
treats `local_runtime_machine` rows as if they were model-only.

## PR plan

Each PR independently mergeable; later PRs depend on earlier ones.

### PR 1 — `parallel-agent-platform`: contracts + API

- `contracts/local-runtime.ts`: split `LocalModelRegistrationRequest` →
  `LocalRuntimeRegistrationRequest` discriminated by `runnerKind`. Each
  variant carries only the fields it needs.
- `apps/api/src/routes/local-runtime.ts`: accept the new shape; route handler
  picks the right runner-kind-specific config to persist.
- `apps/api/src/services/install-command.ts` (or wherever the helper TOML
  is generated): emit `[runner.openclaw]` when registering an OpenClaw
  runtime; existing `[runner.openai_compatible]` path stays for models.

### PR 2 — `parallel-agent-platform`: web UI

- Rename `LocalModelsSection` → `LocalRuntimesSection`.
- Add runtime-kind toggle (model | openclaw) at the top of the registration
  card.
- Conditionally render fields:
  - Model: endpoint, model name, provider, tool-call support.
  - OpenClaw: endpoint, optional API key.
- Update wizard state machine + status card labels.

### PR 3 — `parallel-agent-platform`: routing-rule editor

- In the routing-rule editor, when `runner_kind: local_relay` is selected,
  surface a "target runner" dropdown listing online helpers and the runner
  kinds they advertise (from the helper's `RegisterFrame`).
- Persist to the rule's `runner_config` blob.

### PR 4 — `parallel-agent-runtime`: relay registration + presence

- Confirm `local_relay_socket.ex` already accepts `openclaw` in
  `RegisterFrame.runner_kinds` (it does — verify with test).
- Add an integration test covering: register helper with
  `runner_kinds: ["openclaw"]`, dispatch a request via `Runner.LocalRelay`,
  expect it to land on that helper.

### PR 5 — `local-runtime-helper`: wire OpenClaw into `cmdStart` + docs

**Code (small but real, not docs-only):**

- `cmd/local-runtime-helper/main.go`: import
  `internal/runner/openclaw` and add a block in `cmdStart` parallel to
  the existing `cfg.Runners.OpenAICompatible` block:
  - If `cfg.Runners.OpenClaw != nil`, call `openclaw.New(...)` with the
    config's endpoint + API key.
  - Append the new runner to `runners` and append `"openclaw"` to
    `activeRunnerKinds`.
  - Log the registration.
- This satisfies the helper's "Advertise only initialized runners" rule
  (see `local-runtime-helper/CLAUDE.md`): config parsing already accepts
  `[runner.openclaw]` and validates it
  (`internal/config/config.go:55,66,208-210`), but today `cmdStart` only
  builds the `openai_compatible` runner. A helper started against an
  OpenClaw-only TOML exits with "no runners configured"; a mixed TOML
  starts but never advertises `openclaw`. PR 5 closes that gap so the
  platform's PR 1 `[runner.openclaw]` TOML output actually has an
  effect.

**Docs:**

- `dev-runtime.toml.example` (or equivalent) gains a `[runner.openclaw]`
  example stanza next to the existing `[runner.openai_compatible]`.
- README "Quickstart" section updated to show both registration paths.

**Tests:**

- New table-driven test covering: a TOML with only `[runner.openclaw]`
  starts and advertises `runner_kinds: ["openclaw"]`; a mixed TOML
  advertises both.

## Validation per repo

- **Platform:** `pnpm -C apps/api run validate` and
  `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`. Browser test the
  wizard end-to-end with a local OpenClaw on `:7100` (or a mock).
- **Runtime:** `mix test` + the new relay integration test.
- **Helper:** `go build ./... && go vet ./... && go test ./...`.

## Open questions

- **Naming:** "Local runtimes" vs "Local helpers" vs "Local tools." The
  helper is the *vehicle*; the runtime kinds are what users care about.
  Leaning toward **"Local runtimes"** to match the helper's binary name and
  the existing `local-runtime-helper` repo.
- **Tool-call support for OpenClaw:** OpenClaw manages its own tool loop
  internally, so the cloud `tool_call_request` machinery doesn't apply. We
  should mark `capabilities.tool_calls: "never"` on registration and skip
  the tool-call UI for OpenClaw runtimes.
- **Multiple OpenClaw endpoints per machine:** The current
  `LocalExecutionTarget` schema assumes one helper = one set of capabilities.
  If a user runs two OpenClaw instances on different ports, can they
  register both? Probably yes via two `[runner.openclaw.<name>]` stanzas in
  TOML — confirm with helper config parser.
