# Typing Hardening Scope

This document scopes work to move correctness checks from runtime to compile time across `parallel-agent-platform` and (where relevant) the `parallel-agent-platform` ↔ `parallel-agent-runtime` wire boundary.

The repo's `apps/api/CLAUDE.md` already says "Strict mode is on. Do not use `any`. Use `unknown` and narrow with type guards." The codebase mostly honors that — there are very few `any` annotations left. The remaining risk is concentrated in three places where type information is **shed** rather than **declared as `any`**:

1. `Json` database columns that are never narrowed back into a typed shape.
2. `as` / `as unknown as` casts that paper over Supabase or wire-format mismatches.
3. Wire-format payloads that use `unknown` at the discriminated-union boundary and never get validated downstream.

The result is a codebase that _typechecks_ but doesn't actually _type-prove_ the fields it reads.

## Goals

- Eliminate `as unknown as` chains. Every cast should either be removed (by improving generated types) or replaced with a Zod parse.
- Validate every `Json` column at the data-access layer. `model_settings`, `tool_policy`, `config_json`, and `gateway_config_state` should round-trip through Zod schemas — never reach business logic as `Json`.
- Promote wire-format payload `unknown` fields to discriminated unions, so a misnamed event or response field fails at compile time rather than silently producing `undefined` at runtime.
- Unify enum sources where two schemas drift apart in subtle ways (`CredentialProviderSchema` vs `ExecutionProviderSchema` is the canonical example).
- Replace string-keyed Supabase `.select(COLUMN_SELECT)` patterns with typed projections, so renaming a column fails the build instead of silently returning `undefined`.

This is not a rewrite. The repo has solid foundations (strict TS, Zod contracts in `contracts/`, generated Supabase types in `supabase/generated/database.types.ts`). The work is plugging the leaks at boundaries.

## Non-Goals

- Rewriting the Elixir runtime (`parallel-agent-runtime`) in TypeScript. The runtime is Elixir/OTP and stays that way. Wire-format hardening lives on the platform side; the runtime can adopt JSON-schema or ExJsonSchema validation as a parallel follow-up.
- Adopting a new validation library. Zod is already in use; we extend it.
- Changing the public REST contracts the runtime calls. We tighten what the platform accepts and emits, but the wire shapes themselves do not change.
- Migrating the API from the custom PostgREST wrapper to the typed Supabase client — that was tracked separately in `docs/shipped/api-typed-supabase-client-pr-plan.md`. This doc complements it by adding result-validation boundaries on top.

## Current State by Category

### 1. `Json` columns leak unvalidated shapes into business logic

`Tables<"agent">["model_settings"]` and `["tool_policy"]` are typed as `Json` (a permissive `string | number | boolean | null | object | Json[]` union). The repository layer surfaces them as `Json` and the casts to `StoredAgentRow` / `SetupAgentRow` do not change that.

