select jsonb_build_object(
  'application_tables', (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relname in (
        'profiles', 'pets', 'clinical_records', 'clinical_files',
        'vaccinations', 'medications', 'allergies',
        'pet_notes', 'weight_records', 'audit_events'
      )
  ),
  'rls_tables', (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relrowsecurity
      and relation.relname in (
        'profiles', 'pets', 'clinical_records', 'clinical_files',
        'vaccinations', 'medications', 'allergies',
        'pet_notes', 'weight_records', 'audit_events'
      )
  ),
  'public_policies', (
    select count(*)
    from pg_policies
    where schemaname = 'public'
  ),
  'storage_policies', (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and (
        policyname like 'pet_photos_%'
        or policyname like 'clinical_storage_%'
      )
  ),
  'storage_buckets', (
    select count(*)
    from storage.buckets
    where id in ('pet-photos', 'clinical-files')
  ),
  'public_pet_photos', coalesce((
    select public
    from storage.buckets
    where id = 'pet-photos'
  ), false),
  'private_clinical_files', coalesce((
    select not public
    from storage.buckets
    where id = 'clinical-files'
  ), false),
  'auth_user_trigger', exists (
    select 1
    from pg_trigger as trigger
    join pg_class as relation on relation.oid = trigger.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'auth'
      and relation.relname = 'users'
      and trigger.tgname = 'on_auth_user_created'
      and not trigger.tgisinternal
  ),
  'single_owner_index', to_regclass('public.profiles_single_owner_idx') is not null
  , 'guardian_name_column', exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pets' and column_name = 'guardian_name'
  )
  , 'guardian_phone_column', exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pets' and column_name = 'guardian_phone'
  )
  , 'owners_removed', to_regclass('public.owners') is null
  , 'appointments_removed', to_regclass('public.appointments') is null
  , 'user_deletion_helper', to_regprocedure('public.prepare_auth_user_deletion(uuid)') is not null
  , 'activity_fks_preserved', not exists (
    select 1
    from pg_constraint as constraint_record
    join pg_class as source_table on source_table.oid = constraint_record.conrelid
    join pg_namespace as source_schema on source_schema.oid = source_table.relnamespace
    where constraint_record.contype = 'f'
      and constraint_record.confrelid = 'auth.users'::regclass
      and source_schema.nspname = 'public'
      and source_table.relname <> 'profiles'
      and constraint_record.confdeltype <> 'n'
  )
) as verification;
