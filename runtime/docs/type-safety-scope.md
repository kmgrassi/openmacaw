# Runtime Type-Safety Scope

This document scopes work to harden type safety at the wire boundary between `parallel-agent-runtime` (Elixir/OTP) and `parallel-agent-platform` (TypeScript). It complements `parallel-agent-platform/docs/typing-hardening-scope.md`, which covers the platform side.

The Elixir runtime cannot import the platform's TypeScript Zod schemas, but it does not need to: there are three viable mechanisms to get most of the way to compile-time-equivalent safety. This doc lays out the leak points, evaluates the three approaches, and recommends a phased path.

## Why This Matters

The runtime is the consumer of every JSON shape the platform emits — execution profiles, work items, gateway frames, local-relay registrations, persisted launcher state. Today, every one of those is decoded with `Jason.decode/1` and then accessed via `Map.get/2` and pattern matches that fall through silently when fields are missing.

The cost of that silence is real: a missing `runner_kind` doesn't fail at the boundary; it propagates `nil` until something deeper either crashes or — worse — defaults to a benign-looking but wrong value. We have already paid this cost during the routing-rule and provider-derivation work; further drift between the platform's evolving schemas and the runtime's pattern-match expectations is a near-certainty.

## Goals

- Validate every inbound JSON payload at the wire boundary against a known schema, and surface the failure with full field-level detail.
- Replace plain maps with structs+typespecs for the core domain concepts (ExecutionProfile, WorkItem, GatewayFrame, LocalRelayFrame), so dialyzer can prove that downstream code only sees valid shapes.
- Prevent silent normalization (e.g. `runner_kinds: "openai_compatible"` becoming `[]` because `normalize_string_list/1` returns `[]` on non-list input).
- Keep the platform contracts as the source of truth — the runtime mirrors them but does not re-invent them.

## Non-Goals

- Rewriting the orchestrator. This is purely additive: validation modules and struct definitions on top of existing logic.
- Replacing pattern-matching style. `defmodule` + `defstruct` + `case` remain the idiom; we just feed them validated data.
- Coupling the runtime to the platform's TypeScript at compile time. Whatever sharing mechanism we adopt should keep the runtime buildable in isolation (tests, CI, local dev should not require checking out the platform).

## Current Type-Safety Posture

| Aspect | State |
| --- | --- |
| Typespecs | Sparse and inconsistent. `WorkItem` has full `@type t` and `defstruct` (`apps/orchestrator/lib/symphony_elixir/work_item.ex:36-53`). `ExecutionProfile` is `@type t :: %{optional(String.t()) => term()}` — i.e. `any()`. |
| Structs vs maps | Mixed. `WorkItem` is a struct; `ExecutionProfile`, gateway frames, local-relay frames, and persisted launcher state are bare maps. |
| Dialyzer | Configured (`mix.exs:46-48`) but typespecs are sparse enough that it provides minimal enforcement today. |
| Ecto | A hard dep, but used only for DB ops via `Postgrex`. No `Ecto.Changeset` usage for wire validation. |
| JSON validation libs | None. No `ex_json_schema`, `nimble_options`, or equivalent. |
| Wire decoding | `Jason.decode/1` followed by pattern-matches on string-keyed maps and `Map.get/2` for optional fields. |

## Wire-Boundary Leak Points

The five places where untrusted JSON enters the system without schema validation:

### 1. Gateway frame decoder

`apps/orchestrator/lib/symphony_elixir_web/gateway/frame.ex:10-20`

```elixir
def decode(binary) when is_binary(binary) do
  case Jason.decode(binary) do
    {:ok, %{"type" => "ping"} = frame} ->
      {:ok, {:ping, Map.get(frame, "ts")}}

    {:ok, %{"type" => "req", "id" => id, "method" => method} = frame} ->
      {:ok, {:request, id, method, Map.get(frame, "params")}}

    _ ->
      :ignore
  end
end
```

Pattern requires `id` and `method` for `"req"` frames, which is good. Everything else (`params`, `ts`, payload shapes for non-req frame types) is unvalidated. A frame with `type: "req"` but `method: 42` will match the head and propagate the integer downstream.

### 2. Local-relay registration

`apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex:59-105`

