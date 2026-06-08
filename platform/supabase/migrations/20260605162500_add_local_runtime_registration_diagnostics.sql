alter table public.local_runtime_machine
  add column if not exists last_registration_at timestamptz,
  add column if not exists last_registration_status text,
  add column if not exists last_registration_error_code text,
  add column if not exists last_registration_error_message text;

notify pgrst, 'reload schema';
