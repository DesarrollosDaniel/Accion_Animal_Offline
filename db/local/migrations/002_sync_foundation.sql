begin;

do $$
begin
  if current_database() in ('postgres', 'template0', 'template1') then
    raise exception 'This migration cannot run in a maintenance or template database';
  end if;
  if to_regclass('aa_local.profiles') is null
     or to_regclass('aa_local.audit_events') is null then
    raise exception 'Apply 001_initial_schema.sql first';
  end if;
  if to_regclass('aa_local.sync_operations') is not null then
    raise exception 'The sync foundation already exists; review migration state';
  end if;
  if exists (
    select 1 from pg_roles
    where rolname in ('aa_local_app', 'aa_local_migrator')
  ) then
    raise exception 'An Acción Animal local role already exists; review role ownership';
  end if;
end;
$$;

-- No password or LOGIN is provisioned by a versioned SQL file. The migrator
-- owns schema objects; the application receives only the grants below.
create role aa_local_migrator nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role aa_local_app nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

create type aa_local.sync_action as enum ('INSERT', 'UPDATE', 'DELETE');
create type aa_local.sync_status as enum (
  'pending', 'in_progress', 'confirmed', 'blocked', 'conflict'
);
create type aa_local.sync_error_kind as enum ('temporary', 'permanent', 'conflict');

-- A local row version gives each change a stable origin version. The server
-- must write the business change and its outbox operation in one transaction.
alter table aa_local.pets add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.clinical_records add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.clinical_files add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.vaccinations add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.medications add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.allergies add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.pet_notes add column row_version bigint not null default 1 check (row_version > 0);
alter table aa_local.weight_records add column row_version bigint not null default 1 check (row_version > 0);

create function aa_local.bump_row_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.row_version := old.row_version + 1;
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'pets', 'clinical_records', 'clinical_files', 'vaccinations',
    'medications', 'allergies', 'pet_notes', 'weight_records'
  ] loop
    execute format(
      'create trigger %I before update on aa_local.%I for each row execute function aa_local.bump_row_version()',
      table_name || '_bump_row_version', table_name
    );
  end loop;
end;
$$;

create table aa_local.sync_operations (
  id uuid primary key default gen_random_uuid(),
  entity_table text not null check (entity_table in (
    'pets', 'clinical_records', 'clinical_files', 'vaccinations',
    'medications', 'allergies', 'pet_notes', 'weight_records'
  )),
  entity_id uuid not null,
  action aa_local.sync_action not null,
  source_version bigint not null check (source_version > 0),
  actor_id uuid references aa_local.profiles (id) on delete set null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  depends_on_operation_id uuid references aa_local.sync_operations (id) on delete restrict,
  status aa_local.sync_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sync_operations_entity_version_key unique (entity_table, entity_id, source_version),
  constraint sync_operations_no_self_dependency check (depends_on_operation_id is distinct from id)
);

create index sync_operations_pending_idx
  on aa_local.sync_operations (available_at, created_at)
  where status = 'pending';
create index sync_operations_actor_idx
  on aa_local.sync_operations (actor_id) where actor_id is not null;
create index sync_operations_dependency_idx
  on aa_local.sync_operations (depends_on_operation_id)
  where depends_on_operation_id is not null;

-- Remote acknowledgement remains durable even after the operation is marked
-- confirmed locally. Replayed operation IDs must be deduplicated remotely.
create table aa_local.sync_confirmations (
  operation_id uuid primary key references aa_local.sync_operations (id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  remote_entity_id uuid,
  remote_version bigint check (remote_version is null or remote_version > 0),
  response jsonb not null default '{}'::jsonb check (jsonb_typeof(response) = 'object')
);

create table aa_local.sync_errors (
  id bigint generated always as identity primary key,
  operation_id uuid not null references aa_local.sync_operations (id) on delete restrict,
  kind aa_local.sync_error_kind not null,
  error_code text,
  message text not null check (length(btrim(message)) > 0),
  occurred_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index sync_errors_operation_time_idx
  on aa_local.sync_errors (operation_id, occurred_at desc);
create index sync_errors_unresolved_idx
  on aa_local.sync_errors (occurred_at desc) where resolved_at is null;

create table aa_local.sync_state (
  stream text primary key check (stream in ('business_outbound', 'profiles_inbound')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  cursor text,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into aa_local.sync_state (stream)
values ('business_outbound'), ('profiles_inbound');

-- Clinical changes are audited even if a later worker retry is needed. The
-- validated API will SET LOCAL aa.actor_id inside each business transaction.
-- The database login is private to the server; this setting is not a client
-- authorization check.
create function aa_local.log_business_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_id uuid;
  actor uuid;
begin
  affected_id := case when tg_op = 'DELETE' then old.id else new.id end;
  actor := nullif(current_setting('aa.actor_id', true), '')::uuid;
  insert into aa_local.audit_events (actor_id, action, entity_table, entity_id)
  values (actor, tg_op, tg_table_name, affected_id);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function aa_local.log_business_change() from public;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'pets', 'clinical_records', 'clinical_files', 'vaccinations',
    'medications', 'allergies', 'pet_notes', 'weight_records'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on aa_local.%I for each row execute function aa_local.log_business_change()',
      table_name || '_log_change', table_name
    );
  end loop;
end;
$$;

-- Move ownership of all local objects away from the application login. The
-- owner role has no LOGIN until its password is provisioned outside Git.
do $$
declare object_name text;
begin
  for object_name in
    select t.typname
    from pg_type as t
    join pg_namespace as n on n.oid = t.typnamespace
    where n.nspname = 'aa_local' and t.typtype = 'e'
  loop
    execute format('alter type aa_local.%I owner to aa_local_migrator', object_name);
  end loop;

  for object_name in
    select tablename from pg_tables where schemaname = 'aa_local'
  loop
    execute format('alter table aa_local.%I owner to aa_local_migrator', object_name);
  end loop;
end;
$$;

alter function aa_local.set_updated_at() owner to aa_local_migrator;
alter function aa_local.bump_row_version() owner to aa_local_migrator;
alter function aa_local.log_business_change() owner to aa_local_migrator;
alter schema aa_local owner to aa_local_migrator;

revoke all on schema aa_local from public;
grant usage on schema aa_local to aa_local_app;
grant select, insert, update on aa_local.profiles to aa_local_app;
grant select, insert, update, delete on
  aa_local.pets, aa_local.clinical_records, aa_local.clinical_files,
  aa_local.vaccinations, aa_local.medications, aa_local.allergies,
  aa_local.pet_notes, aa_local.weight_records to aa_local_app;
grant select on aa_local.audit_events to aa_local_app;
grant select, insert on aa_local.sync_operations to aa_local_app;
grant update (status, attempt_count, available_at, last_attempt_at)
  on aa_local.sync_operations to aa_local_app;
grant select, insert on aa_local.sync_confirmations to aa_local_app;
grant select, insert on aa_local.sync_errors to aa_local_app;
grant update (resolved_at) on aa_local.sync_errors to aa_local_app;
grant select, update on aa_local.sync_state to aa_local_app;
grant usage on sequence aa_local.sync_errors_id_seq to aa_local_app;

commit;
