# Hardcoded Scope Inventory

This document inventories the main hardcoded values in `parallel-agent-platform` that should be replaced with database-backed records, shared configuration, or a smaller canonical registry.

The goal is not to remove every literal. The goal is to remove product policy from code wherever the policy is expected to change, grow, or vary by workspace, agent, or runner.

This is a working inventory as of 2026-05-04. It is intended to be split into parallel refactors.

## What Counts As Hardcoded Here

- fixed runner kinds, tool slugs, provider names, and role lists;
- default models, URLs, iteration counts, and timeouts;
- fixture-only values that are being treated like product behavior;
- allowlists and registries that should come from data or one shared source of truth.

## Inventory

| Area | Hardcoded item | Current files | Better source of truth |
| --- | --- | --- | --- |
| Runner kinds and execution dimensions | `RUNNER_KINDS`, `RUNNER_FAMILIES`, `EXECUTION_LOCATIONS`, `ROUTING_TRANSPORTS`, and the full runner-kind -> dimension map | `contracts/runner-kinds.ts` | Database-backed runner registry or a shared canonical registry module that is generated from DB seed data |
| Local coding tool surface | Local coding tool slugs and per-tool discriminated unions for `repo.read_file`, `repo.list`, `repo.search`, `shell.exec`, `apply_patch` | `contracts/local-model-coding.ts` | Tool definition records plus a tool profile mapping, with the schema generated or expanded from the canonical tool set |
| Default tool bundles | Planning/coding tool slug bundles and the local-model coding override | `apps/api/src/services/default-agent-tools.ts`, `apps/api/src/services/agent-tools.ts`, `apps/api/src/services/execution-profile-resolver.ts`, `apps/api/src/services/stored-agent-routing.ts`, `apps/api/src/routes/stored-agent-credentials.ts` | Tool profiles resolved from data, then expanded to tool rows from the database |
| Provider registry | Provider enum values, env aliases, and launchable kind rules | `contracts/credentials.ts`, `contracts/execution-profile.ts` | Shared provider registry or config-backed provider catalog with explicit capability metadata |
| Agent role defaults | Default agent roles list | `apps/api/src/services/setup/types.ts` | Workspace or setup defaults stored in data, or a single setup seed registry |
| Default manager model | `openai/gpt-5.2` | `apps/api/src/services/setup/store.ts` | Setup seed/config table or workspace default model setting |
| Setup select strings and bootstrap constants | Hardcoded select strings and bootstrap defaults that encode app policy | `apps/api/src/services/setup/store.ts` | Typed query helpers plus seed/config records for workspace defaults |
| Local helper transport defaults | Helper base URL and execution timeout | `apps/api/src/services/tool-execution-client.ts` | Environment-driven config or runtime-discovered helper endpoint metadata |
| Local runtime execution target rules | `local_model_coding` runner constant and helper registration requirements | `apps/api/src/services/local-coding-execution-target.ts` | Canonical runner registry and runtime/helper registration data |
| Agent-to-runner fallback mapping | `planning`/`manager` -> `llm_tool_runner`, `custom` -> `openclaw_ws`, all others -> `codex` | `apps/api/src/services/stored-agent-routing.ts` | Routing rule data or an agent-type profile map instead of a hardcoded switch |
| Claude Code diagnostics | Claude tool names and disallowed paths | `apps/api/src/services/diagnostics/claude-code.ts` | A claude-code capability profile, possibly seeded from product policy data |
| Claude Code smoke fixtures | Fixed `runner_kind`, `provider`, `tool_profile`, and status assertions | `contracts/claude-code-smoke.ts`, `apps/api/src/services/claude-code-smoke.ts` | Fixture generators that draw from shared contracts rather than duplicating policy literals |
| Manager agent contract | Manager runner kind and provider restriction | `contracts/manager-agent.ts`, `contracts/manager-agent-smoke.ts` | Manager capability profile or registry entry |
| Plan runner defaults | Allowed plan runner kinds and default runner values in plan drafts | `contracts/plans.ts`, `apps/api/src/routes/plans.ts` and related tests | Plan runner profile data, especially if new planning backends are expected |
| Local model proxy defaults | Default local endpoint and tool-call iteration cap | `apps/api/src/routes/local-model-proxy.ts` | Env/config or a runtime capability record |
| Launcher start request kind | Worker bridge session request kind fixed to `codex` | `apps/api/src/services/launcher.ts` | Launcher target registry or worker-bridge capability profile |
| Smoke and model-agnostic fixtures | Hardcoded providers, model IDs, and tool profiles used to prove routing | `contracts/model-agnostic-smoke.ts`, `apps/api/src/services/model-agnostic-smoke.ts`, `apps/api/src/routes/model-agnostic-smoke.test.ts`, `apps/api/src/routes/proxy-runtime-dispatch.test.ts` | Fixture builders fed from the same canonical profiles as production code |
| Select lists and row projections | String-select constants used as pseudo-schema | `apps/api/src/services/setup/store.ts`, `apps/api/src/repositories/*.ts`, `apps/api/src/services/agent-tools.ts`, `apps/api/src/services/default-agent-tools.ts` | Typed projection helpers, generated row schemas, or smaller repository-specific parsers |

## Refactor Slices

These are the clean parallel branches to split the work into.

1. Runner registry normalization
   - Move runner kinds, families, locations, and transports behind one registry source.
   - Collapse duplicated runner-kind switches in contracts and routing code.

2. Tool profile normalization
   - Replace inline slug bundles with profile data.
   - Make `agent_type` and `tool_profile` resolve once, then expand to tool rows.

3. Provider and credential registry normalization
   - Pull provider rules into one shared registry.
   - Remove duplicated provider allowlists and launchable-kind rules.

4. Setup default normalization
   - Move default roles, default models, and setup bootstrap constants out of service code.
   - Keep setup behavior configurable per workspace or seed source.

5. Transport and helper default normalization
   - Move helper URL, timeout, and local transport defaults into env/config or runtime metadata.
   - Keep local-helper assumptions out of generic tool execution code.

6. Fixture cleanup
   - Replace hardcoded smoke-test values with fixture builders that read from the same canonical profiles.
   - Keep tests asserting behavior, not duplicated policy.

## Suggested Order

1. Tool profiles and default tool bundles.
2. Runner registry normalization.
3. Provider/credential registry normalization.
4. Setup defaults and launcher/helper transport defaults.
5. Fixture cleanup and smoke-test consolidation.

## Notes

- Some literals are fine when they are part of a protocol contract or schema discriminator. The target is not "zero literals"; the target is "no duplicated product policy."
- A file should move here if a change to that value would require editing several separate code paths.
- When in doubt, favor a single registry or DB row set over a hardcoded array in service code.
