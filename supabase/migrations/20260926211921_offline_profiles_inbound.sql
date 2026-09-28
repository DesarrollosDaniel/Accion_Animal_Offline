begin;
-- Server-only transport reads access profiles; no access to Auth credentials.
grant usage on schema public to aa_sync_worker;
grant select (id, display_name, role, is_active, created_at, updated_at) on public.profiles to aa_sync_worker;
create policy profiles_sync_read on public.profiles for select to aa_sync_worker using (true);
commit;
