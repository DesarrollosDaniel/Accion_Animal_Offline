begin;

do $$
declare
  first_id uuid := gen_random_uuid();
  second_id uuid := gen_random_uuid();
begin
  insert into aa_local.profiles (id, display_name, role) values
    (first_id, 'Dueno temporal A', 'owner'),
    (second_id, 'Dueno temporal B', 'owner');
  if (select count(*) from aa_local.profiles where id in (first_id, second_id) and role = 'owner') <> 2 then
    raise exception 'Both local owners must be preserved';
  end if;
end;
$$;

rollback;
