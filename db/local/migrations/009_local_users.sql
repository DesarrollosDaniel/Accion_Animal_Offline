begin;

do $$
begin
  if current_database() not in ('accion_animal_dev', 'accion_animal_produ') then
    raise exception 'Use an Accion Animal local database';
  end if;
end;
$$;

alter table aa_local.profiles add column local_managed boolean not null default false;
update aa_local.profiles set local_managed = true;
alter table aa_local.login_credentials alter column valid_until set default 'infinity'::timestamptz;
update aa_local.login_credentials set valid_until = 'infinity'::timestamptz;

commit;
