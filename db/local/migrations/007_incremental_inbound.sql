alter table aa_local.sync_state drop constraint sync_state_stream_check;
alter table aa_local.sync_state add constraint sync_state_stream_check
  check (stream in ('business_outbound', 'profiles_inbound', 'business_inbound'));
insert into aa_local.sync_state (stream) values ('business_inbound');

create table aa_local.inbound_retry (
  entity_table text not null check (entity_table in (
    'pets', 'clinical_records', 'clinical_files', 'vaccinations',
    'medications', 'allergies', 'pet_notes', 'weight_records'
  )),
  entity_id uuid not null,
  last_attempt_at timestamptz,
  primary key (entity_table, entity_id)
);
grant select, insert, update, delete on aa_local.inbound_retry to aa_local_app;
