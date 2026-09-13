-- Approvals retooled (Tom, Sept 13 2026): "way too many things for me to
-- approve". The walk-through found two real gates in the whole line —
-- client review before Launch and the DNS records — and 80-odd chores that
-- landed on Tom only because the worker had no login. So:
--
-- 1. Pipeline reviews stop being tasks Tom owns. handle_pipeline_review now
--    files a finished, flagged summary (owner CLAUDE, done) that shows on
--    the Brief under "done, review if you want" for a week and on the Tasks
--    flagged view forever. The twelve open Review tasks convert the same way.
-- 2. GBP apply and GA4 become worker steps through the google-ops Edge
--    Function (Business Profile API, Analytics Admin API); the one thing Tom
--    still does per client is grant the Compass Google account access.
--    Columns for what the function records.
-- 3. The Foundation "Request access" task becomes that single grant, keyed.
-- 4. Leftover tasks from before the worker existed close; two Keyword
--    Research templates the worker superseded are removed.
-- 5. Outreach and the monthly report become Gmail drafts (skill + function);
--    the task templates stay Tom's — he presses send.

-- ── Columns ──────────────────────────────────────────────────────────────
alter table clients
  add column if not exists gbp_location text,
  add column if not exists gbp_spec jsonb,
  add column if not exists ga4_property text;
alter table sites
  add column if not exists ga4_measurement_id text;

comment on column clients.gbp_location is 'Business Profile resource name accounts/{a}/locations/{l}, found by google-ops gbp_locate.';
comment on column clients.gbp_spec is 'The GBP spec the worker drafted (primary_category, secondary_categories, description, services[], website, hours[], hours_confirmed, qa[], posts[]); google-ops gbp_apply reads it.';

-- ── 1. Reviews → finished summaries ──────────────────────────────────────
create or replace function handle_pipeline_review() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_key text;
  v_evidence text;
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    select p.name, 'summary_' || p.key::text into v_name, v_key
    from pipelines p where p.id = new.pipeline_id;

    select string_agg(s.name || ': ' || coalesce(right(cs.evidence, 160), '—'), E'\n' order by s.sort_order)
    into v_evidence
    from client_stages cs join stages s on s.id = cs.stage_id
    where cs.client_pipeline_id = new.id;

    insert into tasks (client_id, title, owner, status, key, autonomy_level, flagged_for_review, recommendation, notes, completed_at)
    select new.client_id,
           v_name || ' complete — summary',
           'CLAUDE',
           'done',
           v_key,
           'run_flag',
           true,
           'Every stage of ' || v_name || ' is finished. Nothing waits on you; read if you want.',
           v_evidence,
           now()
    where not exists (
      select 1 from tasks t
      where t.client_id = new.client_id and t.key = v_key
        and t.completed_at > now() - interval '1 day'
    );
  end if;
  return new;
end $$;

update tasks t
set title = replace(t.title, 'Review ', '') || ' complete — summary',
    owner = 'CLAUDE',
    status = 'done',
    key = replace(t.key, 'review_', 'summary_'),
    autonomy_level = 'run_flag',
    flagged_for_review = true,
    recommendation = 'Every stage is finished. Nothing waits on you; read if you want.',
    completed_at = coalesce(t.completed_at, now())
where t.key in ('review_foundation', 'review_seo', 'review_website') and t.status <> 'done';

-- ── 2. GBP apply and GA4 become worker steps ─────────────────────────────
update task_templates set
  title = 'GBP spec applied through the Business Profile API: categories, description, services, website, Q&A, first posts',
  default_owner = 'CLAUDE', autonomy_level = 'run_flag'
where key = 'gbp_apply';

update task_templates set
  title = 'GA4 property created, tag installed on the site, phone-click and form-submit conversions defined',
  default_owner = 'CLAUDE', autonomy_level = 'run'
where key = 'ga4';

update tasks t set title = tt.title, owner = tt.default_owner, autonomy_level = tt.autonomy_level
from task_templates tt
where t.key = tt.key and t.key in ('gbp_apply', 'ga4') and t.status <> 'done';

-- ── 3. The one access grant per client ───────────────────────────────────
update task_templates set
  title = 'Grant the Compass Google account manager access: Business Profile, Search Console, GA4',
  key = 'google_access'
where title like 'Request access: GBP, Search Console, GA4%';

update tasks set
  title = 'Grant the Compass Google account manager access: Business Profile, Search Console, GA4',
  key = 'google_access',
  notes = coalesce(notes || E'\n', '') || 'Add the Compass Workspace account as a manager on the client''s Business Profile, an owner on the Search Console property, and an editor on GA4 (or let Compass create the GA4 property). The worker takes it from there.'
where title like 'Request access: GBP, Search Console, GA4%' and status <> 'done';

-- ── 4. Leftovers from before the worker ──────────────────────────────────
update tasks set
  status = 'done',
  completed_at = now(),
  notes = coalesce(notes || E'\n', '') || 'Closed Sept 13 2026 (0029): superseded by the worker — the keyword map is filed by Keyword Research, locations and grids by Tracking Setup, DNS by Launch; the default branch and SEO enrollment are done.'
where status <> 'done'
  and (
    title like 'Export the keyword map to Drive 03 Keywords%'
    or title like 'Add tracked locations and a geo-grid config%'
    or key in ('github_default_branch', 'seo_enrollment_decision', 'gbp_create', 'dns_access')
  );

delete from task_templates
where title like 'Export the keyword map to Drive 03 Keywords%'
   or title like 'Add tracked locations and a geo-grid config%'
   or key = 'dns_access';
