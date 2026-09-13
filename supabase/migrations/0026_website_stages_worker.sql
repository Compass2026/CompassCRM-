-- Website › Polish & client review and Launch become worker stages.
--
-- Same split as the SEO stages (0025): the worker does what it can reach —
-- reading the pushed site back through site-push, applying the punch list,
-- placing material from the client's Drive Media folder, the Lighthouse
-- pass, the redirect map, adding the domain to the Vercel project,
-- verifying it, submitting the sitemap, recording the launch — and Tom does
-- what needs a person: sending the staging link and collecting feedback,
-- adding the DNS records at the registrar. Two of Tom's tasks are gates the
-- worker waits behind (client review before Launch, DNS records before
-- verification), so closing either one fires the worker.

-- ── Templates ────────────────────────────────────────────────────────────
create temp table web_tt (
  stage text, old_title text, title text, key text, owner owner_type, autonomy autonomy_level, sort int
) on commit drop;

insert into web_tt values
  -- Discovery: keys only
  ('Discovery', 'Inventory the existing site: page list, content worth keeping, redirects needed',
   'Inventory the existing site: page list, content worth keeping, redirects needed', 'site_inventory', 'CLAUDE', 'run', 1),
  ('Discovery', 'Send the client request: photos, project details, team bios, certifications',
   'Send the client request: photos, project details, team bios, certifications', 'client_request', 'TOM', 'run', 2),
  ('Discovery', 'Confirm the stack and record the site row (Astro, repo, Vercel project)',
   'Confirm the stack and record the site row (Astro, repo, Vercel project)', 'site_row', 'CLAUDE', 'run', 3),
  ('Discovery', 'Confirm domain, DNS and hosting access ahead of launch',
   'Confirm domain, DNS and hosting access ahead of launch', 'dns_access', 'TOM', 'run', 4),
  -- Polish & client review
  ('Polish & client review', 'Work the punch list and replace placeholders as material arrives',
   'Punch list worked: audit findings applied, material from Drive Media placed, placeholders resolved or deferred', 'punch_list', 'CLAUDE', 'run_flag', 1),
  ('Polish & client review', 'Lighthouse and Rich Results pass',
   'Lighthouse pass on staging (mobile: performance ≥ 90, SEO 100) and structured data checked', 'lighthouse_pass', 'CLAUDE', 'run', 2),
  ('Polish & client review', null,
   'Redirect map from the old URL set written into vercel.json', 'redirect_map', 'CLAUDE', 'run', 3),
  ('Polish & client review', 'Send the staging URL for client review and collect feedback',
   'Send the staging URL for client review and collect feedback', 'client_review', 'TOM', 'run', 4),
  -- Launch
  ('Launch', 'DNS cutover',
   'Domain added to the Vercel project; DNS records handed to Tom', 'domain_added', 'CLAUDE', 'run', 1),
  ('Launch', null,
   'Add the DNS records at the registrar (A for the apex, CNAME for www, TXT if asked)', 'dns_records', 'TOM', 'run', 2),
  ('Launch', null,
   'Domain verified and serving the new site over HTTPS', 'dns_verified', 'CLAUDE', 'run', 3),
  ('Launch', 'Verify redirects from the old URL set',
   'Redirects from the old URL set verified', 'redirects_verified', 'CLAUDE', 'run', 4),
  ('Launch', 'Submit the sitemap in Search Console',
   'Sitemap submitted in Search Console', 'sitemap_submitted', 'CLAUDE', 'run', 5),
  ('Launch', 'Record launched_at and file the site plan in Drive 04 Website',
   'launched_at recorded and the site plan filed in Drive 04 Website', 'launched', 'CLAUDE', 'run', 6);

update task_templates tt
set title = m.title, key = m.key, default_owner = m.owner, autonomy_level = m.autonomy, sort_order = m.sort
from web_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'website'
where tt.stage_id = s.id and m.old_title is not null and tt.title = m.old_title;

insert into task_templates (stage_id, title, default_owner, sort_order, playbook_step, autonomy_level, key)
select s.id, m.title, m.owner, m.sort, null, m.autonomy, m.key
from web_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'website'
where m.old_title is null
  and not exists (select 1 from task_templates t where t.stage_id = s.id and t.key = m.key);

-- ── Existing clients' open tasks follow ──────────────────────────────────
update tasks t
set title = m.title, key = m.key, owner = m.owner, autonomy_level = m.autonomy
from web_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'website'
join client_stages cs on cs.stage_id = s.id
where t.client_stage_id = cs.id and t.status <> 'done'
  and m.old_title is not null and t.title = m.old_title;

insert into tasks (client_id, client_stage_id, title, owner, status, autonomy_level, key)
select cp.client_id, cs.id, m.title, m.owner, 'open', m.autonomy, m.key
from web_tt m
join stages s on s.name = m.stage
join pipelines p on p.id = s.pipeline_id and p.key = 'website'
join client_stages cs on cs.stage_id = s.id
join client_pipelines cp on cp.id = cs.client_pipeline_id
where m.old_title is null
  and cs.status not in ('complete', 'skipped')
  and exists (select 1 from tasks t where t.client_stage_id = cs.id)
  and not exists (select 1 from tasks t where t.client_stage_id = cs.id and t.key = m.key);

-- ── Fires ────────────────────────────────────────────────────────────────
-- A Website stage completing starts the next one (Build → Polish → Launch).
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

  if v_key in ('foundation', 'seo', 'website') and new.status = 'complete' then
    perform fire_foundation_worker(v_client, v_stage || ' complete');
  elsif new.status = 'not_started' and v_key in ('foundation', 'website', 'seo') then
    perform fire_foundation_worker(v_client, v_stage || ' reopened');
  end if;
  return new;
end $$;

-- Tom closing a gate task starts the worker on what waited behind it.
create or replace function fire_worker_on_task_done() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status is distinct from 'done'
     and new.key in ('client_review', 'dns_records') then
    perform fire_foundation_worker(new.client_id, new.key || ' done');
  end if;
  return new;
end $$;

revoke execute on function fire_worker_on_task_done() from public, anon, authenticated;

drop trigger if exists tasks_zz_fire_worker on tasks;
create trigger tasks_zz_fire_worker after update on tasks
  for each row execute function fire_worker_on_task_done();
