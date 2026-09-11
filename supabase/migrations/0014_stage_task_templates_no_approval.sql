-- Onboarding, made walkable (reconciliation.md build-order step 2, finished).
--
-- Three changes, one migration:
--
--   A. Stage-level task templates. Every launch stage now carries its playbook
--      checklist, so enrolling a pipeline creates real tasks instead of empty
--      stages. Until now the only task_templates rows belonged to Reporting,
--      which is why create_stage_tasks() always inserted zero rows.
--   B. No mid-process approvals. Tom reviews a pipeline once it is finished,
--      not step by step, so CLAUDE_APPROVAL / autonomy 'hold' becomes
--      CLAUDE / 'run' everywhere. The sequencing gates stay: Foundation still
--      runs before SEO and Website, and the taxonomy still runs before Brand
--      Build and Keyword Research, because those stages read its output.
--   C. A review task per pipeline. Completing a pipeline creates one TOM task
--      to review the whole thing. It is a to-do, not a gate — convergence,
--      Reporting enrollment and the monthly cycle are unaffected.

-- ── A. Stage task templates ──────────────────────────────────────────────
-- Re-runnable: stage-level templates are rebuilt from scratch. Tasks already
-- created on client stages are untouched (create_stage_tasks only fills
-- stages that have none).
delete from task_templates where stage_id is not null;

insert into task_templates (stage_id, title, default_owner, autonomy_level,
                            playbook_step, sort_order)
select s.id, v.title, v.owner::owner_type, v.autonomy::autonomy_level,
       v.playbook_step, v.sort_order
