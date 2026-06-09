create unique index if not exists scheduled_task_run_claim_key
  on public.scheduled_task_run (scheduled_task_id, scheduled_for);

comment on index public.scheduled_task_run_claim_key is
  'Supports idempotent scheduled task claiming via PostgREST on_conflict=scheduled_task_id,scheduled_for.';
