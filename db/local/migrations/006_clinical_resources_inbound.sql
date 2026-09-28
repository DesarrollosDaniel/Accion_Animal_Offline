begin;
do $$
begin
  if current_database() <> 'accion_animal_dev' then
    raise exception 'Esta migración solo corresponde a accion_animal_dev';
  end if;
end $$;
-- Same protected cloud baseline as pets and clinical records.
alter table aa_local.vaccinations
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint vaccinations_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );

alter table aa_local.medications
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint medications_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );

alter table aa_local.allergies
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint allergies_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );

alter table aa_local.pet_notes
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint pet_notes_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );

alter table aa_local.weight_records
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint weight_records_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );

alter table aa_local.clinical_files
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint clinical_files_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );
commit;
