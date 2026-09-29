select current_database() as database,
       to_regnamespace('aa_local') as local_schema,
       to_regclass('aa_local.pets') as pets_table,
       to_regclass('aa_local.sync_operations') as sync_queue;

select (select count(*) from aa_local.sync_state) as sync_streams,
       (select count(*) from aa_local.pets) as pets,
       (select count(*) from aa_local.sync_operations) as queued_operations,
       has_table_privilege('aa_local_app', 'aa_local.pets', 'SELECT') as app_reads_pets,
       has_table_privilege('aa_local_app', 'aa_local.pets', 'INSERT') as app_writes_pets;
