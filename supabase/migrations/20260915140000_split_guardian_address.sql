begin;

alter table public.pets
  add column if not exists guardian_street text,
  add column if not exists guardian_number text,
  add constraint pets_guardian_street_length check (guardian_street is null or length(guardian_street) <= 200),
  add constraint pets_guardian_number_length check (guardian_number is null or length(guardian_number) <= 40);

comment on column public.pets.guardian_address is
  'Guardian neighborhood (colonia). Historical full-address values are preserved unchanged.';
comment on column public.pets.guardian_street is
  'Guardian street, optional for new and edited records.';
comment on column public.pets.guardian_number is
  'Guardian street number, optional for new and edited records.';

commit;
