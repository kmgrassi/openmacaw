begin;

create table if not exists public.provider_failure (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  work_item_id uuid references public.work_items(id) on delete set null,
  run_id text,
  runner_kind text not null check (
    runner_kind in (
      'codex',
      'claude_code',
      'openclaw',
      'local_runtime',
      'local_model_coding',
      'llm_tool_runner',
      'planner',
      'openclaw_ws',
      'openclaw_http_sse',
      'computer_use',
      'local_relay',
      'manager'
    )
  ),
  provider text not null check (
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
  ),
  model text not null,
  error_code text not null check (
    error_code in (
      'provider_auth_failed',
      'provider_content_refused',
      'provider_invalid_request',
      'provider_overloaded',
      'provider_rate_limited',
      'provider_stream_interrupted',
      'provider_timeout',
      'provider_unknown'
    )
  ),
  status_code integer check (status_code is null or (status_code >= 100 and status_code <= 599)),
  attempt integer not null default 1 check (attempt >= 1)
);

comment on table public.provider_failure is
  'Typed provider failure events for router-agent routing decisions.';

create index if not exists provider_failure_workspace_created_idx
  on public.provider_failure (workspace_id, created_at desc);

create index if not exists provider_failure_workspace_summary_idx
  on public.provider_failure (workspace_id, provider, model, error_code, created_at desc);

alter table public.provider_failure enable row level security;

drop policy if exists provider_failure_workspace_member_access on public.provider_failure;
create policy provider_failure_workspace_member_access
on public.provider_failure
for all
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

commit;