`runner_kinds` and `runners` go through `normalize_string_list/1` and `normalize_runners/1` (lines 76-78, 110-112), both of which silently return `[]` on non-list input. A misformed registration ends up with empty kind/runner lists and gets accepted as a "successful" registration with no capabilities — the kind of failure that is hard to diagnose because nothing crashes.

### 3. OpenClaw WebSocket inbound frames

`apps/orchestrator/lib/symphony_elixir/runner/openclaw_ws.ex:449-451` decodes JSON and forwards it to `normalize_frame/1` (lines 226-254), which ends with `defp normalize_frame(_frame), do: :ignore`. Every malformed frame is silently dropped. There is no metric, no log, no surfaced error.

### 4. Launcher state restoration

`apps/orchestrator/lib/symphony_elixir/launcher/server.ex:505-527` reads a persisted JSON file and pattern-matches on `"orchestrators"` and `"next_port"`. `restart_saved_orchestrators/2` (line 529) then accesses `saved["id"]`, `saved["port"]`, `saved["config"]` without requiring them. A corrupt saved file with a missing `"port"` key produces `nil` ports rather than a clear refusal.

### 5. ExecutionProfile normalization

`apps/orchestrator/lib/symphony_elixir/execution_profile.ex:111-127` exposes `normalize_from_config/1`, which normalizes keys but does not validate the schema shape. Required-field validation happens later (lines 139-142), but only for a hardcoded short list. Unknown fields, type mismatches on existing fields, and constraint violations (e.g. an unknown `runner_kind`) are not caught at the boundary.

## Three Approaches to Schema Sharing

### A. JSON Schema + `ex_json_schema`

Emit JSON Schema from the platform's Zod definitions (`zod-to-json-schema` is already a one-liner there). Vendor the resulting JSON files in `apps/orchestrator/priv/schemas/`. Add `ex_json_schema` to `mix.exs`. Validate at the boundary:

```elixir
case ExJsonSchema.Validator.validate(@execution_profile_schema, payload) do
  :ok -> {:ok, payload}
  {:error, errors} -> {:error, {:schema_violation, errors}}
end
```

**Pros**: Single source of truth (the Zod schema), low upfront cost, declarative, schema files are diffable in PRs.
**Cons**: Runtime-only validation (no compile-time `@type` benefit), errors are verbose and need translation, payloads remain plain maps.

### B. Ecto.Changeset + embedded schemas

Hand-write `Ecto.Schema` modules for the wire types under `SymphonyElixir.Schema.*`:

```elixir
defmodule SymphonyElixir.Schema.ExecutionProfile do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false
  embedded_schema do
    field :agent_id, :string
    field :workspace_id, :string
    field :runner_kind, :string
    field :provider, :string
    field :model, :string
    # ...
  end

  @type t :: %__MODULE__{...}

  @runner_kinds ~w(codex claude_code openclaw computer_use manager planner local_relay local_model_coding)

  def validate(attrs) do
    %__MODULE__{}
    |> cast(attrs, __schema__(:fields))
    |> validate_required([:agent_id, :workspace_id, :runner_kind, :provider, :model])
    |> validate_inclusion(:runner_kind, @runner_kinds)
    |> validate_format(:agent_id, ~r/^[0-9a-f-]{36}$/i)
    |> apply_action(:validate)
  end
end
```

At the boundary: `Jason.decode/1` → `Schema.ExecutionProfile.validate/1` → typed struct or `{:error, %Ecto.Changeset{}}`.

**Pros**: Idiomatic Elixir, no new deps (Ecto is already in), full struct + `@type` so dialyzer can enforce shape downstream, rich validation primitives.
**Cons**: Schemas are hand-written and Elixir-specific — drift from the platform's Zod is possible. Mitigated by tests that pin platform fixtures against runtime schemas.

### C. Codegen Elixir from Zod

A Node script reads `parallel-agent-platform/contracts/*.ts` and emits `apps/orchestrator/lib/symphony_elixir/schema/*.ex` containing `defstruct`, `@type`, and a `validate/1` function. Generated files are committed and re-run on every contract change.