from pipelines p
join stages s on s.pipeline_id = p.id
join (values
  -- Foundation 1 — Onboarding & Service Taxonomy (PB1)
  ('foundation', 'Onboarding & Service Taxonomy', 'Complete the business record: vertical, business type, NAP, phone, service area', 'CLAUDE', 'run', 'PB1.1', 1),
  ('foundation', 'Onboarding & Service Taxonomy', 'Enter client contacts on the Overview tab', 'CLAUDE', 'run', 'PB1.2', 2),
  ('foundation', 'Onboarding & Service Taxonomy', 'Request access: GBP, Search Console, GA4, hosting / DNS, social accounts', 'TOM', 'run', 'PB1.3', 3),
  ('foundation', 'Onboarding & Service Taxonomy', 'Create the Drive folder structure (01 Onboarding – 05 Reports + Media) and store the ids on clients.drive_folders', 'CLAUDE', 'run', 'PB1.4', 4),
  ('foundation', 'Onboarding & Service Taxonomy', 'Draft the service taxonomy on the Services tab — one row per GBP entry / page', 'CLAUDE', 'run', 'PB1.5', 5),
  ('foundation', 'Onboarding & Service Taxonomy', 'Set each service''s segment, page type and parent, and fold thin services into hubs', 'CLAUDE', 'run', 'PB1.6', 6),

  -- Foundation 2 — Brand Build (PB2)
  ('foundation', 'Brand Build', 'Run the website scan to seed the board, then delete anything it guessed wrong', 'CLAUDE', 'run', 'PB2.1', 1),
  ('foundation', 'Brand Build', 'Palette: hex codes with roles assigned', 'CLAUDE', 'run', 'PB2.2', 2),
  ('foundation', 'Brand Build', 'Typography: heading and body typefaces', 'CLAUDE', 'run', 'PB2.3', 3),
  ('foundation', 'Brand Build', 'Positioning line, standing CTA, voice and content pillars', 'CLAUDE', 'run', 'PB2.4', 4),
  ('foundation', 'Brand Build', 'Hard rules (what we never say, never show, never claim)', 'CLAUDE', 'run', 'PB2.5', 5),
  ('foundation', 'Brand Build', 'Log every claim as sourced or unverified', 'CLAUDE', 'run', 'PB2.6', 6),
  ('foundation', 'Brand Build', 'File logo and photography originals in Media and attach them as brand assets', 'CLAUDE', 'run', 'PB2.7', 7),
  ('foundation', 'Brand Build', 'Publish the board snapshot to Documents and file a copy in Drive 02 Brand', 'CLAUDE', 'run', 'PB2.8', 8),

  -- Foundation 3 — Keyword Research (PB3)
  ('foundation', 'Keyword Research', 'Build the demand table: volume, CPC, competition and intent per term', 'CLAUDE', 'run', 'PB3.1', 1),
  ('foundation', 'Keyword Research', 'Link every keyword to its service', 'CLAUDE', 'run', 'PB3.2', 2),
  ('foundation', 'Keyword Research', 'Nominate the money keywords and set their alert thresholds', 'CLAUDE', 'run', 'PB3.3', 3),
  ('foundation', 'Keyword Research', 'Build page groups: home, service, city (with tier), hub', 'CLAUDE', 'run', 'PB3.4', 4),
  ('foundation', 'Keyword Research', 'Mark the tracked list and set keyword priorities (P1 drives the City Index)', 'CLAUDE', 'run', 'PB3.5', 5),
  ('foundation', 'Keyword Research', 'Add tracked locations and a geo-grid config on the Keywords tab', 'CLAUDE', 'run', 'PB3.6', 6),
  ('foundation', 'Keyword Research', 'Export the keyword map to Drive 03 Keywords and push the tracked list to BrightLocal', 'CLAUDE', 'run', 'PB3.7', 7),

  -- SEO (PB4a)
  ('seo', 'Audit & Adjust', 'On-page audit against the approved taxonomy and keyword map', 'CLAUDE', 'run', 'PB4a.1', 1),
  ('seo', 'Audit & Adjust', 'Technical audit: crawl, indexation, speed, schema, mobile', 'CLAUDE', 'run', 'PB4a.2', 2),
  ('seo', 'Audit & Adjust', 'Off-page audit: backlink profile and citation state', 'CLAUDE', 'run', 'PB4a.3', 3),
  ('seo', 'Audit & Adjust', 'Write the fix list and file the audit report in Drive 04 Website', 'CLAUDE', 'run', 'PB4a.4', 4),
  ('seo', 'Audit & Adjust', 'Apply the fixes and log each one in the change log', 'CLAUDE', 'run_flag', 'PB4a.5', 5),
  ('seo', 'GBP Setup & Optimisation', 'Categories, services and business description set from the taxonomy', 'CLAUDE', 'run_flag', null, 1),
  ('seo', 'GBP Setup & Optimisation', 'Hours, service area, attributes and booking links confirmed', 'CLAUDE', 'run_flag', null, 2),
  ('seo', 'GBP Setup & Optimisation', 'Photos uploaded and the GBP post cadence started', 'CLAUDE', 'run_flag', null, 3),
  ('seo', 'Local Citations', 'Build the citation list for the vertical and service area', 'CLAUDE', 'run', null, 1),
  ('seo', 'Local Citations', 'Submit the core aggregators and directories', 'CLAUDE', 'run', null, 2),
  ('seo', 'Local Citations', 'NAP consistency sweep — fix mismatches found in the audit', 'CLAUDE', 'run', null, 3),
  ('seo', 'Local Citations', 'Record the completion sheet as a deliverable', 'CLAUDE', 'run', null, 4),
  ('seo', 'Backlink Foundation', 'Build the prospect list from competitors and local opportunities', 'CLAUDE', 'run', null, 1),
  ('seo', 'Backlink Foundation', 'Run outreach and secure the first placements', 'CLAUDE', 'run_flag', null, 2),
  ('seo', 'Backlink Foundation', 'Log new links so the monthly cycle can count them', 'CLAUDE', 'run', null, 3),
  ('seo', 'Tracking Setup (GSC, BrightLocal)', 'Search Console property created, verified and stored on clients.gsc_property', 'CLAUDE', 'run', null, 1),
  ('seo', 'Tracking Setup (GSC, BrightLocal)', 'GA4 connected and conversions defined', 'CLAUDE', 'run', null, 2),
  ('seo', 'Tracking Setup (GSC, BrightLocal)', 'BrightLocal Local Rank Tracker report created for the tracked list', 'CLAUDE', 'run', null, 3),
  ('seo', 'Tracking Setup (GSC, BrightLocal)', 'BrightLocal Local Search Grid report created from the geo-grid config', 'CLAUDE', 'run', null, 4),
  ('seo', 'Tracking Setup (GSC, BrightLocal)', 'Run the first sync and confirm rank + GSC snapshots land', 'CLAUDE', 'run', null, 5),

  -- Website (PB4b, Astro)
  ('website', 'Discovery', 'Inventory the existing site: page list, content worth keeping, redirects needed', 'CLAUDE', 'run', null, 1),
  ('website', 'Discovery', 'Send the client request: photos, project details, team bios, certifications', 'TOM', 'run', null, 2),
  ('website', 'Discovery', 'Confirm the stack and record the site row (Astro, repo, Vercel project)', 'CLAUDE', 'run', null, 3),
  ('website', 'Discovery', 'Confirm domain, DNS and hosting access ahead of launch', 'TOM', 'run', null, 4),
  ('website', 'Build to 70%', 'Create the GitHub repo and Vercel project, wire the staging URL', 'CLAUDE', 'run', 'PB4b.1', 1),
  ('website', 'Build to 70%', 'Base layout, palette and typography from the approved brand board', 'CLAUDE', 'run', 'PB4b.2', 2),
  ('website', 'Build to 70%', 'Home page against its page group', 'CLAUDE', 'run', 'PB4b.3', 3),
  ('website', 'Build to 70%', 'Service pages, one per approved service', 'CLAUDE', 'run', 'PB4b.4', 4),
  ('website', 'Build to 70%', 'City pages by tier, and hub pages for folded services', 'CLAUDE', 'run', 'PB4b.5', 5),
  ('website', 'Build to 70%', 'Schema, metadata and internal linking from the keyword map', 'CLAUDE', 'run', 'PB4b.6', 6),
  ('website', 'Build to 70%', 'Log every placeholder (image, claim, fact, project) for the punch list', 'CLAUDE', 'run', 'PB4b.7', 7),
  ('website', 'Polish & client review', 'Work the punch list and replace placeholders as material arrives', 'CLAUDE', 'run_flag', null, 1),
  ('website', 'Polish & client review', 'Lighthouse and Rich Results pass', 'CLAUDE', 'run', null, 2),
  ('website', 'Polish & client review', 'Send the staging URL for client review and collect feedback', 'TOM', 'run', null, 3),
  ('website', 'Launch', 'DNS cutover', 'CLAUDE', 'run', null, 1),
  ('website', 'Launch', 'Verify redirects from the old URL set', 'CLAUDE', 'run', null, 2),
  ('website', 'Launch', 'Submit the sitemap in Search Console', 'CLAUDE', 'run', null, 3),
  ('website', 'Launch', 'Record launched_at and file the site plan in Drive 04 Website', 'CLAUDE', 'run', null, 4),

  -- Social
  ('social', 'Audit', 'Inventory existing profiles, handles and posting history', 'CLAUDE', 'run', null, 1),
  ('social', 'Audit', 'Confirm access to each account', 'TOM', 'run', null, 2),
  ('social', 'Brand & Content Setup', 'Voice, pillars and hard rules pulled from the brand board', 'CLAUDE', 'run', null, 1),
  ('social', 'Brand & Content Setup', 'Build the Canva templates', 'TOM', 'run', null, 2),
  ('social', 'Brand & Content Setup', 'Connect Metricool', 'TOM', 'run', null, 3),
  ('social', 'Content Calendar', 'Plan the first 30 days on the Social tab', 'CLAUDE', 'run', null, 1),
  ('social', 'First Month Live', 'Publish to the plan''s monthly post count', 'TOM', 'run', null, 1),
  ('social', 'First Month Live', 'Review engagement and adjust the pillars', 'TOM', 'run', null, 2),

  -- CRM
  ('crm', 'Requirements', 'Document pipelines, fields, automations and comms needs', 'TOM', 'run', null, 1),
  ('crm', 'Build', 'Build the pipelines, fields and automations', 'TOM', 'run', null, 1),
  ('crm', 'Data Migration', 'Map and import existing records', 'TOM', 'run', null, 1),
  ('crm', 'Training', 'Train the client team and hand over documentation', 'TOM', 'run', null, 1),
  ('crm', 'Live', 'Confirm the first week of real use and fix what surfaces', 'TOM', 'run', null, 1),

  -- Paid Ads
  ('paid_ads', 'Account Audit', 'Inventory ad accounts, historical spend and pixel / tag state', 'TOM', 'run', null, 1),
  ('paid_ads', 'Tracking Setup', 'Conversions, GA4 and Meta pixel / CAPI', 'TOM', 'run', null, 1),
  ('paid_ads', 'Campaign Build', 'Build campaigns, ad groups and creative from the keyword map', 'TOM', 'run', null, 1),
  ('paid_ads', 'Launch', 'Launch and confirm spend, delivery and conversion tracking', 'TOM', 'run', null, 1),
  ('paid_ads', 'Optimization Handoff', 'Hand the account to the monthly Reporting cycle', 'TOM', 'run', null, 1)
) as v(pipeline_key, stage_name, title, owner, autonomy, playbook_step, sort_order)
  on v.pipeline_key = p.key::text and v.stage_name = s.name;

