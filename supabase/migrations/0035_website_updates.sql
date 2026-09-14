-- Website Updates (Tom, Sept 14 2026): two new pages and two refreshes per
-- client per month, a blog post every week, published on Compass-run sites
-- without a look (site-push { revert: true } is the way back), Google Docs
-- for client-controlled sites. The Astro line is retired; Tom's Next.js
-- builds are the sites of record and the stage writes data files into them
-- on the Lucas contract (docs/website-updates.md).
--
-- 1. sites.content_paths — where the stage may write, per site. Null means
--    the site is not on the contract yet: the stage produces Docs instead.
-- 2. A monthly `site_updates` task on every Reporting cycle, fired on the
--    2nd (after the report on the 1st).
-- 3. A weekly `blog_post` task per client, created and fired on Wednesdays.
-- 4. change_log carries the record of every change with its commit.

alter table sites add column if not exists content_paths jsonb;
comment on column sites.content_paths is
  'Where the Website Updates stage writes, on the Lucas contract: {"locations": "data/locations.json", "blog": "data/blog-posts.json", "blog_format": "json"|"markdown", "blog_dir": "content/blog", "city_route": "/service-areas/{slug}", "blog_route": "/blog/{slug}", "services_dir": "src/app/services"}. Null = not on the contract; the stage files Docs instead.';

-- ── 2. Monthly site_updates task on the Reporting cycle ────────────────
insert into task_templates (pipeline_id, department, title, default_owner, sort_order, playbook_step, autonomy_level, key)
select p.id, null,
  'Website updates: map tracked keywords to pages, then add up to 2 pages and 2 refreshes from ranks, Search Console and the page plan; publish (or file Docs for a client-run site)',
  'CLAUDE', 8, 'PB7', 'run_flag', 'site_updates'
from pipelines p
where p.key = 'reporting'
  and not exists (select 1 from task_templates t where t.pipeline_id = p.id and t.key = 'site_updates');

-- Cycles already open this month get the task too.
insert into tasks (client_id, monthly_cycle_id, title, owner, status, playbook_step, autonomy_level, key)
select mc.client_id, mc.id, tt.title, tt.default_owner, 'open', tt.playbook_step, tt.autonomy_level, tt.key
from monthly_cycles mc
join task_templates tt on tt.key = 'site_updates'
where mc.status = 'open'
  and not exists (select 1 from tasks t where t.monthly_cycle_id = mc.id and t.key = 'site_updates');

create or replace function fire_website_updates(p_period date default date_trunc('month', now())::date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_cycle record;
  v_count int := 0;
begin
  for v_cycle in
    select mc.client_id
    from monthly_cycles mc
    join clients c on c.id = mc.client_id
    where mc.period = p_period and mc.status = 'open'
      and c.status = 'active'
      and exists (select 1 from tasks t where t.monthly_cycle_id = mc.id and t.key = 'site_updates' and t.status <> 'done')
  loop
    perform fire_foundation_worker(v_cycle.client_id, 'Website updates ' || to_char(p_period, 'YYYY-MM'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function fire_website_updates(date) from public, anon, authenticated;

select cron.unschedule('fire-website-updates')
where exists (select 1 from cron.job where jobname = 'fire-website-updates');
select cron.schedule('fire-website-updates', '0 9 2 * *', $$select public.fire_website_updates()$$);

-- ── 3. Weekly blog post ───────────────────────────────────────────────────
-- One CLAUDE task per client per week (Wednesday), fired at creation. Active
-- clients only; launching clients start when they converge. A client whose
-- site is not on the contract still gets a post — as a Doc in 04 Website.
create or replace function create_weekly_blog_tasks()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_client record;
  v_count int := 0;
begin
  for v_client in
    select c.id, c.name from clients c
    where c.status = 'active'
      and not exists (
        select 1 from tasks t where t.client_id = c.id and t.key = 'blog_post'
          and t.status <> 'done' and t.created_at > now() - interval '6 days')
  loop
    insert into tasks (client_id, title, owner, status, playbook_step, autonomy_level, key, due_date)
    values (v_client.id,
            'Blog post this week: one long-tail keyword, one service page, brand voice, sourced facts only',
            'CLAUDE', 'open', 'PB7', 'run_flag', 'blog_post', (current_date + 4));
    perform fire_foundation_worker(v_client.id, 'Weekly blog post ' || to_char(current_date, 'YYYY-MM-DD'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function create_weekly_blog_tasks() from public, anon, authenticated;

select cron.unschedule('weekly-blog-posts')
where exists (select 1 from cron.job where jobname = 'weekly-blog-posts');
select cron.schedule('weekly-blog-posts', '0 9 * * 3', $$select public.create_weekly_blog_tasks()$$);

-- ── 4. Lucas is on the contract from day one ─────────────────────────────
update sites set content_paths = jsonb_build_object(
  'locations', 'data/locations.json',
  'blog', 'data/blog-posts.json',
  'blog_format', 'json',
  'city_route', '/service-areas/{slug}',
  'blog_route', '/blog/{slug}',
  'services_dir', 'src/app/services'
)
where repo_url = 'https://github.com/Compass2026/lucas_construction';
