begin;

-- Schema for the clinic's standalone PostgreSQL server. Keep the UUIDs and
-- clinical constraints aligned with the current Supabase business tables.
-- This database is accessed only by the local API; it does not contain the
-- Supabase auth or storage schemas. API authorization is implemented later.
do $$
begin
  if current_database() in ('postgres', 'template0', 'template1') then
    raise exception 'This migration cannot run in a maintenance or template database';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'aa_local') then
    raise exception 'The aa_local schema already exists; review migration state';
  end if;
end;
$$;

create schema aa_local;
create extension if not exists pg_trgm;

create type aa_local.app_role as enum ('owner', 'veterinarian', 'reception');
create type aa_local.pet_status as enum ('active', 'inactive', 'deceased');
create type aa_local.biological_sex as enum ('male', 'female', 'unknown');
create type aa_local.medication_status as enum ('active', 'completed', 'cancelled');
create type aa_local.allergy_severity as enum ('unknown', 'mild', 'moderate', 'severe');
create type aa_local.clinical_file_kind as enum ('photo', 'document');

-- The id is the Supabase Auth user UUID. Profiles are copied from the cloud;
-- PostgreSQL local deliberately has no foreign key into auth.users.
create table aa_local.profiles (
  id uuid primary key,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role aa_local.app_role not null default 'reception',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_single_owner_idx on aa_local.profiles (role)
  where role = 'owner';
create index profiles_active_role_idx on aa_local.profiles (role) where is_active;

create table aa_local.pets (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  name text not null check (length(btrim(name)) between 1 and 200),
  birth_date date,
  birth_date_is_approximate boolean not null default false,
  color_markings text,
  species text,
  breed text,
  usual_food text,
  sex aa_local.biological_sex,
  is_sterilized boolean,
  sterilization_date date,
  photo_path text,
  status aa_local.pet_status not null default 'active',
  deactivated_at timestamptz,
  deactivated_by uuid references aa_local.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null,
  guardian_name text not null check (length(btrim(guardian_name)) between 1 and 200),
  guardian_phone text check (guardian_phone is null or length(guardian_phone) <= 40),
  guardian_address text,
  guardian_street text check (guardian_street is null or length(guardian_street) <= 200),
  guardian_number text check (guardian_number is null or length(guardian_number) <= 40),
  referral_source text check (referral_source is null or length(referral_source) <= 200),
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

create table aa_local.clinical_records (
  id uuid primary key default gen_random_uuid(),
  legacy_id bigint unique,
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  history text,
  physical_exam text,
  provisional_diagnosis text,
  prognosis text,
  treatment text,
  estimated_cost numeric(12, 2),
  budget_notes text,
  attending_professional text,
  attended_by uuid references aa_local.profiles (id) on delete set null,
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
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null,
  constraint clinical_records_estimated_cost_nonnegative check (
    estimated_cost is null or estimated_cost >= 0
  )
);

-- Paths refer to the server's local file store. The bucket_id value is kept
-- for compatibility with cloud metadata; it does not create a Storage bucket.
create table aa_local.clinical_files (
  id uuid primary key default gen_random_uuid(),
  clinical_record_id uuid not null references aa_local.clinical_records (id) on delete cascade,
  kind aa_local.clinical_file_kind not null,
  bucket_id text not null default 'clinical-files' check (bucket_id = 'clinical-files'),
  object_path text not null check (length(btrim(object_path)) > 0),
  original_name text not null check (length(btrim(original_name)) > 0),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  checksum_sha256 text,
  created_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  constraint clinical_files_checksum_format check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint clinical_files_record_object_path_key unique (clinical_record_id, object_path)
);

create table aa_local.vaccinations (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  vaccine_name text not null check (length(btrim(vaccine_name)) between 1 and 200),
  administered_on date not null,
  next_due_on date,
  batch_number text,
  provider text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null,
  constraint vaccinations_next_due_consistent check (
    next_due_on is null or next_due_on >= administered_on
  )
);

create table aa_local.medications (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  clinical_record_id uuid references aa_local.clinical_records (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  dosage text,
  route text,
  frequency text,
  starts_on date,
  ends_on date,
  instructions text,
  status aa_local.medication_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null,
  constraint medications_date_range check (
    ends_on is null or starts_on is null or ends_on >= starts_on
  )
);

create table aa_local.allergies (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  allergen text not null check (length(btrim(allergen)) between 1 and 200),
  reaction text,
  severity aa_local.allergy_severity not null default 'unknown',
  diagnosed_on date,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null
);

create table aa_local.pet_notes (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null
);

create table aa_local.weight_records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references aa_local.pets (id) on delete cascade,
  measured_at timestamptz not null default now(),
  weight_kg numeric(7, 3) not null check (weight_kg > 0 and weight_kg < 10000),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references aa_local.profiles (id) on delete set null,
  updated_by uuid references aa_local.profiles (id) on delete set null
);

create table aa_local.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references aa_local.profiles (id) on delete set null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  entity_table text not null,
  entity_id uuid,
  occurred_at timestamptz not null default now()
);

-- PostgreSQL does not index foreign key columns automatically.
create index pets_created_by_idx on aa_local.pets (created_by) where created_by is not null;
create index pets_updated_by_idx on aa_local.pets (updated_by) where updated_by is not null;
create index pets_deactivated_by_idx on aa_local.pets (deactivated_by) where deactivated_by is not null;
create index clinical_records_pet_occurred_idx on aa_local.clinical_records (pet_id, occurred_at desc);
create index clinical_records_attended_by_idx on aa_local.clinical_records (attended_by) where attended_by is not null;
create index clinical_records_created_by_idx on aa_local.clinical_records (created_by) where created_by is not null;
create index clinical_records_updated_by_idx on aa_local.clinical_records (updated_by) where updated_by is not null;
create index clinical_files_record_idx on aa_local.clinical_files (clinical_record_id, created_at);
create index clinical_files_created_by_idx on aa_local.clinical_files (created_by) where created_by is not null;
create index vaccinations_pet_date_idx on aa_local.vaccinations (pet_id, administered_on desc);
create index vaccinations_created_by_idx on aa_local.vaccinations (created_by) where created_by is not null;
create index vaccinations_updated_by_idx on aa_local.vaccinations (updated_by) where updated_by is not null;
create index medications_pet_status_idx on aa_local.medications (pet_id, status);
create index medications_record_idx on aa_local.medications (clinical_record_id) where clinical_record_id is not null;
create index medications_created_by_idx on aa_local.medications (created_by) where created_by is not null;
create index medications_updated_by_idx on aa_local.medications (updated_by) where updated_by is not null;
create index allergies_pet_active_idx on aa_local.allergies (pet_id, is_active);
create index allergies_created_by_idx on aa_local.allergies (created_by) where created_by is not null;
create index allergies_updated_by_idx on aa_local.allergies (updated_by) where updated_by is not null;
create index pet_notes_pet_created_idx on aa_local.pet_notes (pet_id, created_at desc);
create index pet_notes_created_by_idx on aa_local.pet_notes (created_by) where created_by is not null;
create index pet_notes_updated_by_idx on aa_local.pet_notes (updated_by) where updated_by is not null;
create index weight_records_pet_measured_idx on aa_local.weight_records (pet_id, measured_at desc);
create index weight_records_created_by_idx on aa_local.weight_records (created_by) where created_by is not null;
create index weight_records_updated_by_idx on aa_local.weight_records (updated_by) where updated_by is not null;
create index audit_events_actor_idx on aa_local.audit_events (actor_id, occurred_at desc) where actor_id is not null;
create index audit_events_entity_idx on aa_local.audit_events (entity_table, entity_id, occurred_at desc);

create index pets_name_trgm_idx on aa_local.pets using gin (lower(name) gin_trgm_ops);
create index pets_guardian_name_trgm_idx on aa_local.pets using gin (lower(guardian_name) gin_trgm_ops);
create index pets_guardian_phone_idx on aa_local.pets (guardian_phone) where guardian_phone is not null;

create function aa_local.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'profiles', 'pets', 'clinical_records', 'vaccinations', 'medications',
    'allergies', 'pet_notes', 'weight_records'
  ] loop
    execute format(
      'create trigger %I before update on aa_local.%I for each row execute function aa_local.set_updated_at()',
      table_name || '_set_updated_at', table_name
    );
  end loop;
end;
$$;

commit;