-- Backfill: clients already enrolled have stages with no tasks. Fill them.
select create_stage_tasks(cp.id)
from client_pipelines cp
where cp.status <> 'pending';

-- ── B. No mid-process approvals ──────────────────────────────────────────
-- Stage defaults.
update stages set default_owner = 'CLAUDE' where default_owner = 'CLAUDE_APPROVAL';
update stages set autonomy_level = 'run' where autonomy_level = 'hold';

-- Reporting task templates (GBP posts, blog content, the monthly report).
update task_templates
set default_owner = 'CLAUDE',
    autonomy_level = case when autonomy_level = 'hold' then 'run'::autonomy_level
                          else autonomy_level end
where default_owner = 'CLAUDE_APPROVAL';

-- Work already in flight: open approval tasks and stages become Claude's.
update tasks
set owner = 'CLAUDE',
    autonomy_level = case when autonomy_level = 'hold' then 'run'::autonomy_level
                          else autonomy_level end
where owner = 'CLAUDE_APPROVAL' and status <> 'done';

update client_stages set owner = 'CLAUDE' where owner = 'CLAUDE_APPROVAL';

-- The brand-board task: no longer an approval, and re-pointed at Foundation ›
-- Brand Build (0009 attached it to the SEO "Onboarding" stage, which 0011
-- moved into Foundation and deleted).
create or replace function handle_client_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_brands (client_id) values (new.id)
  on conflict (client_id) do nothing;

  insert into tasks (client_id, title, owner, status, key, autonomy_level, notes)
  values (
    new.id,
    'Build brand board',
    'CLAUDE',
    'open',
    'brand_board',
    'run',
    'Draft the brand board from onboarding intake (logos, colors, fonts, voice, existing website / social material) on the Brand tab. Reviewed with the rest of Foundation when the pipeline completes.'
  );
  return new;
