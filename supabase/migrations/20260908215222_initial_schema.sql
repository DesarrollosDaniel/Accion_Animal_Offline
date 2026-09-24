begin;

-- Extensions used for accent-insensitive and partial-name searches.
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon;

create type public.app_role as enum ('owner', 'veterinarian', 'reception');
create type public.pet_status as enum ('active', 'inactive', 'deceased');
create type public.biological_sex as enum ('male', 'female', 'unknown');
create type public.appointment_status as enum (
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no_show'
);
create type public.medication_status as enum ('active', 'completed', 'cancelled');
create type public.allergy_severity as enum ('unknown', 'mild', 'moderate', 'severe');
create type public.clinical_file_kind as enum ('photo', 'document');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role public.app_role not null default 'reception',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The organization has one account owner. Ownership can be transferred by
-- changing the current row before assigning owner to another profile.
create unique index profiles_single_owner_idx
  on public.profiles (role)
  where role = 'owner';
create index profiles_active_role_idx on public.profiles (role) where is_active;

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  full_name text not null check (length(btrim(full_name)) between 1 and 200),
  phone text,
  alternate_phone text,
  email text,
  address text,
  referral_source text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint owners_phone_length check (phone is null or length(phone) <= 40),
  constraint owners_alternate_phone_length check (alternate_phone is null or length(alternate_phone) <= 40),
  constraint owners_email_length check (email is null or length(email) <= 320)
);

