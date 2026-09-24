begin;

set local lock_timeout = '5s';

-- Tutor data belongs to each pet. Repeated names and phone numbers are valid.
alter table public.pets
  add column guardian_name text,
  add column guardian_phone text;

-- Preserve existing data if this migration is replayed in an environment where
-- pets were already registered under the previous normalized model.
update public.pets as pet
set
  guardian_name = owner.full_name,
  guardian_phone = owner.phone
from public.owners as owner
where owner.id = pet.owner_id;

alter table public.pets
  alter column guardian_name set not null,
  add constraint pets_guardian_name_length
    check (length(btrim(guardian_name)) between 1 and 200),
  add constraint pets_guardian_phone_length
    check (guardian_phone is null or length(guardian_phone) <= 40);

create index pets_guardian_name_trgm_idx
  on public.pets using gin (lower(guardian_name) extensions.gin_trgm_ops);

create index pets_guardian_phone_idx
  on public.pets (guardian_phone)
  where guardian_phone is not null;

-- The application no longer maintains independent tutors or appointments.
drop table public.appointments;
alter table public.pets drop column owner_id;
drop table public.owners;

commit;
