-- Bring existing OpenMacaw databases in line with the runtime/platform
-- workspace_settings contract. The initial open-source schema created the
-- table before these settings columns landed, so this migration is additive
-- and idempotent for already-patched databases.

alter table public.workspace_settings
  alter column learning_enabled set default true;

update public.workspace_settings
set learning_enabled = true
where learning_enabled is null;

alter table public.workspace_settings
  alter column learning_enabled set not null;

alter table public.workspace_settings
  add column if not exists tracker_kind text default 'database',
  add column if not exists tracker_credential_id uuid,
  add column if not exists max_concurrent_agents integer default 10;

update public.workspace_settings
set tracker_kind = 'database'
where tracker_kind is null;

update public.workspace_settings
set max_concurrent_agents = 10
where max_concurrent_agents is null;

alter table public.workspace_settings
  alter column tracker_kind set default 'database',
  alter column tracker_kind set not null,
  alter column max_concurrent_agents set default 10,
  alter column max_concurrent_agents set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_settings_tracker_kind_check'
      and conrelid = 'public.workspace_settings'::regclass
  ) then
    alter table public.workspace_settings
      add constraint workspace_settings_tracker_kind_check
      check (tracker_kind in ('linear', 'memory', 'database', 'github', 'api'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_settings_max_concurrent_agents_check'
      and conrelid = 'public.workspace_settings'::regclass
  ) then
    alter table public.workspace_settings
      add constraint workspace_settings_max_concurrent_agents_check
      check (max_concurrent_agents between 1 and 50);
  end if;
end $$;

comment on column public.workspace_settings.learning_enabled is
  'Whether workspace learning/reflection is enabled. Defaults on when no explicit workspace row exists.';

comment on column public.workspace_settings.tracker_kind is
  'Workspace-scoped tracker adapter: linear, memory, database, github, or api.';

comment on column public.workspace_settings.tracker_credential_id is
  'Optional workspace credential reference used by tracker adapters that require external credentials.';

comment on column public.workspace_settings.max_concurrent_agents is
  'Workspace-level cap for concurrently running agents.';
