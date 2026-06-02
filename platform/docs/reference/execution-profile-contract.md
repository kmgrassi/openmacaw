# Execution Profile Contract

`ExecutionProfile` is a computed contract for deciding how an agent run should
execute. It is not a persisted configuration table.

Agent role and execution backend are intentionally separate:

- `role` describes what the agent is responsible for, such as planning, coding,
  manager, or custom behavior.
- `runnerKind` describes the runtime execution path, such as `planner`,
  `codex`, `llm_tool_runner`, `openclaw_ws`, `openclaw_http_sse`,
  `local_model_coding`, or `computer_use`. See
  [`contracts/runner-kinds.ts`](../../contracts/runner-kinds.ts) for the full
  capability table per kind.
- `provider` describes the model provider or backend, such as OpenAI,
  Anthropic, OpenAI-compatible, OpenAI Codex, or OpenClaw.
- `model` is the concrete model identifier selected by routing.
- `credentialRef` references a credential ID or alias. It never carries secret
  material.
- `toolProfile` and `capabilities` describe the tools and runtime behavior the
  selected execution path can support.

The resolver should source `provider` from routing or agent configuration when
available. Deriving provider from a model ID is only a compatibility fallback
for legacy model strings such as `openai/gpt-5.2`; it is not the source of truth
for new routing decisions.

Keeping these fields distinct lets a Planning Agent run on the `planner` kind
while a Coding Agent runs on `codex`, `local_model_coding`, or another future
backend without changing the agent role contract.

## Default `runner_kind` by `AgentType`

The mapping from `AgentType` to default `RunnerKind` is **one constant** in
[`contracts/agent-runner-defaults.ts`](../../contracts/agent-runner-defaults.ts):

| `AgentType` | Default `RunnerKind` | `workspaceWrite` policy |
|---|---|---|
| `planning` | `planner` | `never` — plans + delegates, no filesystem writes |
| `coding` | `codex` | `always` — edits files in the workspace |
| `manager` | `llm_tool_runner` | `role_coding` — orchestrates, may dispatch |
| `custom` | `openclaw_ws` | `always` — external websocket runner |

This is the **default**; an individual agent's `routing_rule.runner_kind` may
override it. A few runtime overrides also exist on top of the default:

- `(coding, provider=local)` → `local_model_coding` instead of `codex`. This is
  a genuine different runner family (`workspace_coding` runner at
  `executionLocation=local` via `local_relay` transport, vs. the cloud-hosted
  `codex` over `launcher`). See `runnerKindForRuntimeProfile` in
  `services/agent-runtime-profile.ts`.

`runner_kind` itself is provider-agnostic — it describes runner capability
(`workspaceWrite`, `toolCalls`, `structuredOutput`, transport, etc.), not the
model or vendor it talks to. The same `planner` runner kind serves a planning
agent backed by OpenAI, Anthropic, or any other provider.

## Resolution path

`resolveExecutionProfile` is the runtime resolver. For a given agent it looks
up the execution profile in this order:

1. **`routing_rule`** — the canonical source. Match by
   `agent:<agentId>:execution-profile` rule name plus a `routing_rule_match`
   row with `kind='agent_id', key='id', value=<agentId>`. The rule carries
   `runner_kind`, `provider`, `model`, and `credential_id` /
   `credential_alias`. The platform API surfaces this via
   `getAgentCredentialReferenceRule` and `credentialRefFromRoutingRule`.
2. **`gateway_config` (legacy fallback)** — read when no routing rule exists
   for the agent. The fallback path sets `source.fallbackUsed=true` and
   `legacyGatewayConfigUsed=true` on the resolution and reads
   `runners[0].credential_id` / `credential_alias` instead of the canonical
   routing-rule path. New code should not rely on this; it exists so agents
   created before the routing-rule schema landed still work.

The fallback means a stale `gateway_config` for an agent without a routing
rule still produces a working profile. It also means: **if both exist and
disagree, the routing rule wins** — every code path that writes a credential
or runner_kind needs to keep both in sync.

## Write paths that must keep `routing_rule` ↔ `gateway_config` in sync

Three platform-API code paths write `routing_rule` and/or `gateway_config`
for an agent. All of them derive `runner_kind` from
`DEFAULT_RUNNER_KIND_BY_AGENT_TYPE` (or from an explicit user override):

| Path | Trigger | Writes |
|---|---|---|
| `applyDefaultAgentCredentials` (`services/setup/default-agents.ts`) | Onboarding `CloudKeyCard` save | `credential` + `routing_rule` + `gateway_config` |
| `syncCredentialIntoRoutingRuleForAgent` (`services/stored-agent-routing.ts`) | `POST /api/credentials` per-agent save | `credential` + `routing_rule` |
| `updateAgentRuntimeProfile` (`services/agent-runtime-profile.ts`) | Settings → Runtime editor | `routing_rule` + `gateway_config` |

If you add a fourth, route it through the canonical helpers — do not invent a
new `agentType → runner_kind` mapping inline. The bug class this avoids: an
inline mapping drifts from the canonical one, `routing_rule.runner_kind` ends
up disagreeing with `gateway_config.runners[0].kind`, the resolver prefers
the rule, and agents silently run on the wrong runner with the wrong
`workspaceWrite` policy.

## Cross-repo invariant

Schema migrations live in `harper-server`, not here. The `runner_kind` `CASE`
in
`harper-server/supabase/migrations/20260518150000_backfill_onboarding_routing_rules.sql`
(and any future SQL that derives `runner_kind` from `agent.type`) must agree
with `DEFAULT_RUNNER_KIND_BY_AGENT_TYPE`. SQL can't import from TypeScript, so
the canonical-source comment in the SQL file is the discoverability link —
update the comment and the CASE together when the TS map changes.