**Pros**: Generated code is guaranteed to match the platform schema. Single source of truth across two languages. Compile-time type safety in Elixir.
**Cons**: ~2-3 days to build the codegen tool. Requires the runtime CI to either invoke the platform repo or check in generated files (the latter is fine but creates a coordination tax). Generated Elixir is harder to review than hand-written.

### Comparison

| Property | A: JSON Schema | B: Ecto.Changeset | C: Codegen |
| --- | --- | --- | --- |
| Source of truth | Zod (via emitted JSON Schema) | Hand-written Elixir | Zod |
| Compile-time type safety | ❌ | ✅ | ✅ |
| Drift risk | Low (schemas are diffable) | Medium (hand-maintained) | None (generated) |
| Upfront cost | Days | Days | ~Week |
| Idiomatic Elixir | Medium | High | Medium |
| New dependencies | `ex_json_schema` | None | None (codegen lives in platform) |

## Recommendation: B now, C later, A as defense-in-depth

**Phase 1 — Ecto.Changeset for the five leak points (1-2 weeks)**

This is the highest-leverage move because:

1. Ecto is already a hard dependency. No new deps, no library evaluation.
2. The team is already fluent in Ecto from the DB layer. No learning curve.
3. Each leak point becomes a one-module PR. Reviewable, revertable, deployable independently.
4. Dialyzer immediately benefits. `@type t :: %__MODULE__{...}` lets it prove that downstream functions never see a nil-field profile.
5. The validation logic that already exists scattered across `normalize_*` helpers consolidates into one `validate/1` per type, where it belongs.

**Phase 2 — Re-evaluate codegen after Phase 1 lands (parallel investigation)**

Prototype the Zod→Elixir codegen against `ExecutionProfile` only. Compare the generated module to the hand-written Phase 1 version. Decide:

