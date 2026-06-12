-- Drop the `local_runtime` runner_kind alias.
--
-- `local_runtime` was a platform-only routing_rule.runner_kind value for a
-- direct local-model transport the runtime never implemented: the
-- orchestrator's execution-profile allowlist
-- (apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex)
-- rejects it, so chats on such rules silently fell back to codex. All local
-- model dispatch goes through the helper relay, so registered local models
-- now write `local_relay` (with the runtime family in `provider`). Rewrite
-- existing rows and constrain the enum-bearing columns so the alias cannot
-- come back.

update public.routing_rule
set runner_kind = 'local_relay',
    updated_at = now()
where runner_kind = 'local_runtime';

update public.provider_failure
set runner_kind = 'local_relay'
where runner_kind = 'local_runtime';

update public.tool
set runner_kind = 'local_relay'
where runner_kind = 'local_runtime';

update public.plan
set default_runner_kind = 'local_relay'
where default_runner_kind = 'local_runtime';

update public.work_items
set runner_kind = 'local_relay'
where runner_kind = 'local_runtime';

update public.message
set runner_kind = 'local_relay'
where runner_kind = 'local_runtime';

-- routing_rule.runner_kind previously had no CHECK constraint in the
-- OpenMacaw schema. Add one matching the platform's RUNNER_REGISTRY
-- (contracts/runner-kinds.ts) plus the runtime-canonical `manager` /
-- `planner` kinds that gateway execution-profile rows store directly.
alter table public.routing_rule
  drop constraint if exists routing_rule_runner_kind_check;
alter table public.routing_rule
  add constraint routing_rule_runner_kind_check check (
    runner_kind in (
      'codex',
      'claude_code',
      'openclaw',
      'local_model_coding',
      'llm_tool_runner',
      'planner',
      'manager',
      'openclaw_ws',
      'openclaw_http_sse',
      'computer_use',
      'local_relay'
    )
  );

-- Recreate the provider_failure runner_kind allowlist without local_runtime.
alter table public.provider_failure
  drop constraint if exists provider_failure_runner_kind_check;
alter table public.provider_failure
  add constraint provider_failure_runner_kind_check check (
    runner_kind in (
      'codex',
      'claude_code',
      'openclaw',
      'local_model_coding',
      'llm_tool_runner',
      'planner',
      'manager',
      'openclaw_ws',
      'openclaw_http_sse',
      'computer_use',
      'local_relay'
    )
  );
