begin;

do $$
begin
  if current_database() not in ('accion_animal_dev', 'accion_animal_produ') then
    raise exception 'Use an Accion Animal local database';
  end if;
end;
$$;

create table aa_local.login_credentials (
  user_id uuid primary key references aa_local.profiles(id) on delete cascade,
  email text not null unique check (email = lower(btrim(email)) and length(email) <= 254),
  password_salt text not null check (length(password_salt) = 32),
  password_hash text not null check (length(password_hash) = 128),
  verified_at timestamptz not null default now(),
  valid_until timestamptz not null
);
alter table aa_local.login_credentials owner to aa_local_migrator;
revoke all on aa_local.login_credentials from public;
grant select, insert, update, delete on aa_local.login_credentials to aa_local_app;

commit;
