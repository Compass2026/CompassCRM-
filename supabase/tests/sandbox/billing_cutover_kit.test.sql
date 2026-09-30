-- Tests the billing cutover kit (supabase/cutover/*.sql) on the replay, after
-- every other suite (so 0058 – 0062 are applied and the sandbox holds active
-- clients without agreements, as production will). Own harness schema (ck).
\o /dev/null
create schema ck;
create table ck.results (n serial, status text, name text, detail text);
create function ck.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into ck.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create table ck.saved (k text primary key, v text);
insert into ck.saved select 'jobs_before', string_agg(jobname || '=' || active, ',' order by jobname) from cron.job;
insert into ck.saved select 'fires_before', count(*)::text from worker_fires;

-- ── 01: pause ────────────────────────────────────────────────────────────────
\ir ../../cutover/01_pause_automation.sql
select ck.ok('K1 pause: the three planners are paused',
  (select bool_and(not active) from cron.job where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting'))
  and (select count(*) from cron.job where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting')) = 3);
select ck.ok('K2 pause: nothing else is paused',
  not exists (select 1 from cron.job where not active and jobname not in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting')));

-- ── 02: the template refuses to run ──────────────────────────────────────────
\set ON_ERROR_STOP off
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.template.sql
\set ON_ERROR_STOP on
select ck.ok('K3 the agreements template refuses to run until filled in', :'LAST_ERROR_MESSAGE' like 'Template:%', :'LAST_ERROR_MESSAGE');

-- ── 03: the test client ──────────────────────────────────────────────────────
\ir ../../cutover/03_test_client.sql
\ir ../../cutover/03_test_client.sql
select ck.ok('K4 test client: one fictional client, paused, idempotent',
  (select count(*) from clients where name = 'Compass Billing Test Client (TEST)') = 1
  and (select status::text from clients where id = 'c0ffee00-0000-4000-b000-00000000b111') = 'paused');
select ck.ok('K5 test client: no worker fire, task, pipeline or brand row was created for it',
  not exists (select 1 from worker_fires where client_id = 'c0ffee00-0000-4000-b000-00000000b111')
  and not exists (select 1 from tasks where client_id = 'c0ffee00-0000-4000-b000-00000000b111')
  and not exists (select 1 from client_pipelines where client_id = 'c0ffee00-0000-4000-b000-00000000b111')
  and (select v::int from ck.saved where k = 'fires_before') = (select count(*) from worker_fires));
select ck.ok('K6 test client: the client-insert automation is enabled again',
  (select bool_and(tgenabled = 'O') from pg_trigger where tgrelid = 'public.clients'::regclass and not tgisinternal));
select ck.ok('K7 test client: its agreement gives the test scope (4 / 8 / 30 / 2 / 2)',
  (select string_agg(service_key || '=' || quantity, ',' order by service_key)
     from client_entitlements_for('c0ffee00-0000-4000-b000-00000000b111') where kind = 'quota')
  = 'blog_posts=4,gbp_posts=8,social_posts=30,website_pages=2,website_refreshes=2'
  and (select count(*) from client_entitlements_for('c0ffee00-0000-4000-b000-00000000b111') where kind = 'feature' and enabled) = 7);

-- ── 04: validation refuses while an active client has no agreement ──────────
\set ON_ERROR_STOP off
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/04_validate.sql
\set ON_ERROR_STOP on
select ck.ok('K8 validate refuses while an active client has no agreement', :'LAST_ERROR_MESSAGE' like 'cutover: active client(s) with no agreement:%', :'LAST_ERROR_MESSAGE');
-- Give one an agreement, deliberately exclude the rest (as Tom would, by id).
insert into plans (client_id, package_id, collection)
select c.id, 'c0ffee00-0000-4000-c000-00000000b111', 'stripe' from clients c
where c.id = '00000000-0000-4000-b000-00000000000a' and not exists (select 1 from plans p where p.client_id = c.id);
select set_config('compass.cutover_excluded',
  (select coalesce(array_agg(c.id)::text, '{}') from clients c where c.status = 'active'
     and not exists (select 1 from plans p where p.client_id = c.id and p.package_id is not null)
     and not exists (select 1 from client_entitlement_overrides o where o.client_id = c.id)), false);
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/04_validate.sql
select ck.ok('K9 validate passes once every active client has an agreement or is excluded', :'LAST_ERROR_MESSAGE' = '', :'LAST_ERROR_MESSAGE');

-- ── 05: resume ───────────────────────────────────────────────────────────────
\ir ../../cutover/05_resume_automation.sql
select ck.ok('K10 resume: the cron jobs are exactly as before the pause',
  (select string_agg(jobname || '=' || active, ',' order by jobname) from cron.job) = (select v from ck.saved where k = 'jobs_before'));

\o
\pset footer off
select status, count(*) from ck.results group by status order by status;
select n, status, name, detail from ck.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from ck.results where status = 'fail';
  if f > 0 then raise exception '% cutover kit check(s) failed', f; end if;
end $$;
