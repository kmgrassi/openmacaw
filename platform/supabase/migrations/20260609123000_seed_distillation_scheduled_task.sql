-- Seed one nightly learning-distillation scheduled task per learning-enabled
-- workspace. The task is attached to the workspace's oldest manager agent so
-- the existing scheduled-task service validation path can dispatch it.

with manager_agents as (
  select distinct on (a.workspace_id)
    a.workspace_id,
    a.id as agent_id
  from public.agent a
  left join public.workspace_settings ws
    on ws.workspace_id = a.workspace_id
  where a.type = 'manager'
    and coalesce(a.is_active, true)
    and coalesce(ws.learning_enabled, true) = true
  order by a.workspace_id, a.created_at asc nulls last, a.id
),
seed_rows as (
  select
    ma.workspace_id,
    ma.agent_id,
    'Nightly learning distillation'::text as title,
    'Cluster recent important run-summary memories and store reusable skill candidates for human review.'::text as instructions,
    jsonb_build_object('kind', 'every', 'interval', 1, 'unit', 'day', 'at', '03:30') as schedule,
    'Etc/UTC'::text as timezone,
    jsonb_build_object('kind', 'learning_distillation', 'windowDays', 7) as delivery,
    jsonb_build_object('source', 'seed_distillation_scheduled_task') as metadata,
    now() as seeded_at
  from manager_agents ma
  where not exists (
    select 1
    from public.scheduled_task st
    where st.workspace_id = ma.workspace_id
      and st.delivery->>'kind' = 'learning_distillation'
      and st.enabled = true
  )
)
insert into public.scheduled_task (
  workspace_id,
  agent_id,
  title,
  instructions,
  enabled,
  schedule,
  timezone,
  next_run_at,
  last_run_at,
  last_run_status,
  last_error,
  delivery,
  metadata,
  updated_at
)
select
  workspace_id,
  agent_id,
  title,
  instructions,
  true,
  schedule,
  timezone,
  date_trunc('day', seeded_at) + interval '1 day' + interval '3 hours 30 minutes',
  null,
  null,
  null,
  delivery,
  metadata,
  seeded_at
from seed_rows;
