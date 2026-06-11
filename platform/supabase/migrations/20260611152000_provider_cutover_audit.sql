begin;

create table if not exists public.provider_cutover (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agent(id) on delete cascade,
  work_item_id uuid references public.work_items(id) on delete cascade,
  triggered_at timestamptz not null default now(),
  from_provider text not null,
  from_model text not null,
  from_credential_id uuid references public.credential(id) on delete set null,
  to_provider text,
  to_model text,
  to_credential_id uuid references public.credential(id) on delete set null,
  trigger_error_code text not null,
  trigger_status_code integer,
  elapsed_ms integer not null check (elapsed_ms >= 0),
  outcome text not null check (
    outcome in (
      'fallback_succeeded',
      'fallback_failed',
      'escalated_floor',
      'escalated_exhausted',
      'skipped_no_adapter'
    )
  )
);

create index if not exists provider_cutover_workspace_recent
  on public.provider_cutover (workspace_id, triggered_at desc, id desc);

create index if not exists provider_cutover_work_item
  on public.provider_cutover (work_item_id);

alter table public.provider_cutover enable row level security;

drop policy if exists provider_cutover_workspace_member_access on public.provider_cutover;
create policy provider_cutover_workspace_member_access
  on public.provider_cutover
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

commit;
