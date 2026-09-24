begin;

set local lock_timeout = '5s';

-- Preserve the remaining guardian fields from the historical `mascota` table.
alter table public.pets
  add column if not exists guardian_address text,
  add column if not exists referral_source text;

alter table public.pets
  add constraint pets_referral_source_length
    check (referral_source is null or length(referral_source) <= 200);

comment on column public.pets.guardian_address is
  'Historical direccion_d value stored with the pet guardian details.';
comment on column public.pets.referral_source is
  'Historical medio_d value describing how the guardian heard about the clinic.';

commit;
