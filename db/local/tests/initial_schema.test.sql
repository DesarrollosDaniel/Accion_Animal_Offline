begin;

do $$
declare
  table_count integer;
  profile_id uuid := gen_random_uuid();
  pet_id uuid;
  first_record_id uuid;
  second_record_id uuid;
begin
  select count(*) into table_count
  from information_schema.tables
  where table_schema = 'aa_local' and table_type = 'BASE TABLE';
  if table_count <> 10 then
    raise exception 'Expected 10 local business tables, found %', table_count;
  end if;

  insert into aa_local.profiles (id, display_name, role)
  values (profile_id, 'Veterinaria de prueba', 'veterinarian');

  insert into aa_local.pets (name, guardian_name, created_by)
  values ('Luna', 'Tutor de prueba', profile_id)
  returning id into pet_id;

  insert into aa_local.clinical_records (pet_id, created_by)
  values (pet_id, profile_id) returning id into first_record_id;
  insert into aa_local.clinical_records (pet_id, created_by)
  values (pet_id, profile_id) returning id into second_record_id;

  insert into aa_local.clinical_files
    (clinical_record_id, kind, object_path, original_name, mime_type, size_bytes)
  values
    (first_record_id, 'photo', 'uploaded/clinicos/shared.jpg', 'shared.jpg', 'image/jpeg', 10),
    (second_record_id, 'photo', 'uploaded/clinicos/shared.jpg', 'shared.jpg', 'image/jpeg', 10);

  begin
    insert into aa_local.clinical_files
      (clinical_record_id, kind, object_path, original_name, mime_type, size_bytes)
    values
      (first_record_id, 'photo', 'uploaded/clinicos/shared.jpg', 'shared.jpg', 'image/jpeg', 10);
    raise exception 'Duplicate file association was accepted';
  exception when unique_violation then
    null;
  end;

  begin
    insert into aa_local.pets (name, guardian_name)
    values ('Sin tutor', ' ');
    raise exception 'Blank guardian name was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into aa_local.pets (name, guardian_name, status)
    values ('Sin baja', 'Tutor', 'inactive');
    raise exception 'Inactive pet without deactivation time was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into aa_local.clinical_records (pet_id)
    values (gen_random_uuid());
    raise exception 'Clinical record without a pet was accepted';
  exception when foreign_key_violation then
    null;
  end;

  delete from aa_local.profiles where id = profile_id;
  if (select created_by from aa_local.pets where id = pet_id) is not null then
    raise exception 'Deleting a profile did not preserve its pet';
  end if;

  raise notice 'Local schema checks passed';
end;
$$;

rollback;