end $$;

revoke execute on function handle_client_created() from public, anon, authenticated;

-- Attach the open brand-board task to Foundation › Brand Build on enrollment.
create or replace function handle_pipeline_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_brand_stage uuid;
begin
  insert into client_stages (client_pipeline_id, stage_id, status, owner)
  select new.id, s.id, 'not_started', s.default_owner
  from stages s
  where s.pipeline_id = new.pipeline_id
  order by s.sort_order;

  if new.status <> 'pending' then
    perform create_stage_tasks(new.id);
  end if;

  select cs.id into v_brand_stage
  from client_stages cs
  join stages s on s.id = cs.stage_id
  join pipelines p on p.id = s.pipeline_id
  where cs.client_pipeline_id = new.id
    and p.key = 'foundation' and s.name = 'Brand Build';

  if v_brand_stage is not null then
    update tasks
    set client_stage_id = v_brand_stage
    where client_id = new.client_id
      and key = 'brand_board'
      and client_stage_id is null
      and status <> 'done';
  end if;

  return new;
end $$;

revoke execute on function handle_pipeline_enrollment() from public, anon, authenticated;

-- Existing clients: re-point their orphaned brand-board tasks too.
update tasks t
set client_stage_id = cs.id
from client_stages cs
join stages s on s.id = cs.stage_id
join pipelines p on p.id = s.pipeline_id
join client_pipelines cp on cp.id = cs.client_pipeline_id
where p.key = 'foundation' and s.name = 'Brand Build'
  and cp.client_id = t.client_id
  and t.key = 'brand_board'
  and t.client_stage_id is null
  and t.status <> 'done';

-- ── C. One review task per pipeline, at the end ──────────────────────────
create or replace function handle_pipeline_review() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_key text;
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    select p.name, 'review_' || p.key::text into v_name, v_key
    from pipelines p where p.id = new.pipeline_id;

    insert into tasks (client_id, title, owner, status, key, autonomy_level, notes)
    select new.client_id,
           'Review ' || v_name,
           'TOM',
           'open',
           v_key,
           null,
           'Every stage of ' || v_name || ' is finished. Review the work end to end — '
             || 'this does not block anything downstream.'
    where not exists (
      select 1 from tasks t
      where t.client_id = new.client_id and t.key = v_key and t.status <> 'done'
    );
  end if;
  return new;
end $$;

revoke execute on function handle_pipeline_review() from public, anon, authenticated;

drop trigger if exists client_pipelines_review on client_pipelines;
create trigger client_pipelines_review after update on client_pipelines
  for each row execute function handle_pipeline_review();
