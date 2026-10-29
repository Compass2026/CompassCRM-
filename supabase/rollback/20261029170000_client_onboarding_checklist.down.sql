-- Rollback for 20261029170000_client_onboarding_checklist.sql.
-- Drops the checklist (its rows and history go with it: export
-- client_onboarding_items / client_onboarding_events first if any client was
-- enrolled) and restores the pipeline templates. The last block undoes
-- supabase/deferred/20261029_legacy_task_labels.sql, if that was ever run;
-- completed tasks were never changed by either.
begin;
drop trigger if exists clients_zz_onboarding_checklist on public.clients;
drop trigger if exists sites_zz_onboarding_checklist on public.sites;
drop trigger if exists citation_locations_zz_onboarding_checklist on public.citation_locations;
drop view if exists public.client_onboarding_overview;
drop view if exists public.client_onboarding_gaps;
drop table if exists public.client_onboarding_events;
drop table if exists public.client_onboarding_items;
drop table if exists public.onboarding_items;
drop function if exists public.enroll_new_client_onboarding();
drop function if exists public.extend_client_onboarding();
drop function if exists public.enroll_client_onboarding(uuid);
drop function if exists public.record_client_onboarding_event();
drop function if exists public.guard_client_onboarding_item();
drop function if exists public.onboarding_host(text);

update public.task_templates tt set title = 'Connect Metricool', key = null
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'social'
where tt.stage_id = s.id and tt.key = 'zernio_connect';
update public.stages s set description = 'Voice, pillars, templates (Canva), Metricool connected'
from public.pipelines p
where p.id = s.pipeline_id and p.key = 'social' and s.name = 'Brand & Content Setup'
  and s.description = 'Voice, pillars, templates (Canva), Zernio destination verified';
update public.task_templates tt
set title = 'BrightLocal Local Search Grid report created from the geo-grid config (billable); id stored on the grid config', key = 'brightlocal_lsg'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'map_grid_profile';
update public.task_templates tt
set title = 'BrightLocal Local Rank Tracker report created for the tracked list (billable); id stored on the location', key = 'brightlocal_lrt'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'bing_webmaster';
update public.task_templates tt
set title = 'Submit the core aggregators and directories, or run BrightLocal Citation Builder (billable)'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'citation_submit';

-- Deferred legacy labels (titles only; the appended note line is left as a record).
update public.tasks set title = substr(title, length('[Legacy — do not buy] ') + 1)
where key in ('brightlocal_lrt','brightlocal_lsg') and title like '[Legacy — do not buy] %';
update public.tasks set title = 'Connect Metricool' where title = '[Legacy] Connect Metricool';
commit;
