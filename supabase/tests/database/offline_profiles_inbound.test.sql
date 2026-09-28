begin;
do $$
begin
  if not has_column_privilege('aa_sync_worker', 'public.profiles', 'id', 'SELECT')
    or has_table_privilege('aa_sync_worker', 'public.profiles', 'UPDATE')
    or has_table_privilege('aa_sync_worker', 'public.profiles', 'DELETE')
    or has_table_privilege('aa_sync_worker', 'auth.users', 'SELECT') then
    raise exception 'Unexpected worker privileges';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
    and policyname = 'profiles_sync_read' and roles = array['aa_sync_worker']::name[] and cmd = 'SELECT') then
    raise exception 'Missing dedicated read policy';
  end if;
end $$;
set local role aa_sync_worker;
select id, display_name, role, is_active, created_at, updated_at from public.profiles limit 0;
reset role;
rollback;