| File                                  | Lines                 | Issue                                                                                                                                                                           |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/repositories/agents.ts` | 4-25                  | `StoredAgentRow` and `SetupAgentRow` are `Pick<>` over `Tables<"agent">`, so `model_settings` and `tool_policy` arrive as `Json`.                                               |
| `apps/api/src/repositories/agents.ts` | 43, 64, 75, 103       | Each query ends with `as StoredAgentRow[]` / `as SetupAgentRow` casts whose only function is to silence the compiler. The cast does not narrow `Json`.                          |
| `apps/api/src/repositories/agents.ts` | 78-103                | `createSetupAgent({ modelSettings: Json, toolPolicy: Json })` accepts unvalidated input from callers. There is no schema for what a valid `model_settings` document looks like. |
| `contracts/agent-helpers.ts`          | `extractPrimaryModel` | Reads `model_settings.primary` defensively — that defense exists _because_ the shape is unvalidated upstream.                                                                   |

The same pattern applies to `gateway_config.config_json`, `gateway_config_state` rows, and any other `jsonb` column. There is no `ModelSettingsSchema`, `ToolPolicySchema`, or `GatewayConfigSchema` in `contracts/`.

### 2. `as unknown as` chains on Supabase calls

The original `apps/api/src/routes/local-runtime.ts` casts have already been removed, but the same problem still exists one layer down in the local-runtime service and metadata loaders. Those files read narrow Supabase projections and recover type information with ad hoc casts instead of validating the selected shape:

```ts
const ruleMatches = (matches ?? []) as RoutingRuleMatchRow[];
const machinesById = new Map(
  ((machines ?? []) as LocalRuntimeMachineRow[]).map((machine) => [
    machine.id,
    machine,
  ]),
);
const ruleIds = Array.from(
  new Set(
    ((machineMatches ?? []) as Array<{ rule_id: string }>).map(
      (row) => row.rule_id,
    ),
  ),
);
```

The `as never` insert payload (line 101, 117) and the post-query `as unknown as { id, display_name }` recovery cast (lines 90, 106) tell the same story: the call works at runtime because the Supabase client is dynamic, but it is invisible to the compiler. A column rename or table rename will not be caught.

Root cause: the route cleanup stopped at the HTTP boundary. The service layer still trusted projection shapes after the query returned. The fix is to validate those projections with Zod row schemas and shared Supabase row parsers so malformed DB payloads fail loudly instead of flowing through `as` casts.

### 3. WS frame payloads are `unknown` at the discriminator boundary

`apps/web/src/api/ws-types.ts` is well-structured — it already uses a discriminated union `GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame | GatewayHelloOk` (lines 92-128). The discriminator (`type`) is correctly narrowed.

But the payloads themselves are typed as `unknown`:

```ts
export type GatewayRequestFrame  = { type: "req";  id: string; method: string; params?: unknown; };
export type GatewayResponseFrame = { type: "res";  id: string; ok: boolean;    payload?: unknown; error?: GatewayError; };
export type GatewayEventFrame    = { type: "event"; event: string;             payload?: unknown; seq?: number; };
export type GatewayHelloOk       = { type: "hello-ok"; protocol: number; ...   snapshot?: unknown; ... };
```

Once a frame is narrowed to (say) `GatewayEventFrame` with `event === "agent.message.created"`, the consumer has no compile-time knowledge of `payload`. The fix is to make `event` and `method` themselves discriminators:

```ts
type AgentMessageCreatedEvent = { type: "event"; event: "agent.message.created"; payload: AgentMessage; seq?: number; };
type SessionStartedEvent      = { type: "event"; event: "session.started";       payload: SessionStartedPayload; seq?: number; };
type GatewayEventFrame = AgentMessageCreatedEvent | SessionStartedEvent | ...;
```

This change is contagious — every consumer of `payload` would need a Zod parse today, but a typed switch on `event` after the change. `apps/web/src/hooks/useChat.ts` `normalizeMessages()` is the first beneficiary: today it manually narrows `Record<string, unknown>` with fallback fields (`createdAt` vs `created_at`, `content` vs `message`), which exists _because_ nothing upstream told it the shape.

### 4. Provider/credential/runner-kind enum drift

Three nominally-related enums live in three places with three different value sets:

| Schema                         | File                                   | Values                                                                                                     |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CredentialProviderSchema`     | `contracts/credentials.ts:6-17`        | `openai`, `anthropic`, `xai`, `google`, `mistral`, `groq`, `openrouter`, `together`, `perplexity`, `azure` |
| `KnownExecutionProviderSchema` | `contracts/execution-profile.ts:18-24` | `openai`, `anthropic`, `openai_compatible`, `openai_codex`, `openclaw`                                     |
| `RUNNER_KINDS`                 | `contracts/runner-kinds.ts`            | `codex`, `openclaw`, `local_runtime`, `computer_use`, etc.                                                 |

Only `openai` and `anthropic` overlap between credential and execution provider sets. `ExecutionProviderSchema` (line 26-30 of `execution-profile.ts`) further widens itself with `z.union([KnownExecutionProviderSchema, z.string().min(1)])`, accepting _any_ non-empty string. There is no compile-time guarantee that an execution profile's `provider` corresponds to a credential the workspace actually has.

This is intentional in part — credential providers and execution providers serve different purposes (one is "what API key do I have", the other is "what runner do I dispatch to"). But the **mapping between them is implicit**. `deriveProviderFromModel()` in `contracts/agent-helpers.ts` papers over this with a `model.split("/")` heuristic.

### 5. Non-null assertions and ad-hoc narrowing

