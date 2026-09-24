begin;

set local lock_timeout = '5s';

drop policy if exists vaccinations_delete_owner on public.vaccinations;
drop policy if exists vaccinations_delete_clinical on public.vaccinations;

create policy vaccinations_delete_clinical
  on public.vaccinations for delete to authenticated
  using ((select private.has_role(array['owner', 'veterinarian']::public.app_role[])));

commit;
