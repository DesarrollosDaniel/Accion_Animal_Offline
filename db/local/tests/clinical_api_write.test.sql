-- Verifica permisos, auditoría y operaciones pendientes. La ruta de archivo
-- es solo un metadato de prueba: este SQL no crea un archivo físico.
-- ROLLBACK elimina todas las filas temporales al terminar.
begin;
set role aa_local_app;

do $$
declare
  test_actor uuid := gen_random_uuid();
  pet_id uuid;
  record_id uuid;
  weight_id uuid;
  file_id uuid;
  vaccination_id uuid;
  note_id uuid;
  pet_operation_id uuid;
  record_operation_id uuid;
  weight_operation_id uuid;
  file_operation_id uuid;
  file_delete_operation_id uuid;
  vaccination_operation_id uuid;
  vaccination_update_operation_id uuid;
  vaccination_delete_operation_id uuid;
  note_operation_id uuid;
  pet_update_operation_id uuid;
  record_update_operation_id uuid;
  new_version bigint;
  matching_audits integer;
begin
  insert into aa_local.profiles (id, display_name, role)
  values (test_actor, 'Profesional temporal', 'veterinarian');
  perform set_config('aa.actor_id', test_actor::text, true);

  insert into aa_local.pets (name, guardian_name, created_by, updated_by)
  values ('Mascota temporal', 'Tutor temporal', test_actor, test_actor)
  returning id into pet_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload)
  select 'pets', id, 'INSERT', row_version, test_actor, to_jsonb(p)
  from aa_local.pets as p where id = pet_id
  returning id into pet_operation_id;

  insert into aa_local.vaccinations
    (pet_id, vaccine_name, administered_on, created_by, updated_by)
  values (pet_id, 'Rabia', current_date, test_actor, test_actor)
  returning id into vaccination_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'vaccinations', id, 'INSERT', row_version, test_actor, to_jsonb(v), pet_operation_id
  from aa_local.vaccinations as v where id = vaccination_id
  returning id into vaccination_operation_id;

  insert into aa_local.pet_notes (pet_id, body, created_by, updated_by)
  values (pet_id, 'Nota temporal', test_actor, test_actor)
  returning id into note_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'pet_notes', id, 'INSERT', row_version, test_actor, to_jsonb(n), pet_operation_id
  from aa_local.pet_notes as n where id = note_id
  returning id into note_operation_id;

  insert into aa_local.clinical_records
    (pet_id, occurred_at, history, attended_by, created_by, updated_by)
  values (pet_id, now(), 'Consulta temporal', test_actor, test_actor, test_actor)
  returning id into record_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'clinical_records', id, 'INSERT', row_version, test_actor, to_jsonb(r), pet_operation_id
  from aa_local.clinical_records as r where id = record_id
  returning id into record_operation_id;

  insert into aa_local.weight_records
    (pet_id, measured_at, weight_kg, created_by, updated_by)
  values (pet_id, now(), 12.500, test_actor, test_actor)
  returning id into weight_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'weight_records', id, 'INSERT', row_version, test_actor, to_jsonb(w), record_operation_id
  from aa_local.weight_records as w where id = weight_id
  returning id into weight_operation_id;

  insert into aa_local.clinical_files
    (clinical_record_id, kind, object_path, original_name, mime_type, size_bytes, checksum_sha256, created_by)
  values
    (record_id, 'document', 'uploaded/clinicos/temporal.txt', 'temporal.txt',
     'text/plain', 4, repeat('0', 64), test_actor)
  returning id into file_id;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'clinical_files', id, 'INSERT', row_version, test_actor, to_jsonb(f), record_operation_id
  from aa_local.clinical_files as f where id = file_id
  returning id into file_operation_id;

  delete from aa_local.clinical_files where id = file_id and row_version = 1;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  values
    ('clinical_files', file_id, 'DELETE', 2, test_actor,
     jsonb_build_object('id', file_id, 'clinical_record_id', record_id), file_operation_id)
  returning id into file_delete_operation_id;

  update aa_local.pets
  set status = 'inactive', deactivated_at = now(), deactivated_by = test_actor,
      updated_by = test_actor
  where id = pet_id and row_version = 1
  returning row_version into new_version;
  if new_version is distinct from 2 then
    raise exception 'Pet row_version did not increment after update';
  end if;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'pets', id, 'UPDATE', row_version, test_actor, to_jsonb(p), pet_operation_id
  from aa_local.pets as p where id = pet_id
  returning id into pet_update_operation_id;

  update aa_local.clinical_records
  set history = 'Consulta actualizada', updated_by = test_actor
  where id = record_id and row_version = 1
  returning row_version into new_version;
  if new_version is distinct from 2 then
    raise exception 'Record row_version did not increment after update';
  end if;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'clinical_records', id, 'UPDATE', row_version, test_actor, to_jsonb(r), record_operation_id
  from aa_local.clinical_records as r where id = record_id
  returning id into record_update_operation_id;

  update aa_local.vaccinations
  set vaccine_name = 'Rabia actualizada', updated_by = test_actor
  where id = vaccination_id and row_version = 1
  returning row_version into new_version;
  if new_version is distinct from 2 then
    raise exception 'Vaccination row_version did not increment after update';
  end if;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  select 'vaccinations', id, 'UPDATE', row_version, test_actor, to_jsonb(v), vaccination_operation_id
  from aa_local.vaccinations as v where id = vaccination_id
  returning id into vaccination_update_operation_id;

  delete from aa_local.vaccinations where id = vaccination_id and row_version = 2;
  insert into aa_local.sync_operations
    (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
  values
    ('vaccinations', vaccination_id, 'DELETE', 3, test_actor,
     jsonb_build_object('id', vaccination_id, 'pet_id', pet_id), vaccination_update_operation_id)
  returning id into vaccination_delete_operation_id;

  if not exists (
    select 1 from aa_local.sync_operations
    where id = weight_operation_id and depends_on_operation_id = record_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = record_operation_id and depends_on_operation_id = pet_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = file_operation_id and depends_on_operation_id = record_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = file_delete_operation_id and depends_on_operation_id = file_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = pet_update_operation_id and depends_on_operation_id = pet_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = record_update_operation_id and depends_on_operation_id = record_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = vaccination_operation_id and depends_on_operation_id = pet_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = note_operation_id and depends_on_operation_id = pet_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = vaccination_update_operation_id and depends_on_operation_id = vaccination_operation_id
  ) or not exists (
    select 1 from aa_local.sync_operations
    where id = vaccination_delete_operation_id and depends_on_operation_id = vaccination_update_operation_id
  ) then
    raise exception 'Clinical operation dependencies are incorrect';
  end if;

  select count(*) into matching_audits from aa_local.audit_events
  where actor_id = test_actor and action = 'INSERT'
    and entity_table in ('pets', 'clinical_records', 'weight_records', 'clinical_files',
                         'vaccinations', 'pet_notes');
  if matching_audits <> 6 then
    raise exception 'Expected 6 attributed insert audit events, found %', matching_audits;
  end if;
  select count(*) into matching_audits from aa_local.audit_events
  where actor_id = test_actor and action = 'UPDATE'
    and entity_table in ('pets', 'clinical_records', 'vaccinations');
  if matching_audits <> 3 then
    raise exception 'Expected 3 attributed update audit events, found %', matching_audits;
  end if;
  select count(*) into matching_audits from aa_local.audit_events
  where actor_id = test_actor and action = 'DELETE'
    and entity_table in ('vaccinations', 'clinical_files');
  if matching_audits <> 2 then
    raise exception 'Expected 2 attributed delete audit events, found %', matching_audits;
  end if;
  raise notice 'Clinical API write permissions and transaction checks passed';
end;
$$;

reset role;
rollback;
