begin;

do $$
declare
  table_count integer;
  stream_count integer;
  app_exists boolean;
begin
  select count(*) into table_count from information_schema.tables
  where table_schema = 'aa_local' and table_type = 'BASE TABLE';
  if table_count <> 14 then
    raise exception 'Expected 14 local tables, found %', table_count;
  end if;
  select count(*) into stream_count from aa_local.sync_state;
  if stream_count <> 2 then
    raise exception 'Expected 2 synchronization streams, found %', stream_count;
  end if;
  select exists (select 1 from pg_roles where rolname = 'aa_local_app') into app_exists;
  if not app_exists then
    raise exception 'Application role is missing';
  end if;
  if has_schema_privilege('aa_local_app', 'aa_local', 'CREATE') then
    raise exception 'Application role can create local schema objects';
  end if;
  if has_function_privilege('aa_local_app', 'aa_local.log_business_change()', 'EXECUTE') then
    raise exception 'Application role can execute the audit function directly';
  end if;
end;
$$;

set role aa_local_app;

do $$
declare
  actor uuid := gen_random_uuid();
  pet uuid;
  operation uuid;
  version_after_update bigint;
  audit_count integer;
begin
  insert into aa_local.profiles (id, display_name, role)
  values (actor, 'Usuario de prueba', 'veterinarian');
  perform set_config('aa.actor_id', actor::text, true);

  insert into aa_local.pets (name, guardian_name, created_by)
  values ('Luna', 'Tutor de prueba', actor)
  returning id into pet;
  update aa_local.pets set name = 'Luna II' where id = pet
  returning row_version into version_after_update;
  if version_after_update <> 2 then
    raise exception 'Pet row version did not increment';
  end if;

  select count(*) into audit_count from aa_local.audit_events
  where entity_table = 'pets' and entity_id = pet and actor_id = actor;
  if audit_count <> 2 then
    raise exception 'Expected 2 attributed pet audit events, found %', audit_count;
  end if;

  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload)
  values
    ('pets', pet, 'UPDATE', version_after_update, actor,
     jsonb_build_object('id', pet, 'name', 'Luna II'))
  returning id into operation;

  begin
    insert into aa_local.sync_operations
      (entity_table, entity_id, action, source_version, actor_id, payload)
    values
      ('pets', pet, 'UPDATE', version_after_update, actor,
       jsonb_build_object('id', pet));
    raise exception 'Duplicate origin version was accepted';
  exception when unique_violation then
    null;
  end;

  insert into aa_local.sync_errors (operation_id, kind, message)
  values (operation, 'temporary', 'Fallo temporal de prueba');
  insert into aa_local.sync_confirmations (operation_id, remote_version)
  values (operation, 2);
  update aa_local.sync_operations set status = 'confirmed' where id = operation;
  update aa_local.sync_state
  set last_success_at = now() where stream = 'business_outbound';

  begin
    update aa_local.sync_operations set payload = '{}'::jsonb where id = operation;
    raise exception 'Application role changed an operation payload';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into aa_local.audit_events (action, entity_table, entity_id)
    values ('INSERT', 'pets', pet);
    raise exception 'Application role inserted an audit event directly';
  exception when insufficient_privilege then
    null;
  end;

  delete from aa_local.pets where id = pet;
  select count(*) into audit_count from aa_local.audit_events
  where entity_table = 'pets' and entity_id = pet and actor_id = actor;
  if audit_count <> 3 then
    raise exception 'Expected 3 attributed pet audit events, found %', audit_count;
  end if;

  raise notice 'Synchronization foundation checks passed';
end;
$$;

reset role;
rollback;
