begin;

set local lock_timeout = '5s';

drop policy if exists pets_delete_owner on public.pets;
drop policy if exists pets_delete_clinical on public.pets;
create policy pets_delete_clinical
  on public.pets for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

drop policy if exists clinical_records_delete_owner on public.clinical_records;
drop policy if exists clinical_records_delete_clinical on public.clinical_records;
create policy clinical_records_delete_clinical
  on public.clinical_records for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

commit;
