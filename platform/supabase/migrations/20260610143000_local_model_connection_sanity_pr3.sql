alter table public.local_runtime_machine
  add column if not exists status text not null default 'offline'
    check (status in ('online', 'offline', 'degraded'));

create table if not exists public.local_runtime_model (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  runner_kind text not null,
  model text not null,
  provider text,
  capabilities jsonb not null default '{}'::jsonb,
  last_advertised_at timestamptz not null default now(),
  unique (machine_id, runner_kind, model)
);

create index if not exists local_runtime_model_machine_idx
  on public.local_runtime_model (machine_id);

create table if not exists public.local_runtime_event (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  workspace_id uuid not null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists local_runtime_event_machine_created_idx
  on public.local_runtime_event (machine_id, created_at desc);

alter table public.routing_rule
  add column if not exists machine_id uuid references public.local_runtime_machine(id) on delete set null,
  add column if not exists last_error text,
  add column if not exists last_error_at timestamptz;

create index if not exists routing_rule_machine_idx
  on public.routing_rule (machine_id);

alter table public.local_runtime_token
  add column if not exists expires_at timestamptz;
