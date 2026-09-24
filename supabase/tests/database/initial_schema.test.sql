begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'pets', 'pets table exists');
select has_table('public', 'clinical_records', 'clinical_records table exists');
select has_table('public', 'clinical_files', 'clinical_files table exists');
select has_table('public', 'vaccinations', 'vaccinations table exists');
select has_table('public', 'medications', 'medications table exists');
select has_table('public', 'allergies', 'allergies table exists');
select has_table('public', 'pet_notes', 'pet_notes table exists');
select has_table('public', 'weight_records', 'weight_records table exists');
select has_table('public', 'audit_events', 'audit_events table exists');
select hasnt_table('public', 'owners', 'independent owners table was removed');
select hasnt_table('public', 'appointments', 'appointments table was removed');
select has_column('public', 'pets', 'guardian_name', 'pets store the guardian name');
select has_column('public', 'pets', 'guardian_phone', 'pets store the guardian phone');

select results_eq(
  $$
    select count(*)::bigint
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'profiles', 'pets', 'clinical_records', 'clinical_files',
        'vaccinations', 'medications', 'allergies',
        'pet_notes', 'weight_records', 'audit_events'
      )
      and relation.relrowsecurity
  $$,
  $$ values (10::bigint) $$,
  'RLS is enabled on every public application table'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_policies
    where schemaname = 'public'
  $$,
  $$ values (34::bigint) $$,
  'all public table policies exist'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_policies
    where schemaname = 'storage'
      and (
        policyname like 'pet_photos_%'
        or policyname like 'clinical_storage_%'
      )
  $$,
  $$ values (8::bigint) $$,
  'all Storage policies exist'
);

select results_eq(
  $$
    select count(*)::bigint
    from storage.buckets
    where id in ('pet-photos', 'clinical-files')
  $$,
  $$ values (2::bigint) $$,
  'both Storage buckets exist'
);

select results_eq(
  $$
    select count(*)::bigint
    from storage.buckets
    where (id = 'pet-photos' and public)
       or (id = 'clinical-files' and not public)
  $$,
  $$ values (2::bigint) $$,
  'pet photos are public and clinical files are private'
);

select has_trigger(
  'auth',
  'users',
  'on_auth_user_created',
  'new Auth users receive a safe default profile'
);

select has_index(
  'public',
  'profiles',
  'profiles_single_owner_idx',
  'only one owner profile can exist'
);

select has_function(
  'public',
  'prepare_auth_user_deletion',
  array['uuid'],
  'owner deletion preparation function exists'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_constraint as constraint_record
    join pg_class as source_table on source_table.oid = constraint_record.conrelid
    join pg_namespace as source_schema on source_schema.oid = source_table.relnamespace
    where constraint_record.contype = 'f'
      and constraint_record.confrelid = 'auth.users'::regclass
      and source_schema.nspname = 'public'
      and source_table.relname <> 'profiles'
      and constraint_record.confdeltype <> 'n'
  $$,
  $$ values (0::bigint) $$,
  'user deletion preserves every public activity row'
);

select * from finish();
rollback;
