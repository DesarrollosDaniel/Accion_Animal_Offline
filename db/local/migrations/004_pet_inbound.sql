begin;
do $$
begin
  if current_database() not in ('accion_animal_dev', 'accion_animal_produ') then
    raise exception 'Esta migración solo corresponde a una base local de Accion Animal';
  end if;
end $$;
-- Keep the last imported cloud version alongside the local version.
-- It travels only in the private outbox, never as a writable API field.
alter table aa_local.pets
  add column remote_base jsonb,
  add column remote_base_version bigint,
  add constraint pets_remote_base_valid check (
    (remote_base is null and remote_base_version is null)
    or (remote_base is not null and remote_base_version is not null
      and jsonb_typeof(remote_base) = 'object' and (remote_base->>'id') is not distinct from id::text
      and remote_base_version > 0 and remote_base_version <= row_version)
  );
commit;