Roughly 200 `!` non-null assertions across the API code, concentrated in `apps/api/src/routes/stored-agents.ts`, `apps/api/src/services/setup.ts`, and a few web settings components. Each is an unverified runtime invariant. Most are likely safe; a handful guard against `undefined` from index access on arrays and objects — exactly the case `noUncheckedIndexedAccess` would flag at compile time.

`tsconfig` posture is inconsistent:

| Project                | `strict` | `noUncheckedIndexedAccess` |
| ---------------------- | -------- | -------------------------- |
| `apps/web`             | ✅       | ✅                         |
| `apps/api`             | ✅       | ❌                         |
| `packages/plan-schema` | ✅       | ❌                         |

The web app catches `obj[key]` index risks; the API does not.

## Cross-Repo Wire Boundary

`parallel-agent-runtime` is Elixir, so there is no shared TypeScript package between the two repos. The contract is whatever JSON the platform agrees to send and the orchestrator agrees to parse. Today:

- The platform's outgoing wire shapes are defined in `contracts/` (well) and `apps/web/src/api/ws-types.ts` (mostly well, with `unknown` payloads as called out above).
- The platform's incoming validation of runtime responses is mostly absent. Once a frame is parsed as `GatewayResponseFrame`, `payload` is `unknown`, and consumers either parse it with Zod ad hoc or cast it.
- The Elixir runtime has no machine-readable mirror of the platform's Zod schemas. If the platform's `ExecutionProfileSchema` adds a field, nothing fails to compile in the orchestrator — it just silently ignores it (or crashes at runtime if required).

The path to compile-time-ish safety across this boundary is **schema-as-data**: emit JSON Schema from the Zod definitions, ship it into both repos, and have the runtime validate inbound payloads at the gateway adapter. This is out of scope for the platform-only PRs below but is called out as a follow-up.

## PR-Sized Roadmap

Each PR is small enough to review independently and can ship without blocking the next.

| #   | PR                                                           | Scope                                                                                                                                     | Files / Areas                                                                                                                                                                                                                                                                                                                              | Acceptance Criteria                                | Priority |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------- |
| 1   | Add `noUncheckedIndexedAccess` to API and packages           | `apps/api/tsconfig.json`, `packages/plan-schema/tsconfig.json`                                                                            | Enable the flag and fix every resulting error. Most should be one-line `?? throw` or guard additions. No `as` casts to silence the flag.                                                                                                                                                                                                   | Build passes with the flag on. Diff is mechanical. | High     |
| 2   | Define `ModelSettingsSchema` and `ToolPolicySchema`          | `contracts/agents.ts` (extend), `apps/api/src/repositories/agents.ts`, `contracts/agent-helpers.ts`                                       | New Zod schemas exported from `contracts/agents.ts`. Repository writes Zod-parse on read, Zod-parse on write. `extractPrimaryModel` returns a typed shape, not `unknown`. `Json` no longer appears in the public repository signatures.                                                                                                    | High                                               |
| 3   | Validate local runtime Supabase projections                  | `apps/api/src/services/local-runtime-machines.ts`, `apps/api/src/services/local-runtime/routing-metadata.ts`                              | Local-runtime listing, detail lookup, and deletion paths parse every narrow Supabase projection with shared row schemas. The service layer compiles with no `as unknown as { ... }` or array-cast recovery for routing-rule matches, machine rows, or agent rows.                                                                          | High                                               |
| 4   | Validate Supabase result rows at the repository layer        | `apps/api/src/repositories/*.ts`, new `apps/api/src/repositories/parsers.ts`                                                              | Every `repositories/*.ts` function ends with a Zod parse against a row schema derived from contracts. Result types are `z.infer<...>`, not `Pick<Tables<...>, ...>`. Bad rows surface as `assertSupabaseSuccess`-style errors with full context.                                                                                           | High                                               |
| 5   | Promote WS event payloads to discriminated unions            | `apps/web/src/api/ws-types.ts`, `contracts/` (new `messages.ts` if needed), `apps/web/src/hooks/useChat.ts`, `apps/web/src/api/broker.ts` | `GatewayEventFrame` and `GatewayResponseFrame` are unions over `event` / `method`. `payload: unknown` is gone for all known events. `useChat.normalizeMessages` switches on a typed shape and drops the `createdAt` / `created_at` fallback.                                                                                               | Medium                                             |
| 6   | Unify provider sources                                       | `contracts/providers.ts` (new), `contracts/credentials.ts`, `contracts/execution-profile.ts`                                              | One canonical `ProviderSchema` lives in `contracts/providers.ts`. `CredentialProviderSchema` and `KnownExecutionProviderSchema` derive from it (subset/superset relations explicit). The implicit "any string is a valid execution provider" widening in `execution-profile.ts:26-30` is removed or narrowed to a documented escape hatch. | Medium                                             |
| 7   | Replace string-keyed Supabase selects with typed projections | `apps/api/src/repositories/*.ts`, optionally `apps/api/src/lib/select.ts`                                                                 | `STORED_AGENT_SELECT` and friends become `as const` tuples or generated from the row schema. A column rename in `database.types.ts` produces a type error in the select.                                                                                                                                                                   | Medium                                             |
| 8   | Narrow non-null assertions where invariants are real         | `apps/api/src/routes/stored-agents.ts`, `apps/api/src/services/setup.ts`, `apps/web/src/components/settings/AgentModelPolicy.tsx`         | Targeted PR. For each `!`, either prove the invariant via narrowing/destructuring or replace with an explicit error. No silent `!`.                                                                                                                                                                                                        | Low                                                |
| 9   | (Cross-repo) Emit JSON Schema from Zod contracts             | `contracts/`, `scripts/emit-schemas.ts`, `parallel-agent-runtime` follow-up                                                               | `pnpm run schemas:emit` writes JSON Schema for `ExecutionProfileSchema`, `WorkItem`, agent message envelopes. A follow-up PR in the runtime adopts ExJsonSchema validation at the gateway adapter.                                                                                                                                         | Low (and gated on runtime side accepting it)       |

