create table if not exists public.routing_rule_change (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  routing_rule_id uuid not null references public.routing_rule(id) on delete cascade,
  actor_agent_id uuid references public.agent(id) on delete set null,
  change_kind text not null check (change_kind in ('primary_model', 'fallback_chain', 'enabled')),
  old_provider text,
  old_model text,
  new_provider text,
  new_model text,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

alter table public.routing_rule
  add column if not exists model_tier_floor text not null default 'any'
  check (model_tier_floor in ('any', 'local', 'mid', 'frontier'));

create table if not exists public.routing_rule_fallback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  routing_rule_id uuid not null references public.routing_rule(id) on delete cascade,
  position integer not null check (position >= 0),
  provider text not null,
  model text not null,
  credential_id uuid,
  credential_alias text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (routing_rule_id, position)
);

create index if not exists routing_rule_fallback_rule_position_idx
  on public.routing_rule_fallback (routing_rule_id, position);

alter table public.routing_rule_fallback enable row level security;

drop policy if exists routing_rule_fallback_workspace_member_access
  on public.routing_rule_fallback;

create policy routing_rule_fallback_workspace_member_access
  on public.routing_rule_fallback
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create index if not exists routing_rule_change_workspace_created_idx
  on public.routing_rule_change (workspace_id, created_at desc);

create index if not exists routing_rule_change_rule_created_idx
  on public.routing_rule_change (routing_rule_id, created_at desc);

alter table public.routing_rule_change enable row level security;

drop policy if exists routing_rule_change_workspace_member_access
  on public.routing_rule_change;

create policy routing_rule_change_workspace_member_access
  on public.routing_rule_change
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

with router_tools(slug, name, description, parameters) as (
  values
    (
      'routing_rule.list',
      'List routing rules',
      'List routing rules in the current workspace with their primary model and routing policy fields.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":200}}}'::jsonb
    ),
    (
      'routing_rule.read',
      'Read routing rule',
      'Read one routing rule in the current workspace by routingRuleId.',
      '{"type":"object","required":["routingRuleId"],"properties":{"routingRuleId":{"type":"string","format":"uuid"}}}'::jsonb
    ),
    (
      'routing_rule.update',
      'Update routing rule',
      'Update a routing rule primary model and enabled state. A non-empty reason is required and every successful write creates a routing_rule_change row.',
      '{"type":"object","required":["routingRuleId","reason"],"properties":{"routingRuleId":{"type":"string","format":"uuid"},"provider":{"type":"string"},"model":{"type":"string"},"credentialRef":{"type":"object","properties":{"type":{"type":"string","enum":["credential_id","alias"]},"value":{"type":"string"}}},"fallbacks":{"type":"array","items":{"type":"object","required":["provider","model"],"properties":{"provider":{"type":"string"},"model":{"type":"string"},"credentialRef":{"type":"object","properties":{"type":{"type":"string","enum":["credential_id","alias"]},"value":{"type":"string"}}}}},"enabled":{"type":"boolean"},"reason":{"type":"string","minLength":1}}}'::jsonb
    ),
    (
      'provider_failure.list',
      'List provider failures',
      'List recent provider failure summaries for the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb
    ),
    (
      'local_model.list',
      'List local models',
      'List active local runtime machines and advertised local models in the current workspace.',
      '{"type":"object","properties":{}}'::jsonb
    ),
    (
      'provider_cutover.list',
      'List provider cutovers',
      'List recent provider cutover audit rows for the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb
    )
)
update public.tool
set
  name = router_tools.name,
  description = router_tools.description,
  parameters = router_tools.parameters,
  function_name = router_tools.slug,
  execution_kind = 'database',
  runner_kind = 'planner',
  enabled = true,
  updated_at = now()
from router_tools
where public.tool.workspace_id is null
  and public.tool.slug = router_tools.slug;

with router_tools(slug, name, description, parameters) as (
  values
    (
      'routing_rule.list',
      'List routing rules',
      'List routing rules in the current workspace with their primary model and routing policy fields.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":200}}}'::jsonb
    ),
    (
      'routing_rule.read',
      'Read routing rule',
      'Read one routing rule in the current workspace by routingRuleId.',
      '{"type":"object","required":["routingRuleId"],"properties":{"routingRuleId":{"type":"string","format":"uuid"}}}'::jsonb
    ),
    (
      'routing_rule.update',
      'Update routing rule',
      'Update a routing rule primary model and enabled state. A non-empty reason is required and every successful write creates a routing_rule_change row.',
      '{"type":"object","required":["routingRuleId","reason"],"properties":{"routingRuleId":{"type":"string","format":"uuid"},"provider":{"type":"string"},"model":{"type":"string"},"credentialRef":{"type":"object","properties":{"type":{"type":"string","enum":["credential_id","alias"]},"value":{"type":"string"}}},"fallbacks":{"type":"array","items":{"type":"object","required":["provider","model"],"properties":{"provider":{"type":"string"},"model":{"type":"string"},"credentialRef":{"type":"object","properties":{"type":{"type":"string","enum":["credential_id","alias"]},"value":{"type":"string"}}}}},"enabled":{"type":"boolean"},"reason":{"type":"string","minLength":1}}}'::jsonb
    ),
    (
      'provider_failure.list',
      'List provider failures',
      'List recent provider failure summaries for the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb
    ),
    (
      'local_model.list',
      'List local models',
      'List active local runtime machines and advertised local models in the current workspace.',
      '{"type":"object","properties":{}}'::jsonb
    ),
    (
      'provider_cutover.list',
      'List provider cutovers',
      'List recent provider cutover audit rows for the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb
    )
)
insert into public.tool (
  slug,
  name,
  description,
  parameters,
  function_name,
  execution_kind,
  runner_kind,
  enabled,
  workspace_id,
  updated_at
)
select
  slug,
  name,
  description,
  parameters,
  slug,
  'database',
  'planner',
  true,
  null,
  now()
from router_tools
where not exists (
  select 1
  from public.tool existing
  where existing.workspace_id is null
    and existing.slug = router_tools.slug
);

insert into public.tool_policy_template (
  slug,
  name,
  description,
  system_managed,
  enabled,
  workspace_id,
  updated_at
)
select
  'router',
  'Router Agent',
  'Routing policy optimization tools for reading failures, local model inventory, cutovers, and audited routing-rule updates.',
  true,
  true,
  null,
  now()
where not exists (
  select 1
  from public.tool_policy_template
  where slug = 'router'
    and workspace_id is null
);

with template as (
  select id
  from public.tool_policy_template
  where slug = 'router'
    and workspace_id is null
  order by created_at asc
  limit 1
),
template_tools as (
  select tool.id as tool_id
  from public.tool
  where tool.workspace_id is null
    and tool.slug in (
      'routing_rule.list',
      'routing_rule.read',
      'routing_rule.update',
      'provider_failure.list',
      'local_model.list',
      'provider_cutover.list',
      'scheduled_task.read'
    )
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  template.id,
  template.id,
  template_tools.tool_id,
  null
from template
cross join template_tools
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = template.id
    and existing.tool_id = template_tools.tool_id
);
