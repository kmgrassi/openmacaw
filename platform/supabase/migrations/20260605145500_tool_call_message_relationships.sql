-- Restore relationships expected by generated types and PostgREST embeds.

begin;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_message'
      and conrelid = 'public.tool_call'::regclass
  ) then
    alter table public.tool_call
      add constraint fk_message
      foreign key (message_id)
      references public.message(id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_tool'
      and conrelid = 'public.tool_call'::regclass
  ) then
    alter table public.tool_call
      add constraint fk_tool
      foreign key (tool_id)
      references public.tool(id)
      on delete set null
      not valid;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
