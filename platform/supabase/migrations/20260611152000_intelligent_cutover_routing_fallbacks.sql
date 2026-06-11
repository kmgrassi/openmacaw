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
      check (model_tier_floor in ('frontier', 'mid', 'local', 'any'));
  end if;
end $$;

create table if not exists public.routing_rule_fallback (
  routing_rule_id uuid not null references public.routing_rule(id) on delete cascade,
  workspace_id uuid not null,
  position integer not null check (position >= 0),
  provider text not null check (provider in (
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
  )),
  model text not null,
  credential_id uuid references public.credential(id) on delete restrict,
  credential_alias text check (
    credential_alias is null
    or (credential_alias ~ '^[a-z0-9-]+$' and length(credential_alias) <= 64)
  ),
  primary key (routing_rule_id, position),
  constraint routing_rule_fallback_single_credential
    check (num_nonnulls(credential_id, credential_alias) <= 1)
);

comment on table public.routing_rule_fallback is
  'Ordered fallback chain links for intelligent provider cutovers.';

create index if not exists routing_rule_fallback_rule_idx
  on public.routing_rule_fallback (routing_rule_id);

create index if not exists routing_rule_fallback_workspace_rule_idx
  on public.routing_rule_fallback (workspace_id, routing_rule_id, position);

alter table public.routing_rule_fallback enable row level security;

drop policy if exists openmacaw_workspace_member_access
  on public.routing_rule_fallback;

create policy openmacaw_workspace_member_access
  on public.routing_rule_fallback
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

alter table public.routing_rule
  drop column if exists next_fallback_rule_id;
