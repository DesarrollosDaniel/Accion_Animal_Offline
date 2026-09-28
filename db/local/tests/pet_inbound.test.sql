begin;
set local role aa_local_app;
do $$
declare
  pet aa_local.pets;
  initial_version bigint;
  initial_operations bigint;
begin
  select * into pet from aa_local.pets order by id limit 1 for update;
  if pet.id is null then raise exception 'La prueba requiere una mascota ficticia existente'; end if;
  initial_version := pet.row_version;
  select count(*) into initial_operations from aa_local.sync_operations;
  update aa_local.pets set remote_base = to_jsonb(pet),
    remote_base_version = row_version + 1 where id = pet.id;
  select * into pet from aa_local.pets where id = pet.id;
  if pet.row_version <> initial_version + 1 or pet.remote_base_version <> pet.row_version then
    raise exception 'No se conservó la versión de recepción';
  end if;
  if (select count(*) from aa_local.sync_operations) <> initial_operations then
    raise exception 'La recepción creó una operación de salida';
  end if;
  begin
    update aa_local.pets set remote_base = '{}'::jsonb where id = pet.id;
    raise exception 'Se aceptó una base sin identificador';
  exception when check_violation then null;
  end;
end $$;
rollback;
