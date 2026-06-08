do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'local_runtime_token_machine_id_fkey'
      and conrelid = 'public.local_runtime_token'::regclass
  ) then
    alter table public.local_runtime_token
      add constraint local_runtime_token_machine_id_fkey
      foreign key (machine_id)
      references public.local_runtime_machine(id)
      on delete cascade
      not valid;
  end if;
end $$;

notify pgrst, 'reload schema';
