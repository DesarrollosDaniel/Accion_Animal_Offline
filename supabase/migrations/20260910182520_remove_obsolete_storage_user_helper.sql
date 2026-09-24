begin;

-- Files are now stored on the local Windows server. The public SECURITY
-- DEFINER helper that detached Supabase Storage ownership is no longer needed.
drop function if exists public.prepare_auth_user_deletion(uuid);

commit;