create table public.pets (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  owner_id uuid not null references public.owners (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  birth_date date,
  birth_date_is_approximate boolean not null default false,
  color_markings text,
  species text,
  breed text,
  usual_food text,
  sex public.biological_sex,
  is_sterilized boolean,
  sterilization_date date,
  photo_path text,
  status public.pet_status not null default 'active',
  deactivated_at timestamptz,
  deactivated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint pets_species_length check (species is null or length(species) <= 100),
  constraint pets_breed_length check (breed is null or length(breed) <= 120),
  constraint pets_sterilization_date_consistent check (
    sterilization_date is null or is_sterilized is true
  ),
  constraint pets_deactivation_consistent check (
    (status = 'active' and deactivated_at is null)
    or (status <> 'active' and deactivated_at is not null)
  )
);

create table public.clinical_records (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  pet_id uuid not null references public.pets (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  history text,
  physical_exam text,
  provisional_diagnosis text,
  prognosis text,
  treatment text,
  estimated_cost numeric(12, 2),
  budget_notes text,
  attending_professional text,
  attended_by uuid references auth.users (id) on delete set null,
  temperature_observation text,
  heart_rate_observation text,
  respiratory_rate_observation text,
  hydration_observation text,
  lymph_nodes_observation text,
  capillary_refill_observation text,
  vomiting boolean,
  vomiting_notes text,
  diarrhea boolean,
  diarrhea_notes text,
  legacy_photo_directory text,
  legacy_file_directory text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint clinical_records_estimated_cost_nonnegative check (
    estimated_cost is null or estimated_cost >= 0
  )
);

create table public.clinical_files (
  id uuid primary key default gen_random_uuid(),
  clinical_record_id uuid not null references public.clinical_records (id) on delete cascade,
  kind public.clinical_file_kind not null,
  bucket_id text not null default 'clinical-files' check (bucket_id = 'clinical-files'),
  object_path text not null unique check (length(btrim(object_path)) > 0),
  original_name text not null check (length(btrim(original_name)) > 0),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  checksum_sha256 text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint clinical_files_checksum_format check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table public.vaccinations (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  vaccine_name text not null check (length(btrim(vaccine_name)) between 1 and 200),
  administered_on date not null,
  next_due_on date,
  batch_number text,
  provider text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint vaccinations_next_due_consistent check (
    next_due_on is null or next_due_on >= administered_on
  )
);

create table public.medications (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  clinical_record_id uuid references public.clinical_records (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  dosage text,
  route text,
  frequency text,
  starts_on date,
  ends_on date,
  instructions text,
  status public.medication_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint medications_date_range check (
    ends_on is null or starts_on is null or ends_on >= starts_on
  )
);

create table public.allergies (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  allergen text not null check (length(btrim(allergen)) between 1 and 200),
  reaction text,
  severity public.allergy_severity not null default 'unknown',
  diagnosed_on date,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz,
  reason text,
  status public.appointment_status not null default 'scheduled',
  assigned_to uuid references auth.users (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint appointments_time_range check (ends_at is null or ends_at > starts_at)
);

create table public.pet_notes (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table public.weight_records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  measured_at timestamptz not null default now(),
  weight_kg numeric(7, 3) not null check (weight_kg > 0 and weight_kg < 10000),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  entity_table text not null,
  entity_id uuid,
  occurred_at timestamptz not null default now()
);

-- Foreign keys are not indexed automatically by PostgreSQL.
create index owners_created_by_idx on public.owners (created_by) where created_by is not null;
create index owners_updated_by_idx on public.owners (updated_by) where updated_by is not null;
create index pets_owner_id_idx on public.pets (owner_id);
create index pets_created_by_idx on public.pets (created_by) where created_by is not null;
create index pets_updated_by_idx on public.pets (updated_by) where updated_by is not null;
create index pets_deactivated_by_idx on public.pets (deactivated_by) where deactivated_by is not null;
create index clinical_records_pet_occurred_idx on public.clinical_records (pet_id, occurred_at desc);
create index clinical_records_attended_by_idx on public.clinical_records (attended_by) where attended_by is not null;
create index clinical_records_created_by_idx on public.clinical_records (created_by) where created_by is not null;
create index clinical_records_updated_by_idx on public.clinical_records (updated_by) where updated_by is not null;
create index clinical_files_record_idx on public.clinical_files (clinical_record_id, created_at);
create index clinical_files_created_by_idx on public.clinical_files (created_by) where created_by is not null;
create index vaccinations_pet_date_idx on public.vaccinations (pet_id, administered_on desc);
create index vaccinations_created_by_idx on public.vaccinations (created_by) where created_by is not null;
create index vaccinations_updated_by_idx on public.vaccinations (updated_by) where updated_by is not null;
create index medications_pet_status_idx on public.medications (pet_id, status);
create index medications_record_idx on public.medications (clinical_record_id) where clinical_record_id is not null;
create index medications_created_by_idx on public.medications (created_by) where created_by is not null;
create index medications_updated_by_idx on public.medications (updated_by) where updated_by is not null;
create index allergies_pet_active_idx on public.allergies (pet_id, is_active);
create index allergies_created_by_idx on public.allergies (created_by) where created_by is not null;
create index allergies_updated_by_idx on public.allergies (updated_by) where updated_by is not null;
create index appointments_starts_at_idx on public.appointments (starts_at);
create index appointments_pet_starts_idx on public.appointments (pet_id, starts_at desc);
create index appointments_status_starts_idx on public.appointments (status, starts_at);
create index appointments_assigned_to_idx on public.appointments (assigned_to) where assigned_to is not null;
create index appointments_created_by_idx on public.appointments (created_by) where created_by is not null;
create index appointments_updated_by_idx on public.appointments (updated_by) where updated_by is not null;
create index pet_notes_pet_created_idx on public.pet_notes (pet_id, created_at desc);
create index pet_notes_created_by_idx on public.pet_notes (created_by) where created_by is not null;
create index pet_notes_updated_by_idx on public.pet_notes (updated_by) where updated_by is not null;
create index weight_records_pet_measured_idx on public.weight_records (pet_id, measured_at desc);
create index weight_records_created_by_idx on public.weight_records (created_by) where created_by is not null;
create index weight_records_updated_by_idx on public.weight_records (updated_by) where updated_by is not null;
create index audit_events_actor_idx on public.audit_events (actor_id, occurred_at desc) where actor_id is not null;
create index audit_events_entity_idx on public.audit_events (entity_table, entity_id, occurred_at desc);

-- Search indexes used by the pet/owner finder.
create index owners_full_name_trgm_idx
  on public.owners using gin (lower(full_name) extensions.gin_trgm_ops);
create index owners_phone_idx on public.owners (phone) where phone is not null;
create index pets_name_trgm_idx
  on public.pets using gin (lower(name) extensions.gin_trgm_ops);
create index pets_active_owner_idx on public.pets (owner_id, name) where status = 'active';

-- Auth and authorization helpers live outside the exposed API schema.
create or replace function private.has_role(required_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.is_active
        and profile.role = any(required_roles)
    );
$$;

create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.has_role(
    array['owner', 'veterinarian', 'reception']::public.app_role[]
  ));
$$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  requested_name := nullif(btrim(new.raw_user_meta_data ->> 'display_name'), '');

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(requested_name, nullif(split_part(new.email, '@', 1), ''), 'Usuario'),
    'reception'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create or replace function private.set_updated_at_and_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, (select auth.uid()));
  end if;

  return new;
end;
$$;

create or replace function private.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.guard_pet_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
     or old.deactivated_at is distinct from new.deactivated_at
     or old.deactivated_by is distinct from new.deactivated_by then
    if (select auth.uid()) is not null
       and not (select private.has_role(
         array['owner', 'veterinarian']::public.app_role[]
       )) then
      raise exception 'Only veterinarians or the owner can change pet status'
        using errcode = '42501';
    end if;

    if new.status = 'active' then
      new.deactivated_at := null;
      new.deactivated_by := null;
    else
      new.deactivated_at := coalesce(new.deactivated_at, now());
      new.deactivated_by := coalesce((select auth.uid()), new.deactivated_by);
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_id uuid;
begin
  affected_id := case when tg_op = 'DELETE' then old.id else new.id end;

  insert into public.audit_events (actor_id, action, entity_table, entity_id)
  values ((select auth.uid()), tg_op, tg_table_name, affected_id);

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_profile_updated_at();

create trigger pets_guard_status
  before update on public.pets
  for each row execute function private.guard_pet_status_change();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'owners',
    'pets',
    'clinical_records',
    'vaccinations',
    'medications',
    'allergies',
    'appointments',
    'pet_notes',
    'weight_records'
  ]
  loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function private.set_updated_at_and_actor()',
      table_name || '_set_audit_fields',
      table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'owners',
    'pets',
    'clinical_records',
    'clinical_files',
    'vaccinations',
    'medications',
    'allergies',
    'appointments',
    'pet_notes',
    'weight_records'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.log_row_change()',
      table_name || '_audit_event',
      table_name
    );
  end loop;
end;
$$;

-- Explicit Data API privileges (required by new Supabase projects).
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated, service_role;
grant usage on schema private to authenticated;
grant usage on type public.app_role,
  public.pet_status,
  public.biological_sex,
  public.appointment_status,
  public.medication_status,
  public.allergy_severity,
  public.clinical_file_kind
to authenticated, service_role;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on
  public.owners,
  public.pets,
  public.clinical_records,
  public.clinical_files,
  public.vaccinations,
  public.medications,
  public.allergies,
  public.appointments,
  public.pet_notes,
  public.weight_records
to authenticated;
grant select on public.audit_events to authenticated;
grant usage, select on sequence public.audit_events_id_seq to authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function private.has_role(public.app_role[]) from public, anon, authenticated, service_role;
revoke all on function private.is_active_user() from public, anon, authenticated, service_role;
revoke all on function private.handle_new_auth_user() from public, anon, authenticated, service_role;
revoke all on function private.set_updated_at_and_actor() from public, anon, authenticated, service_role;
revoke all on function private.set_profile_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.guard_pet_status_change() from public, anon, authenticated, service_role;
revoke all on function private.log_row_change() from public, anon, authenticated, service_role;
grant execute on function private.has_role(public.app_role[]) to authenticated;
grant execute on function private.is_active_user() to authenticated;

-- Row-level security is enabled on every exposed table.
alter table public.profiles enable row level security;
alter table public.owners enable row level security;
alter table public.pets enable row level security;
alter table public.clinical_records enable row level security;
alter table public.clinical_files enable row level security;
alter table public.vaccinations enable row level security;
alter table public.medications enable row level security;
alter table public.allergies enable row level security;
alter table public.appointments enable row level security;
alter table public.pet_notes enable row level security;
alter table public.weight_records enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_read_active_users
  on public.profiles for select to authenticated
  using ((select private.is_active_user()));

create policy owners_read_active_users
  on public.owners for select to authenticated
  using ((select private.is_active_user()));
create policy owners_insert_staff
  on public.owners for insert to authenticated
  with check ((select private.is_active_user()));
create policy owners_update_staff
  on public.owners for update to authenticated
  using ((select private.is_active_user()))
  with check ((select private.is_active_user()));
create policy owners_delete_clinical
  on public.owners for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy pets_read_active_users
  on public.pets for select to authenticated
  using ((select private.is_active_user()));
create policy pets_insert_staff
  on public.pets for insert to authenticated
  with check (
    (select private.is_active_user())
    and (
      status = 'active'
      or (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
    )
  );
create policy pets_update_staff
  on public.pets for update to authenticated
  using ((select private.is_active_user()))
  with check ((select private.is_active_user()));
create policy pets_delete_clinical
  on public.pets for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy clinical_records_read_active_users
  on public.clinical_records for select to authenticated
  using ((select private.is_active_user()));
create policy clinical_records_insert_clinical
  on public.clinical_records for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy clinical_records_update_clinical
  on public.clinical_records for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy clinical_records_delete_clinical
  on public.clinical_records for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy clinical_files_read_active_users
  on public.clinical_files for select to authenticated
  using ((select private.is_active_user()));
create policy clinical_files_insert_clinical
  on public.clinical_files for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy clinical_files_update_clinical
  on public.clinical_files for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy clinical_files_delete_clinical
  on public.clinical_files for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy vaccinations_read_active_users
  on public.vaccinations for select to authenticated
  using ((select private.is_active_user()));
create policy vaccinations_insert_clinical
  on public.vaccinations for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy vaccinations_update_clinical
  on public.vaccinations for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy vaccinations_delete_clinical
  on public.vaccinations for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy medications_read_active_users
  on public.medications for select to authenticated
  using ((select private.is_active_user()));
create policy medications_insert_clinical
  on public.medications for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy medications_update_clinical
  on public.medications for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy medications_delete_clinical
  on public.medications for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy allergies_read_active_users
  on public.allergies for select to authenticated
  using ((select private.is_active_user()));
create policy allergies_insert_clinical
  on public.allergies for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy allergies_update_clinical
  on public.allergies for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy allergies_delete_clinical
  on public.allergies for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy appointments_read_active_users
  on public.appointments for select to authenticated
  using ((select private.is_active_user()));
create policy appointments_insert_staff
  on public.appointments for insert to authenticated
  with check ((select private.is_active_user()));
create policy appointments_update_staff
  on public.appointments for update to authenticated
  using ((select private.is_active_user()))
  with check ((select private.is_active_user()));
create policy appointments_delete_clinical
  on public.appointments for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy pet_notes_read_active_users
  on public.pet_notes for select to authenticated
  using ((select private.is_active_user()));
create policy pet_notes_insert_clinical
  on public.pet_notes for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy pet_notes_update_clinical
  on public.pet_notes for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy pet_notes_delete_clinical
  on public.pet_notes for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy weight_records_read_active_users
  on public.weight_records for select to authenticated
  using ((select private.is_active_user()));
create policy weight_records_insert_clinical
  on public.weight_records for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy weight_records_update_clinical
  on public.weight_records for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));
