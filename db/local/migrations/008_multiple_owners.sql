begin;

do $$
begin
  if current_database() not in ('accion_animal_dev', 'accion_animal_produ') then
    raise exception 'Use an Accion Animal local database';
  end if;
end;
$$;

drop index if exists aa_local.profiles_single_owner_idx;

commit;
