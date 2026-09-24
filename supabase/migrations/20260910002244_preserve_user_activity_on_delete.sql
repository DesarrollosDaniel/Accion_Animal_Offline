-- Clinical and audit tables already reference auth.users with ON DELETE SET NULL.
-- This guard makes the retention requirement explicit and stops the migration if
-- a destructive user foreign key has been introduced by mistake.
do $$
begin
  if exists (
    select 1
    from pg_constraint as constraint_record
    join pg_class as source_table on source_table.oid = constraint_record.conrelid
    join pg_namespace as source_schema on source_schema.oid = source_table.relnamespace
    where constraint_record.contype = 'f'
      and constraint_record.confrelid = 'auth.users'::regclass
      and source_schema.nspname = 'public'
      and source_table.relname <> 'profiles'
      and constraint_record.confdeltype <> 'n'
  ) then
    raise exception 'Every activity reference to auth.users must use ON DELETE SET NULL';
  end if;
end;
$$;

-- Supabase Auth refuses to delete users who still own Storage objects. This
-- owner-only helper detaches ownership without deleting the objects themselves.
create or replace function public.prepare_auth_user_deletion(target_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count bigint := 0;
begin
  if (select auth.uid()) is null
     or not (select private.has_role(array['owner']::public.app_role[])) then
    raise exception 'Only the owner can prepare a user deletion'
      using errcode = '42501';
  end if;

  if target_user_id = (select auth.uid()) then
    raise exception 'The owner cannot delete their own account'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles where id = target_user_id and role <> 'owner'
  ) then
    raise exception 'The target user does not exist or cannot be deleted'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id'
  ) then
    execute 'update storage.objects set owner_id = null where owner_id = $1'
      using target_user_id::text;
    get diagnostics affected_count = row_count;
  end if;

  return affected_count;
end;
$$;

revoke all on function public.prepare_auth_user_deletion(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.prepare_auth_user_deletion(uuid) to authenticated;

comment on function public.prepare_auth_user_deletion(uuid) is
  'Owner-only preparation for hard-deleting an Auth user while retaining Storage objects.';
