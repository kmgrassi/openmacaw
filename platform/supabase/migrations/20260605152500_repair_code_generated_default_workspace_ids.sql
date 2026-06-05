create or replace function public._old_code_generated_personal_workspace_id(p_user_id uuid)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
declare
  v_hex text;
  v_original_variant text;
  v_variant text;
begin
  v_hex := encode(digest('default-personal-workspace:' || p_user_id::text, 'sha256'), 'hex');
  v_hex := overlay(v_hex placing '5' from 13 for 1);
  v_original_variant := substr(v_hex, 17, 1);
  v_variant := substr('89ab', ((strpos('0123456789abcdef', v_original_variant) - 1) % 4) + 1, 1);
  v_hex := overlay(v_hex placing v_variant from 17 for 1);

  return (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-' ||
    substr(v_hex, 13, 4) || '-' ||
    substr(v_hex, 17, 4) || '-' ||
    substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

do $$
declare
  v_old record;
  v_new_workspace_id uuid;
  v_table record;
begin
  for v_old in
    select w.*
    from public.workspaces w
    where w.id = public._old_code_generated_personal_workspace_id(w.owner_user_id)
       or (w.id = w.owner_user_id and w.name = 'Personal Workspace')
  loop
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
      using v_new_workspace_id, v_old.id;
    end loop;

    delete from public.workspaces where id = v_old.id;
  end loop;
end;
$$;

drop function if exists public._old_code_generated_personal_workspace_id(uuid);
