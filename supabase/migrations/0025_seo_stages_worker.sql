-- SEO stages 2–5 become worker stages: GBP Setup & Optimisation, Local
-- Citations, Backlink Foundation, Tracking Setup.
--
-- The worker has no Business Profile login, no directory accounts, no mail
-- to send outreach from, and BrightLocal report creation is billable. So
-- each stage's checklist is split honestly: the research, drafting and CRM
-- data steps are CLAUDE (the worker does them, files the document in Drive
-- 04 Website, and completes the stage); the steps that need Tom's logins or
-- money are TOM, with the worker's notes pointing at everything it prepared.
-- A stage is complete when the worker's own steps are; Tom's tasks stay open
-- on his list. Completing Tracking Setup completes the SEO pipeline, which
-- raises Review SEO (0014) and, with Website complete, converges the client.
--
-- Existing open tasks created from the old templates are rewritten in place
-- (same rows, new title / key / owner) and the new template tasks are added,
-- so the six clients already enrolled pick up the new checklist without a
-- re-enrollment.

-- ── Templates ────────────────────────────────────────────────────────────
create temp table seo_tt (
  stage text, old_title text, title text, key text, owner owner_type, autonomy autonomy_level, sort int
) on commit drop;

insert into seo_tt values
  -- GBP Setup & Optimisation
  ('GBP Setup & Optimisation', 'Categories, services and business description set from the taxonomy',
   'GBP spec drafted from the taxonomy: categories, services, description, attributes, service area, Q&A', 'gbp_spec', 'CLAUDE', 'run', 1),
  ('GBP Setup & Optimisation', null,
   'First month of GBP posts drafted in the brand voice', 'gbp_posts_drafted', 'CLAUDE', 'run_flag', 2),
  ('GBP Setup & Optimisation', 'Hours, service area, attributes and booking links confirmed',
   'Apply the GBP spec in Business Profile Manager: categories, services, description, hours, attributes, booking link', 'gbp_apply', 'TOM', 'run', 3),
  ('GBP Setup & Optimisation', 'Photos uploaded and the GBP post cadence started',
   'Photos uploaded and the post cadence started with the drafted posts', 'gbp_photos', 'TOM', 'run', 4),
  -- Local Citations
  ('Local Citations', 'Build the citation list for the vertical and service area',
   'Citation list built for the vertical and service area, with current status per directory', 'citation_list', 'CLAUDE', 'run', 1),
  ('Local Citations', 'NAP consistency sweep — fix mismatches found in the audit',
   'NAP sweep: every listing found, each mismatch listed with the exact fix', 'nap_sweep', 'CLAUDE', 'run', 2),
  ('Local Citations', 'Submit the core aggregators and directories',
   'Submit the core aggregators and directories, or run BrightLocal Citation Builder (billable)', 'citation_submit', 'TOM', 'run', 3),
  ('Local Citations', 'Record the completion sheet as a deliverable',
   'Citation sheet filed in Drive 04 Website as the completion record', 'citation_sheet', 'CLAUDE', 'run', 4),
  -- Backlink Foundation
  ('Backlink Foundation', 'Build the prospect list from competitors and local opportunities',
   'Prospect list from competitor link intersections and local opportunities', 'backlink_prospects', 'CLAUDE', 'run', 1),
  ('Backlink Foundation', null,
   'Outreach templates drafted in the brand voice; disavow candidates listed', 'outreach_drafts', 'CLAUDE', 'run_flag', 2),
  ('Backlink Foundation', 'Run outreach and secure the first placements',
   'Run outreach and secure the first placements', 'outreach_send', 'TOM', 'run', 3),
  ('Backlink Foundation', 'Log new links so the monthly cycle can count them',
   'Baseline referring domains recorded so the monthly cycle can count new links', 'backlink_baseline', 'CLAUDE', 'run', 4),
  -- Tracking Setup
  ('Tracking Setup (GSC, BrightLocal)', null,
   'Locations, tracked list and geo-grid config recorded in the CRM', 'tracking_locations', 'CLAUDE', 'run', 1),
  ('Tracking Setup (GSC, BrightLocal)', 'Search Console property created, verified and stored on clients.gsc_property',
   'Search Console property verified for the Compass account and stored on clients.gsc_property', 'gsc_verify', 'CLAUDE', 'run', 2),
  ('Tracking Setup (GSC, BrightLocal)', 'GA4 connected and conversions defined',
   'GA4 connected and conversions defined', 'ga4', 'TOM', 'run', 3),
  ('Tracking Setup (GSC, BrightLocal)', 'BrightLocal Local Rank Tracker report created for the tracked list',
   'BrightLocal Local Rank Tracker report created for the tracked list (billable); id stored on the location', 'brightlocal_lrt', 'TOM', 'run', 4),
  ('Tracking Setup (GSC, BrightLocal)', 'BrightLocal Local Search Grid report created from the geo-grid config',
   'BrightLocal Local Search Grid report created from the geo-grid config (billable); id stored on the grid config', 'brightlocal_lsg', 'TOM', 'run', 5),
  ('Tracking Setup (GSC, BrightLocal)', 'Run the first sync and confirm rank + GSC snapshots land',
   'First sync run; rank and GSC snapshots confirmed', 'first_sync', 'CLAUDE', 'run', 6);

-- Existing templates: rewrite in place.
update task_templates tt
set title = m.title, key = m.key, default_owner = m.owner, autonomy_level = m.autonomy, sort_order = m.sort
from seo_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and m.old_title is not null and tt.title = m.old_title;

-- New templates.
insert into task_templates (stage_id, title, default_owner, sort_order, playbook_step, autonomy_level, key)
select s.id, m.title, m.owner, m.sort, null, m.autonomy, m.key
from seo_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where m.old_title is null
  and not exists (select 1 from task_templates t where t.stage_id = s.id and t.key = m.key);

-- ── Existing clients' open tasks follow ──────────────────────────────────
update tasks t
set title = m.title, key = m.key, owner = m.owner, autonomy_level = m.autonomy
from seo_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'seo'
join client_stages cs on cs.stage_id = s.id
where t.client_stage_id = cs.id and t.status <> 'done'
  and m.old_title is not null and t.title = m.old_title;

insert into tasks (client_id, client_stage_id, title, owner, status, autonomy_level, key)
select cp.client_id, cs.id, m.title, m.owner, 'open', m.autonomy, m.key
from seo_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'seo'
join client_stages cs on cs.stage_id = s.id
join client_pipelines cp on cp.id = cs.client_pipeline_id
where m.old_title is null
  and cs.status not in ('complete', 'skipped')
  and exists (select 1 from tasks t where t.client_stage_id = cs.id)
  and not exists (select 1 from tasks t where t.client_stage_id = cs.id and t.key = m.key);

-- ── Fires: an SEO stage completing starts the next one ───────────────────
create or replace function fire_worker_on_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_key pipeline_key;
  v_stage text;
begin
  if new.status = old.status then
    return new;
  end if;

  select cp.client_id, p.key, s.name
  into v_client, v_key, v_stage
  from client_pipelines cp
  join pipelines p on p.id = cp.pipeline_id
  join stages s on s.id = new.stage_id
  where cp.id = new.client_pipeline_id;

  if v_key in ('foundation', 'seo') and new.status = 'complete' then
    perform fire_foundation_worker(v_client, v_stage || ' complete');
  elsif new.status = 'not_started' and v_key in ('foundation', 'website', 'seo') then
    perform fire_foundation_worker(v_client, v_stage || ' reopened');
  end if;
  return new;
end $$;
