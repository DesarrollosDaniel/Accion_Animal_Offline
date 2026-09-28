begin;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'aa_sync_worker' and (rolsuper or rolbypassrls or rolinherit)) then
    raise exception 'The worker must not bypass RLS or inherit business permissions';
  end if;
  if not pg_has_role('aa_sync_worker', 'authenticated', 'MEMBER') then
    raise exception 'The worker cannot assume the authenticated business role';
  end if;
  if has_table_privilege('authenticated', 'aa_sync.receipts', 'SELECT')
     or has_table_privilege('anon', 'aa_sync.receipts', 'SELECT') then
    raise exception 'Receipts must not be exposed to application users';
  end if;
  if has_table_privilege('aa_sync_worker', 'aa_sync.receipts', 'UPDATE')
     or has_table_privilege('aa_sync_worker', 'aa_sync.receipts', 'DELETE') then
    raise exception 'Remote receipts must be immutable for the worker';
  end if;
end;
$$;

set local role aa_sync_worker;
insert into aa_sync.receipts (operation_id, entity_table, entity_id, source_version, fingerprint)
values ('bd3c3a21-cce1-4d1c-a3f9-11714372dd40', 'pet_notes', '0c4e6d3a-15db-49af-a363-6d9f1d37dc23', 1, repeat('a', 64));
do $$
begin
  if not exists (select 1 from aa_sync.receipts where operation_id = 'bd3c3a21-cce1-4d1c-a3f9-11714372dd40') then
    raise exception 'The worker cannot read its durable receipt';
  end if;
  begin
    insert into aa_sync.receipts (operation_id, entity_table, entity_id, source_version, fingerprint)
    values ('bd3c3a21-cce1-4d1c-a3f9-11714372dd40', 'pet_notes', '0c4e6d3a-15db-49af-a363-6d9f1d37dc23', 1, repeat('a', 64));
    raise exception 'Duplicate operation accepted';
  exception when unique_violation then null;
  end;
end;
$$;
reset role;
-- Exercise the existing RLS and audit triggers with disposable business rows.
select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
from public.profiles where is_active and role = 'owner' limit 1;
set local role aa_sync_worker;
set local role authenticated;
do $$
declare saved jsonb;
begin
  if auth.uid() is null then raise exception 'An active test owner is required'; end if;
  insert into public.pets as t (id, name, guardian_name)
  values ('c9a6f5f5-2b7b-4890-a859-f9926c40e19f', 'ENSAYO SYNC — ficticio', 'Tutora ficticia')
  returning to_jsonb(t) into saved;
  if saved->>'created_by' <> auth.uid()::text then raise exception 'Remote audit actor was not preserved'; end if;
  perform id from public.pets where id = 'c9a6f5f5-2b7b-4890-a859-f9926c40e19f' for update;
  update public.pets as t set name = 'ENSAYO SYNC — edición ficticia'
  where id = 'c9a6f5f5-2b7b-4890-a859-f9926c40e19f' returning to_jsonb(t) into saved;
  if saved->>'name' <> 'ENSAYO SYNC — edición ficticia' then raise exception 'Remote update rejected'; end if;
  delete from public.pets where id = 'c9a6f5f5-2b7b-4890-a859-f9926c40e19f';
  if not found then raise exception 'Remote deletion rejected'; end if;
end;
$$;
reset role;
select 'Remote sync receipt permissions and replay constraints passed' as result;
rollback;
