create or replace function public.ensure_default_workspace_for_user(
  p_user_id uuid,
  p_workspace_name text default 'Personal Workspace'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('openmacaw_default_workspace'), hashtext(p_user_id::text));

  select wm.workspace_id
    into v_workspace_id
  from public.workspace_members wm
  where wm.user_id = p_user_id
  order by wm.created_at asc
  limit 1;

  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  insert into public.workspaces (name, owner_user_id)
  values (coalesce(nullif(trim(p_workspace_name), ''), 'Personal Workspace'), p_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  return v_workspace_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_user_id uuid;
begin
  insert into public."user" (auth_id, email, full_name, avatar_url, source, type, created_at)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'avatar_url', 'supabase', 'user', now())
  on conflict (auth_id) where auth_id is not null do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public."user".full_name),
    avatar_url = coalesce(excluded.avatar_url, public."user".avatar_url)
  returning id into v_app_user_id;

  perform public.ensure_default_workspace_for_user(v_app_user_id, 'Personal Workspace');
  return new;
end;
$$;
