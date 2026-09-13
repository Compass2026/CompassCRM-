-- SEO › Audit & Adjust (Playbook 4a) becomes a worker stage.
--
-- Until now the Foundation worker knew three Foundation stages and Website ›
-- Build to 70%. This adds the first SEO stage to what it picks up, and the
-- plumbing that gets an SEO enrollment in front of it:
--
-- 1. Every new client is enrolled in SEO at creation, exactly like Website
--    (0018). The enrollment gate parks it as pending until Foundation
--    completes; handle_foundation_completion activates it. Tom, Sept 12
--    2026: "all new clients get everything".
-- 2. An SEO enrollment becoming active fires the worker (the Website
--    trigger from 0017, generalised), and any SEO stage set back to
--    not_started fires it too — the same retry gesture as Foundation and
--    Website.
-- 3. The five PB4a checklist templates get keys so the worker closes them by
--    key, not title.
-- 4. sites.audit carries the audit report (the quality gate run against the
--    live site plus the page inventory and finding counts) so the Foundation
--    tab can show it next to the build's gate scores.
--
-- Existing clients are not enrolled here — that is a data step run once the
-- skill is on main, so the fires it causes find the playbook.

-- ── 1. SEO on every new client ───────────────────────────────────────────
create or replace function enroll_client_in_seo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_pipelines (client_id, pipeline_id, status)
  select new.id, p.id, 'active'          -- the gate parks it as pending
  from pipelines p
  where p.key = 'seo'
  on conflict (client_id, pipeline_id) do nothing;
  return new;
end $$;

revoke execute on function enroll_client_in_seo() from public, anon, authenticated;

-- Sorts after clients_foundation_enrollment, like the Website trigger, so
-- the gate sees Foundation and parks SEO behind it.
drop trigger if exists clients_zz_seo_enrollment on clients;
create trigger clients_zz_seo_enrollment after insert on clients
  for each row execute function enroll_client_in_seo();

-- ── 2. Fires: SEO active, SEO stage reopened ─────────────────────────────
create or replace function fire_worker_on_pipeline_active() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_key pipeline_key;
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    select p.key into v_key from pipelines p where p.id = new.pipeline_id;
    if v_key = 'website' then
      perform fire_foundation_worker(new.client_id, 'Website active');
    elsif v_key = 'seo' then
      perform fire_foundation_worker(new.client_id, 'SEO active');
    end if;
  end if;
  return new;
end $$;

revoke execute on function fire_worker_on_pipeline_active() from public, anon, authenticated;

drop trigger if exists client_pipelines_zz_fire_worker on client_pipelines;
create trigger client_pipelines_zz_fire_worker after insert or update on client_pipelines
  for each row execute function fire_worker_on_pipeline_active();

drop function if exists fire_worker_on_website_active();

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

  if v_key = 'foundation' and new.status = 'complete' then
    perform fire_foundation_worker(v_client, v_stage || ' complete');
  elsif new.status = 'not_started' and v_key in ('foundation', 'website', 'seo') then
    perform fire_foundation_worker(v_client, v_stage || ' reopened');
  end if;
  return new;
end $$;

-- ── 3. Keys on the PB4a checklist ────────────────────────────────────────
update task_templates set key = v.key
from (values
  ('PB4a.1', 'seo_onpage'),
  ('PB4a.2', 'seo_technical'),
  ('PB4a.3', 'seo_offpage'),
  ('PB4a.4', 'seo_fix_list'),
  ('PB4a.5', 'seo_fixes')
) as v(step, key)
where task_templates.playbook_step = v.step and task_templates.key is null;

update tasks set key = v.key
from (values
  ('PB4a.1', 'seo_onpage'),
  ('PB4a.2', 'seo_technical'),
  ('PB4a.3', 'seo_offpage'),
  ('PB4a.4', 'seo_fix_list'),
  ('PB4a.5', 'seo_fixes')
) as v(step, key)
where tasks.playbook_step = v.step and tasks.key is null;

-- ── 4. The audit report on the site row ──────────────────────────────────
alter table sites
  add column if not exists audit jsonb,
  add column if not exists audit_checked_at timestamptz;

comment on column sites.audit is
  'SEO › Audit & Adjust report: the quality gate run against the live site (score, pass, failures, warnings), the page inventory count and findings by severity. Written by the Foundation worker.';
