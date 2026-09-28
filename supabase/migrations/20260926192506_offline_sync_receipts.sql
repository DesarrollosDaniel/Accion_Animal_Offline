begin;

-- Private transport account: provision LOGIN/password separately, never in Git.
create role aa_sync_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant authenticated to aa_sync_worker;
grant aa_sync_worker to postgres;
create schema aa_sync;
revoke all on schema aa_sync from public, anon, authenticated;
grant usage on schema aa_sync to aa_sync_worker;

create table aa_sync.receipts (
  operation_id uuid primary key,
  entity_table text not null check (entity_table in (
    'pets', 'clinical_records', 'clinical_files', 'vaccinations',
    'medications', 'allergies', 'pet_notes', 'weight_records'
  )),
  entity_id uuid not null,
  source_version bigint not null check (source_version > 0),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot jsonb,
  applied_at timestamptz not null default clock_timestamp(),
  unique (entity_table, entity_id, source_version)
);
create index receipts_entity_idx on aa_sync.receipts (entity_table, entity_id, applied_at desc);
alter table aa_sync.receipts enable row level security;
create policy worker_read on aa_sync.receipts for select to aa_sync_worker using (true);
create policy worker_insert on aa_sync.receipts for insert to aa_sync_worker with check (true);
revoke all on aa_sync.receipts from public, anon, authenticated;
grant select, insert on aa_sync.receipts to aa_sync_worker;

commit;
