-- Map-tracking-only clients (Oct 15 2026). Tom approved moving all ten
-- BrightLocal locations onto Compass map scans, including three businesses
-- that receive no other Compass service. A plain clients insert would fire
-- the Foundation worker, Drive/GitHub provisioning, three pipeline
-- enrollments and three tasks, so the scope is recorded on the client and
-- every onboarding trigger runs for full-service clients only.
--
-- A map-tracking client stays paused: every status-driven job (rank sync,
-- weekly blog tasks, delivery months, monthly cycles, website updates) acts
-- on active/launching clients only, while map-grid scans follow the
-- client's map_grid_profiles. Changing the scope later does not replay the
-- onboarding triggers; a full-service onboarding is a deliberate step.
alter table public.clients
  add column service_scope text not null default 'full'
    check (service_scope in ('full', 'map_tracking')),
  add constraint clients_map_tracking_paused
    check (service_scope = 'full' or status in ('paused', 'offboarded'));

drop trigger clients_created on public.clients;
create trigger clients_created after insert on public.clients
  for each row when (new.service_scope = 'full') execute function handle_client_created();
drop trigger clients_fire_worker on public.clients;
create trigger clients_fire_worker after insert on public.clients
  for each row when (new.service_scope = 'full') execute function fire_worker_on_client_created();
drop trigger clients_foundation_enrollment on public.clients;
create trigger clients_foundation_enrollment after insert on public.clients
  for each row when (new.service_scope = 'full') execute function enroll_client_in_foundation();
drop trigger clients_provision on public.clients;
create trigger clients_provision after insert on public.clients
  for each row when (new.service_scope = 'full') execute function provision_new_client();
drop trigger clients_reporting_baseline on public.clients;
create trigger clients_reporting_baseline after insert on public.clients
  for each row when (new.service_scope = 'full') execute function create_reporting_baseline_task();
drop trigger clients_zz_seo_enrollment on public.clients;
create trigger clients_zz_seo_enrollment after insert on public.clients
  for each row when (new.service_scope = 'full') execute function enroll_client_in_seo();
drop trigger clients_zz_website_enrollment on public.clients;
create trigger clients_zz_website_enrollment after insert on public.clients
  for each row when (new.service_scope = 'full') execute function enroll_client_in_website();

-- Refuse the migration if any onboarding trigger escaped the gate.
do $$
declare missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array['clients_created','clients_fire_worker','clients_foundation_enrollment',
    'clients_provision','clients_reporting_baseline','clients_zz_seo_enrollment',
    'clients_zz_website_enrollment']) t
  where not exists (
    select 1 from pg_trigger g
    where g.tgrelid = 'public.clients'::regclass and g.tgname = t
      and pg_get_triggerdef(g.oid) like '%WHEN ((new.service_scope = ''full''::text))%');
  if missing is not null then raise exception 'ungated onboarding trigger(s): %', missing; end if;
end $$;
