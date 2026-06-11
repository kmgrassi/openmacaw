alter table public.routing_rule
  add column if not exists model_tier_floor text not null default 'any';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routing_rule_model_tier_floor_check'
      and conrelid = 'public.routing_rule'::regclass
  ) then
    alter table public.routing_rule
      add constraint routing_rule_model_tier_floor_check
      check (model_tier_floor in ('any', 'local', 'mid', 'frontier'));
  end if;
end $$;

create table if not exists public.routing_rule_fallback (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.routing_rule(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  position integer not null check (position >= 0),
  provider text not null,
  model text not null,
  credential_id uuid references public.credential(id) on delete set null,
  credential_alias text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, position)
);

comment on table public.routing_rule_fallback is 'Ordered provider/model fallback chain for an OpenMacaw routing rule.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routing_rule_fallback_provider_check'
      and conrelid = 'public.routing_rule_fallback'::regclass
  ) then
    alter table public.routing_rule_fallback
      add constraint routing_rule_fallback_provider_check
      check (
        provider in (
          'openai',
          'anthropic',
          'openai_compatible',
          'openai_codex',
          'xai',
          'google',
          'mistral',
          'groq',
          'openrouter',
          'together',
          'perplexity',
          'azure',
          'codex',
          'openclaw',
          'computer_use',
          'local'
        )
      );
  end if;
end $$;

create index if not exists routing_rule_fallback_rule_position_idx
  on public.routing_rule_fallback (rule_id, position);

create index if not exists routing_rule_fallback_workspace_idx
  on public.routing_rule_fallback (workspace_id);

alter table public.routing_rule_fallback enable row level security;

drop policy if exists openmacaw_workspace_member_access
  on public.routing_rule_fallback;

create policy openmacaw_workspace_member_access
  on public.routing_rule_fallback
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop trigger if exists set_updated_at on public.routing_rule_fallback;
create trigger set_updated_at
  before update on public.routing_rule_fallback
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
