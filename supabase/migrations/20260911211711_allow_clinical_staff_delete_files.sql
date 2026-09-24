begin;

set local lock_timeout = '5s';

-- Owners and veterinarians may remove individual attachments while editing
-- a clinical record. Reception remains read-only.
drop policy if exists clinical_files_delete_owner on public.clinical_files;
drop policy if exists clinical_files_delete_clinical on public.clinical_files;

create policy clinical_files_delete_clinical
  on public.clinical_files for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

commit;