### Suggested order

PR 1 and PR 3 are mechanical and unblock everything else. PR 2 and PR 4 together remove the `Json`-leak class entirely. PR 5 is the most contagious — it reaches into `useChat`, `broker.ts`, `GatewayContext` — but it pays the largest dividend. PR 6, 7, 8 are independent cleanups. PR 9 is a separate conversation with the runtime team.

## What "Done" Looks Like

When this scope is shipped, the codebase has the following invariants:

- `rg "as unknown as"` returns nothing in `apps/` or `contracts/` (test fixtures excepted).
- `rg ": Json\b"` returns nothing in repository or service signatures — `Json` is contained to the Supabase generated types.
- `rg "payload\?: unknown"` returns nothing in `ws-types.ts`.
- A column rename in `supabase/generated/database.types.ts` produces a compile error in the corresponding `repositories/*.ts` file.
- A new value added to the runtime's runner kind list without updating `RUNNER_KINDS` produces a Zod parse error at the API boundary, surfaced via `assertSupabaseSuccess`-style logging — not a silent fall-through.
- `noUncheckedIndexedAccess` is on for every project.

None of these are exotic. They are the natural outcome of treating "the type system is the test for shape" as the default, and using runtime validation only at the system edges (HTTP request bodies, Supabase responses, WS frames) where the type system genuinely cannot reach.

## Appendix: File Inventory for Reviewers

Files that will be touched by at least one PR in this scope:

- `apps/api/tsconfig.json`
- `apps/api/src/repositories/agents.ts`
- `apps/api/src/repositories/credentials.ts` (and other repository files)
- `apps/api/src/services/local-runtime-machines.ts`
- `apps/api/src/services/local-runtime/routing-metadata.ts`
- `apps/api/src/services/setup.ts`
- `apps/web/src/api/ws-types.ts`
- `apps/web/src/api/broker.ts`
- `apps/web/src/hooks/useChat.ts`
- `apps/web/src/context/GatewayContext.tsx`
- `contracts/agents.ts`
- `contracts/agent-helpers.ts`
- `contracts/credentials.ts`
- `contracts/execution-profile.ts`
- `contracts/providers.ts` (new)
- `contracts/messages.ts` (new, optional)
- `packages/plan-schema/tsconfig.json`

Files explicitly out of scope:

- Anything in `parallel-agent-runtime` (Elixir).
- Migrations in `supabase/migrations/` — schema changes are tracked via `harper-server`.
- `docs/shipped/api-typed-supabase-client-pr-plan.md` — shipped, separate but complementary effort.
