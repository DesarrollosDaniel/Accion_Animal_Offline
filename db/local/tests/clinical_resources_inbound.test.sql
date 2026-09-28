begin;
set local role aa_local_app;

do $$
declare
  pet_id uuid;
  record_id uuid;
  row_id uuid := gen_random_uuid();
  table_name text;
  snapshot jsonb;
  updated jsonb;
  initial_operations bigint;
begin
  select count(*) into initial_operations from aa_local.sync_operations;
  insert into aa_local.pets (name, guardian_name)
    values ('Recurso ficticio (ROLLBACK)', 'Tutor ficticio') returning id into pet_id;
  insert into aa_local.clinical_records (pet_id, history)
    values (pet_id, 'Consulta ficticia (ROLLBACK)') returning id into record_id;
  insert into aa_local.vaccinations (id, pet_id, vaccine_name, administered_on)
    values (row_id, pet_id, 'Vacuna ficticia', current_date);
  insert into aa_local.medications (id, pet_id, clinical_record_id, name)
    values (row_id, pet_id, record_id, 'Medicamento ficticio');
  insert into aa_local.allergies (id, pet_id, allergen)
    values (row_id, pet_id, 'Alérgeno ficticio');
  insert into aa_local.pet_notes (id, pet_id, body)
    values (row_id, pet_id, 'Nota ficticia');
  insert into aa_local.weight_records (id, pet_id, weight_kg)
    values (row_id, pet_id, 12);
  insert into aa_local.clinical_files (id, clinical_record_id, kind, object_path, original_name, mime_type, size_bytes)
    values (row_id, record_id, 'document', 'uploaded/prueba-rollback.pdf', 'prueba-rollback.pdf', 'application/pdf', 0);

  foreach table_name in array array['vaccinations', 'medications', 'allergies', 'pet_notes', 'weight_records', 'clinical_files'] loop
    execute format('select to_jsonb(t) from aa_local.%I t where id = $1', table_name) into snapshot using row_id;
    execute format('update aa_local.%I t set remote_base = $2, remote_base_version = row_version + 1 where id = $1 returning to_jsonb(t)', table_name)
      into updated using row_id, snapshot;
    if (updated->>'row_version')::bigint <> (snapshot->>'row_version')::bigint + 1
      or updated->>'remote_base_version' <> updated->>'row_version'
      or updated->'remote_base' <> snapshot then
      raise exception 'Referencia o versión incorrecta: %', table_name;
    end if;
    begin
      execute format('update aa_local.%I set remote_base = $2 where id = $1', table_name) using row_id, '{}'::jsonb;
      raise exception 'Se aceptó una referencia sin UUID: %', table_name;
    exception when check_violation then null;
    end;
    begin
      execute format('update aa_local.%I set remote_base_version = row_version + 2 where id = $1', table_name) using row_id;
      raise exception 'Se aceptó una versión futura: %', table_name;
    exception when check_violation then null;
    end;
  end loop;
  if (select count(*) from aa_local.sync_operations) <> initial_operations then
    raise exception 'La recepción creó operaciones de salida';
  end if;
end $$;
rollback;
