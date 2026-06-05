-- Align agent rows with the runtime-generated schema contract.

begin;

alter table public.agent
  add column if not exists execution_target_kind text,
  add column if not exists status text,
  add column if not exists model_settings jsonb,
  add column if not exists tool_policy jsonb;

update public.agent
set execution_target_kind = 'codex'
where execution_target_kind is null;

update public.agent
set status = 'ready'
where status is null;

update public.agent
set model_settings = '{}'::jsonb
where model_settings is null;

update public.agent
set tool_policy = '{}'::jsonb
where tool_policy is null;

alter table public.agent
  alter column execution_target_kind set default 'codex',
  alter column execution_target_kind set not null,
  alter column status set default 'ready',
  alter column status set not null,
  alter column model_settings set default '{}'::jsonb,
  alter column model_settings set not null,
  alter column tool_policy set default '{}'::jsonb,
  alter column tool_policy set not null;

comment on column public.agent.execution_target_kind is
  'Runtime execution target kind. Local OpenMacaw agents default to codex.';

commit;
