do $$
declare
  v_old_workspace_id uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  v_old record;
  v_new_workspace_id uuid;
  v_table record;
begin
  select w.*
    into v_old
  from public.workspaces w
  where w.id = v_old_workspace_id
    and w.name = 'Disposable Local Tool Eval Workspace'
    and (select count(*) from public.workspaces) = 1
    and (select count(*) from public."user") = 1;

  if v_old.id is null then
    return;
  end if;

  insert into public.workspaces (name, owner_user_id, created_at)
  values (v_old.name, v_old.owner_user_id, v_old.created_at)
  returning id into v_new_workspace_id;

  for v_table in
    select table_name
    from information_schema.columns
    join information_schema.tables using (table_schema, table_name)
    where table_schema = 'public'
      and column_name = 'workspace_id'
      and table_type = 'BASE TABLE'
    order by table_name
  loop
    execute format(
      'update public.%I set workspace_id = $1 where workspace_id = $2',
      v_table.table_name
    )
    using v_new_workspace_id, v_old_workspace_id;
  end loop;

  delete from public.workspaces where id = v_old_workspace_id;
end;
$$;
