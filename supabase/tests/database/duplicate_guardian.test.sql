begin;

insert into public.pets (name, guardian_name, guardian_phone)
values
  ('Prueba mascota A', 'Tutor repetido', '5550000000'),
  ('Prueba mascota B', 'Tutor repetido', '5550000000');

select count(*) as duplicate_guardian_rows
from public.pets
where guardian_name = 'Tutor repetido'
  and guardian_phone = '5550000000';

rollback;
