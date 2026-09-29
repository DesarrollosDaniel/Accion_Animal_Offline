-- The dedicated worker reads only IDs and actions from the existing audit log.
grant select (id, action, entity_table, entity_id) on public.audit_events to aa_sync_worker;
create policy audit_events_sync_read on public.audit_events
  for select to aa_sync_worker using (true);

-- ponytail: one audit lock serializes writes so an ID cursor cannot skip an
-- older transaction that commits later. Revisit if write throughput grows.
create or replace function private.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(904501);
  affected_id := case when tg_op = 'DELETE' then old.id else new.id end;
  insert into public.audit_events (actor_id, action, entity_table, entity_id)
  values ((select auth.uid()), tg_op, tg_table_name, affected_id);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
