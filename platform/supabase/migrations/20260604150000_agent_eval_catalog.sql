begin;

create table if not exists public.agent_eval_suite (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  suite_type text not null default 'manual',
  enabled boolean not null default false,
  system_managed boolean not null default false,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public."user"(id) on delete set null,
  updated_by_user_id uuid references public."user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_suite is
  'Agent evaluation suite catalog. Suites may be global when workspace_id is null, or workspace-local when workspace_id is set.';

create table if not exists public.agent_eval_case (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.agent_eval_suite(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  prompt text not null,
  target_agent_id uuid references public.agent(id) on delete set null,
  target_agent_slug text,
  target_agent_role text,
  target_workspace_id uuid references public.workspaces(id) on delete set null,
  target_workspace_name text,
  difficulty text not null default 'smoke' check (difficulty in ('smoke', 'easy', 'medium', 'hard', 'stress')),
  side_effect_level text not null default 'read_only' check (side_effect_level in ('read_only', 'safe_write', 'external_side_effect', 'destructive')),
  enabled_by_default boolean not null default false,
  timeout_ms integer not null default 90000 check (timeout_ms > 0),
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public."user"(id) on delete set null,
  updated_by_user_id uuid references public."user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_case is
  'Prompt-level agent evaluation cases. Cases keep assertion rows separate so tool-call checks can grow into broader agent behavior checks.';

create table if not exists public.agent_eval_case_assertion (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.agent_eval_case(id) on delete cascade,
  assertion_type text not null,
  subject_kind text not null default 'trace' check (subject_kind in ('trace', 'tool_call', 'tool_result', 'final_output', 'message', 'environment_state', 'run_metadata')),
  tool_name text,
  tool_slug text,
  tool_call_occurrence text not null default 'any',
  json_path text,
  comparator_mode text not null default 'exact' check (comparator_mode in ('exact', 'normalized_string', 'regex', 'numeric_tolerance', 'datetime_tolerance', 'unordered_array', 'subset', 'json_schema', 'semantic_text', 'semantic_json')),
  expected_text text,
  expected_number numeric,
  expected_boolean boolean,
  expected_json jsonb,
  regex text,
  tolerance jsonb,
  min_calls integer check (min_calls is null or min_calls >= 0),
  max_calls integer check (max_calls is null or max_calls >= 0),
  sequence_index integer check (sequence_index is null or sequence_index >= 0),
  weight numeric not null default 1 check (weight >= 0),
  hard_fail boolean not null default false,
  required boolean not null default true,
  ordinal integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_case_assertion is
  'Expected outcomes for an agent evaluation case. assertion_type starts with deterministic tool-call checks and can expand without a migration.';

create table if not exists public.agent_eval_run (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid references public.agent_eval_suite(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  initiated_by_user_id uuid references public."user"(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'canceled', 'error')),
  trigger_source text not null default 'manual',
  selected_case_ids uuid[] not null default '{}',
  selected_tags text[] not null default '{}',
  side_effect_limit text not null default 'read_only' check (side_effect_limit in ('read_only', 'safe_write', 'external_side_effect', 'destructive')),
  provider text,
  model text,
  agent_version text,
  trace_id text,
  pass_threshold numeric default 1 check (pass_threshold is null or (pass_threshold >= 0 and pass_threshold <= 1)),
  score numeric check (score is null or (score >= 0 and score <= 1)),
  total_cases integer not null default 0 check (total_cases >= 0),
  passed_cases integer not null default 0 check (passed_cases >= 0),
  failed_cases integer not null default 0 check (failed_cases >= 0),
  skipped_cases integer not null default 0 check (skipped_cases >= 0),
  error_cases integer not null default 0 check (error_cases >= 0),
  summary_text text,
  artifacts_path text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_run is
  'Workspace-scoped execution record for a manually triggered agent evaluation battery.';

create table if not exists public.agent_eval_run_case (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  case_id uuid references public.agent_eval_case(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'skipped', 'error')),
  prompt text,
  score numeric check (score is null or (score >= 0 and score <= 1)),
  passed_assertions integer not null default 0 check (passed_assertions >= 0),
  failed_assertions integer not null default 0 check (failed_assertions >= 0),
  skipped_assertions integer not null default 0 check (skipped_assertions >= 0),
  observed_tool_call_count integer not null default 0 check (observed_tool_call_count >= 0),
  first_tool_call_id text,
  final_output_text text,
  error_code text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_run_case is
  'Per-case result for an agent evaluation run, including normalized assertion results and observed tool-call summary.';

create table if not exists public.agent_eval_assertion_result (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  run_case_id uuid not null references public.agent_eval_run_case(id) on delete cascade,
  assertion_id uuid references public.agent_eval_case_assertion(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  assertion_type text not null,
  status text not null default 'queued' check (status in ('queued', 'passed', 'failed', 'skipped', 'error')),
  score numeric check (score is null or (score >= 0 and score <= 1)),
  weight numeric not null default 1 check (weight >= 0),
  hard_fail boolean not null default false,
  explanation text,
  expected_text text,
  expected_number numeric,
  expected_boolean boolean,
  expected_json jsonb,
  actual_text text,
  actual_number numeric,
  actual_boolean boolean,
  actual_json jsonb,
  diff_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_assertion_result is
  'Per-assertion judge result for a run case. Scalar expectations and actuals are stored in columns; JSON remains only for structured values and diffs.';

create table if not exists public.agent_eval_observation (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  run_case_id uuid references public.agent_eval_run_case(id) on delete cascade,
  assertion_id uuid references public.agent_eval_case_assertion(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  observation_type text not null,
  evidence_kind text not null,
  evidence_table text,
  evidence_id uuid,
  call_id text,
  tool_name text,
  tool_slug text,
  sequence integer check (sequence is null or sequence >= 0),
  observed_text text,
  observed_number numeric,
  observed_boolean boolean,
  observed_json jsonb,
  arguments jsonb,
  result jsonb,
  provider_payload jsonb,
  passed boolean,
  message_id uuid references public.message(id) on delete set null,
  tool_call_id uuid references public.tool_call(id) on delete set null,
  agent_tool_call_event_id uuid references public.agent_tool_call_event(id) on delete set null,
  work_item_id uuid references public.work_items(id) on delete set null,
  plan_id uuid references public.plan(id) on delete set null,
  escalation_id uuid references public.escalation(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.agent_eval_observation is
  'Typed evidence observed while evaluating a case. Rows can point at product evidence such as messages, tool calls, work items, plans, escalations, and runtime events.';

create unique index if not exists agent_eval_suite_scope_slug_key
  on public.agent_eval_suite (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
create index if not exists agent_eval_suite_workspace_idx on public.agent_eval_suite (workspace_id);
create unique index if not exists agent_eval_case_suite_slug_key on public.agent_eval_case (suite_id, slug);
create index if not exists agent_eval_case_workspace_idx on public.agent_eval_case (workspace_id);
create index if not exists agent_eval_case_target_agent_idx on public.agent_eval_case (target_agent_id) where target_agent_id is not null;
create index if not exists agent_eval_case_tags_idx on public.agent_eval_case using gin (tags);
create index if not exists agent_eval_case_assertion_case_idx on public.agent_eval_case_assertion (case_id, ordinal);
create index if not exists agent_eval_case_assertion_tool_idx on public.agent_eval_case_assertion (tool_name, assertion_type) where tool_name is not null;
create index if not exists agent_eval_run_workspace_created_idx on public.agent_eval_run (workspace_id, created_at desc);
create index if not exists agent_eval_run_suite_idx on public.agent_eval_run (suite_id, created_at desc);
create index if not exists agent_eval_run_trace_idx on public.agent_eval_run (trace_id) where trace_id is not null;
create index if not exists agent_eval_run_case_run_idx on public.agent_eval_run_case (run_id, status);
create index if not exists agent_eval_run_case_case_idx on public.agent_eval_run_case (case_id, created_at desc);
create index if not exists agent_eval_assertion_result_run_case_idx on public.agent_eval_assertion_result (run_case_id, status);
create index if not exists agent_eval_assertion_result_assertion_idx on public.agent_eval_assertion_result (assertion_id, created_at desc);
create index if not exists agent_eval_observation_run_case_idx on public.agent_eval_observation (run_case_id, created_at);
create index if not exists agent_eval_observation_type_idx on public.agent_eval_observation (workspace_id, observation_type, created_at desc);
create index if not exists agent_eval_observation_call_idx on public.agent_eval_observation (call_id) where call_id is not null;
create index if not exists agent_eval_observation_tool_event_idx on public.agent_eval_observation (agent_tool_call_event_id) where agent_tool_call_event_id is not null;

do $$
declare
  rel_name text;
begin
  foreach rel_name in array array[
    'agent_eval_assertion_result',
    'agent_eval_suite',
    'agent_eval_case',
    'agent_eval_case_assertion',
    'agent_eval_run',
    'agent_eval_run_case'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', rel_name);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', rel_name);
  end loop;
end $$;

alter table public.agent_eval_suite enable row level security;
alter table public.agent_eval_case enable row level security;
alter table public.agent_eval_case_assertion enable row level security;
alter table public.agent_eval_run enable row level security;
alter table public.agent_eval_run_case enable row level security;
alter table public.agent_eval_assertion_result enable row level security;
alter table public.agent_eval_observation enable row level security;

drop policy if exists agent_eval_suite_member_access on public.agent_eval_suite;
drop policy if exists agent_eval_suite_member_select on public.agent_eval_suite;
create policy agent_eval_suite_member_select on public.agent_eval_suite
for select to authenticated
using (workspace_id is null or public.is_workspace_member(workspace_id));

drop policy if exists agent_eval_suite_member_insert on public.agent_eval_suite;
create policy agent_eval_suite_member_insert on public.agent_eval_suite
for insert to authenticated
with check (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

drop policy if exists agent_eval_suite_member_update on public.agent_eval_suite;
create policy agent_eval_suite_member_update on public.agent_eval_suite
for update to authenticated
using (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false)
with check (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

drop policy if exists agent_eval_suite_member_delete on public.agent_eval_suite;
create policy agent_eval_suite_member_delete on public.agent_eval_suite
for delete to authenticated
using (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

drop policy if exists agent_eval_case_member_access on public.agent_eval_case;
drop policy if exists agent_eval_case_member_select on public.agent_eval_case;
create policy agent_eval_case_member_select on public.agent_eval_case
for select to authenticated
using (
  (workspace_id is null or public.is_workspace_member(workspace_id))
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and (s.workspace_id is null or public.is_workspace_member(s.workspace_id))
  )
);

drop policy if exists agent_eval_case_member_insert on public.agent_eval_case;
create policy agent_eval_case_member_insert on public.agent_eval_case
for insert to authenticated
with check (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

drop policy if exists agent_eval_case_member_update on public.agent_eval_case;
create policy agent_eval_case_member_update on public.agent_eval_case
for update to authenticated
using (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
)
with check (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

drop policy if exists agent_eval_case_member_delete on public.agent_eval_case;
create policy agent_eval_case_member_delete on public.agent_eval_case
for delete to authenticated
using (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

drop policy if exists agent_eval_case_assertion_member_access on public.agent_eval_case_assertion;
drop policy if exists agent_eval_case_assertion_member_select on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_select on public.agent_eval_case_assertion
for select to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and (c.workspace_id is null or public.is_workspace_member(c.workspace_id))
      and (s.workspace_id is null or public.is_workspace_member(s.workspace_id))
  )
);

drop policy if exists agent_eval_case_assertion_member_insert on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_insert on public.agent_eval_case_assertion
for insert to authenticated
with check (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

drop policy if exists agent_eval_case_assertion_member_update on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_update on public.agent_eval_case_assertion
for update to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

drop policy if exists agent_eval_case_assertion_member_delete on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_delete on public.agent_eval_case_assertion
for delete to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

drop policy if exists agent_eval_run_member_access on public.agent_eval_run;
create policy agent_eval_run_member_access on public.agent_eval_run
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists agent_eval_run_case_member_access on public.agent_eval_run_case;
create policy agent_eval_run_case_member_access on public.agent_eval_run_case
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run r
    where r.id = agent_eval_run_case.run_id
      and r.workspace_id = agent_eval_run_case.workspace_id
  )
);

drop policy if exists agent_eval_assertion_result_member_access on public.agent_eval_assertion_result;
create policy agent_eval_assertion_result_member_access on public.agent_eval_assertion_result
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run_case rc
    where rc.id = agent_eval_assertion_result.run_case_id
      and rc.run_id = agent_eval_assertion_result.run_id
      and rc.workspace_id = agent_eval_assertion_result.workspace_id
  )
);

drop policy if exists agent_eval_observation_member_access on public.agent_eval_observation;
create policy agent_eval_observation_member_access on public.agent_eval_observation
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run r
    where r.id = agent_eval_observation.run_id
      and r.workspace_id = agent_eval_observation.workspace_id
  )
);

commit;
