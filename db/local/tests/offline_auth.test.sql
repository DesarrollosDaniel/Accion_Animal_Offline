begin;

do $$
begin
  if current_database() <> 'accion_animal_dev' then raise exception 'Use accion_animal_dev'; end if;
  if not has_table_privilege('aa_local_app', 'aa_local.login_credentials', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Missing application privileges';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace,
    lateral aclexplode(c.relacl) a where n.nspname = 'aa_local'
    and c.relname = 'login_credentials' and a.grantee = 0) then
    raise exception 'Credentials must not be public';
  end if;
end;
$$;

set local role aa_local_app;
insert into aa_local.profiles(id, display_name, role) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Prueba temporal', 'reception');
insert into aa_local.login_credentials(user_id, email, password_salt, password_hash, valid_until)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'temporal@example.test', repeat('a',32), repeat('b',128), now() + interval '7 days');

do $$
begin
  if not exists (select 1 from aa_local.login_credentials where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then
    raise exception 'Credential was not saved';
  end if;
  begin
    update aa_local.login_credentials set password_hash = 'invalid' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'Invalid hash was accepted';
  exception when check_violation then null;
  end;
end;
$$;

select 'Offline auth permissions and constraints passed' as result;
rollback;
