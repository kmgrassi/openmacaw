create table if not exists public.local_runtime_model (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  runner_kind text not null,
  model text not null,
  provider text,
  capabilities jsonb not null default '{}'::jsonb,
  last_advertised_at timestamptz not null default now()
);

create unique index if not exists local_runtime_model_machine_runner_model_key
  on public.local_runtime_model (machine_id, runner_kind, model);

create index if not exists local_runtime_model_machine_idx
  on public.local_runtime_model (machine_id);

alter table public.routing_rule
  add column if not exists machine_id uuid references public.local_runtime_machine(id) on delete set null,
  add column if not exists last_error text,
  add column if not exists last_error_at timestamptz;

create index if not exists routing_rule_machine_idx
  on public.routing_rule (machine_id);

alter table public.local_runtime_machine
  add column if not exists status text not null default 'offline';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'local_runtime_machine_status_check'
      and conrelid = 'public.local_runtime_machine'::regclass
  ) then
    alter table public.local_runtime_machine
      add constraint local_runtime_machine_status_check
      check (status in ('online', 'offline', 'degraded'));
  end if;
end $$;

create table if not exists public.local_runtime_event (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  workspace_id uuid not null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.local_runtime_event enable row level security;

drop policy if exists openmacaw_workspace_member_access on public.local_runtime_event;
create policy openmacaw_workspace_member_access
  on public.local_runtime_event
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create index if not exists local_runtime_event_machine_created_idx
  on public.local_runtime_event (machine_id, created_at desc);

create index if not exists local_runtime_event_workspace_created_idx
  on public.local_runtime_event (workspace_id, created_at desc);

alter table public.local_runtime_token
  add column if not exists expires_at timestamptz;

notify pgrst, 'reload schema';
