begin;

set local lock_timeout = '5s';

-- Reception is read-only. Owners and veterinarians may create and edit pets.
drop policy if exists pets_insert_staff on public.pets;
drop policy if exists pets_update_staff on public.pets;
drop policy if exists pets_delete_clinical on public.pets;
drop policy if exists pets_insert_clinical on public.pets;
drop policy if exists pets_update_clinical on public.pets;
drop policy if exists pets_delete_owner on public.pets;

create policy pets_insert_clinical
  on public.pets for insert to authenticated
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy pets_update_clinical
  on public.pets for update to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])))
  with check ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

create policy pets_delete_owner
  on public.pets for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

-- Creating and modifying clinical information is permitted to clinical staff.
-- Destructive deletion remains owner-only.
drop policy if exists clinical_records_delete_clinical on public.clinical_records;
drop policy if exists clinical_records_delete_owner on public.clinical_records;
create policy clinical_records_delete_owner
  on public.clinical_records for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists clinical_files_delete_clinical on public.clinical_files;
drop policy if exists clinical_files_delete_owner on public.clinical_files;
create policy clinical_files_delete_owner
  on public.clinical_files for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists vaccinations_delete_clinical on public.vaccinations;
drop policy if exists vaccinations_delete_owner on public.vaccinations;
create policy vaccinations_delete_owner
  on public.vaccinations for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists medications_delete_clinical on public.medications;
drop policy if exists medications_delete_owner on public.medications;
create policy medications_delete_owner
  on public.medications for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists allergies_delete_clinical on public.allergies;
drop policy if exists allergies_delete_owner on public.allergies;
create policy allergies_delete_owner
  on public.allergies for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists pet_notes_delete_clinical on public.pet_notes;
drop policy if exists pet_notes_delete_owner on public.pet_notes;
create policy pet_notes_delete_owner
  on public.pet_notes for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

drop policy if exists weight_records_delete_clinical on public.weight_records;
drop policy if exists weight_records_delete_owner on public.weight_records;
create policy weight_records_delete_owner
  on public.weight_records for delete to authenticated
  using ((select private.has_role(array['owner']::public.app_role[])));

-- A historical local file can legitimately be referenced by more than one
-- clinical record. Keep each association while retaining per-record uniqueness.
alter table public.clinical_files
  drop constraint if exists clinical_files_object_path_key;
alter table public.clinical_files
  drop constraint if exists clinical_files_record_object_path_key;
alter table public.clinical_files
  add constraint clinical_files_record_object_path_key
  unique (clinical_record_id, object_path);

commit;