create policy weight_records_delete_clinical
  on public.weight_records for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy audit_events_read_owner
  on public.audit_events for select to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

-- Storage configuration. Objects must be deleted through the Storage API,
-- never by directly deleting rows from storage.objects.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values
  (
    'pet-photos',
    'pet-photos',
    true,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp']
  ),
  (
    'clinical-files',
    'clinical-files',
    false,
    26214400,
    array[
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ]
  )
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy pet_photos_read_active_users
  on storage.objects for select to authenticated
  using (bucket_id = 'pet-photos' and (select private.is_active_user()));
create policy pet_photos_insert_staff
  on storage.objects for insert to authenticated
  with check (bucket_id = 'pet-photos' and (select private.is_active_user()));
create policy pet_photos_update_staff
  on storage.objects for update to authenticated
  using (bucket_id = 'pet-photos' and (select private.is_active_user()))
  with check (bucket_id = 'pet-photos' and (select private.is_active_user()));
create policy pet_photos_delete_clinical
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'pet-photos'
    and (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
  );

create policy clinical_storage_read_active_users
  on storage.objects for select to authenticated
  using (bucket_id = 'clinical-files' and (select private.is_active_user()));
create policy clinical_storage_insert_clinical
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'clinical-files'
    and (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
  );
create policy clinical_storage_update_clinical
  on storage.objects for update to authenticated
  using (
    bucket_id = 'clinical-files'
    and (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
  )
  with check (
    bucket_id = 'clinical-files'
    and (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
  );
create policy clinical_storage_delete_clinical
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'clinical-files'
    and (select private.has_role(array['owner', 'veterinarian']::public.app_role[]))
  );

commit;