- If the generated code is comparable in quality and reviewability, roll codegen out to the rest of the schemas in a single PR and delete the hand-written ones.
- If the generated code is awkward (Zod has constructs Ecto doesn't translate cleanly — refinements, transforms, branded types), keep the hand-written Phase 1 schemas and add a contract test that fixtures from the platform parse cleanly through them.

The Phase 1 work is not wasted in either branch — Ecto schemas are the validation boundary regardless of how the schema definition is sourced.

**Phase 3 — JSON Schema as defense-in-depth (optional, after platform emits it)**

Once the platform stabilizes its Zod definitions and starts emitting JSON Schema (as called out in PR 9 of the platform scoping doc), add an *additional* `ex_json_schema` validation pass in front of the Ecto.Changeset. This catches malformed payloads before they reach Ecto's coercion logic and gives operators a way to verify wire compatibility at deploy time without booting the orchestrator.

This is purely defense-in-depth. Phase 2's codegen, if adopted, makes Phase 3 less interesting; if codegen is skipped, Phase 3 becomes the "schemas are still a source of truth" story.

## PR-Sized Roadmap

| # | PR | Scope | Files / Areas | Acceptance Criteria | Priority |
| --- | --- | --- | --- | --- | --- |
| 1 | Add `SymphonyElixir.Schema` namespace and dispatcher | `apps/orchestrator/lib/symphony_elixir/schema.ex` (new), `apps/orchestrator/lib/symphony_elixir/schema/README.md` | `Schema.validate/2` exists with one supported type. Tests cover happy path and one error case. | High |
| 2 | `Schema.ExecutionProfile` + cut over `ExecutionProfile.normalize_from_config/1` | `apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex`, `apps/orchestrator/lib/symphony_elixir/execution_profile.ex` | All call sites of `normalize_from_config` go through `Schema.ExecutionProfile.validate/1`. Existing tests pass. New tests cover: missing required fields, unknown `runner_kind`, malformed `agent_id`. | High |
| 3 | `Schema.LocalRelayRegister` at the local-relay socket | `apps/orchestrator/lib/symphony_elixir/schema/local_relay_register.ex`, `apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex` | Registration with non-list `runner_kinds` is rejected with a clear error, not silently coerced to `[]`. | High |
| 4 | `Schema.GatewayFrame` discriminated decode | `apps/orchestrator/lib/symphony_elixir/schema/gateway_frame.ex`, `apps/orchestrator/lib/symphony_elixir_web/gateway/frame.ex` | `Frame.decode/1` returns `{:ok, %Schema.GatewayFrame.Request{...}}` etc. instead of tuples of bare values. The catch-all `:ignore` is replaced with `{:error, reason}` and the caller logs/metrics it. | High |
| 5 | `Schema.OpenClawFrame` for inbound runner frames | `apps/orchestrator/lib/symphony_elixir/schema/openclaw_frame.ex`, `apps/orchestrator/lib/symphony_elixir/runner/openclaw_ws.ex` | The silent `defp normalize_frame(_frame), do: :ignore` becomes a logged + metricked error path. Known event types are validated and become typed structs. | Medium |
| 6 | `Schema.LauncherState` for persisted state | `apps/orchestrator/lib/symphony_elixir/schema/launcher_state.ex`, `apps/orchestrator/lib/symphony_elixir/launcher/server.ex` | Corrupt or partial state files refuse to load with a logged error rather than producing `nil`-port orchestrators. | Medium |
| 7 | Enforce dialyzer in CI | `.github/workflows/*`, `mix.exs` | `mix dialyzer --halt-exit-status` runs in CI. PLT is cached. Existing warnings either fixed or explicitly suppressed with documented rationale. | Medium |
| 8 | Cross-repo contract tests | `test/symphony_elixir/contract_test.exs`, `parallel-agent-platform/scripts/emit-fixtures.ts` (new) | Platform emits canonical fixture JSON for each wire type to a known directory; runtime test reads them and asserts they parse cleanly through `Schema.*`. CI on either side breaks if fixtures drift from runtime schemas. | Medium |
| 9 | (Optional) Codegen Elixir schemas from Zod | `parallel-agent-platform/scripts/codegen-elixir.mjs`, regenerate `apps/orchestrator/lib/symphony_elixir/schema/*.ex` | Codegen produces Elixir modules that pass the test suite and are reviewed once before adoption. Decision recorded in a follow-up doc. | Low |
| 10 | (Optional) `ex_json_schema` defense-in-depth | `mix.exs`, `apps/orchestrator/priv/schemas/`, validation pipeline | Inbound payloads are first validated against vendored JSON Schema, then through Ecto changesets. Failures at either layer are logged with payload-shape context. | Low |

### Suggested order

PRs 1–4 in sequence, since they share the `Schema` module structure and each PR proves out the pattern at one more boundary. PRs 5–7 are independent and can ship in parallel. PR 8 is the contract-test backbone; ideally it lands alongside PR 2 so each subsequent schema can ship with cross-repo coverage. PRs 9 and 10 are post-stabilization decisions.

## What "Done" Looks Like

- `rg "Jason.decode" apps/orchestrator/lib/symphony_elixir{,_web}/` returns only call sites that immediately hand the decoded payload to a `Schema.*.validate/1`. No bare `Jason.decode` followed by `Map.get`.
- Every wire-boundary module exports a typed struct for the messages it accepts, and dialyzer enforces that downstream functions take the struct, not a generic `map()`.
- A malformed `runner_kinds` value at the local-relay boundary produces a `{:error, %Ecto.Changeset{}}` with field-level detail, surfaced to the registering client and logged at the orchestrator. It is no longer possible to silently register with an empty kind list.
- `mix dialyzer` is a required CI check.
- A contract test fails CI if a platform fixture stops parsing through the runtime's schema — drift is caught before deploy, not after.

## Coordination With the Platform

This scope assumes the platform side is moving in parallel:

- The platform's PR 9 (`docs/typing-hardening-scope.md`) emits JSON Schema from Zod. That feeds into Phase 3 (PR 10 here) and is a prerequisite for it. Until then, the runtime's Ecto schemas are hand-maintained against the platform's Zod definitions.
- The platform's PR 5 (promote WS payloads to discriminated unions) is the mirror image of PR 4 here. They should ideally land in the same week so both sides agree on the per-event payload shape.
- Cross-repo contract tests (PR 8 here) require the platform to publish fixture JSON. That's a small platform-side script; it should be added as a follow-up to platform PR 5.

Nothing here blocks the platform team. The runtime can begin Phase 1 today against the current Zod definitions; if the platform changes them, only the corresponding `Schema.*` module needs an update.
