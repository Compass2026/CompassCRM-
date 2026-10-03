-- Tests the billing cutover kit (supabase/cutover/*.sql) on the replay, after
-- every other suite (so 0058 – 0062 are applied). Inserts the eight production
-- clients (ids, names, statuses only) for 02_agreements.sql; the sandbox's own
-- fixture clients stand in for an active client with no agreement. Own harness
-- schema (ck).
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

-- ── 02: Compass Standard + the eight confirmed agreements ────────────────────
-- Refuses before the production clients exist (the replay removed them after 0056).
\set ON_ERROR_STOP off
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.sql
\set ON_ERROR_STOP on
select ck.ok('K3a agreements refuse while a client is missing, and write nothing',
  :'LAST_ERROR_MESSAGE' like 'agreements: client(s) missing or offboarded:%'
  and not exists (select 1 from billing_packages where key = 'compass_standard'), :'LAST_ERROR_MESSAGE');

-- The eight clients as production holds them (ids, names, statuses), without
-- the client-insert automation (as 03 does for the test client).
begin;
alter table clients disable trigger user;
insert into clients (id, name, status) values
  ('3eaa3389-2a33-4004-837c-8aef90404410', 'BHG Safety Partners', 'active'),
  ('70211d71-d9f4-46ab-abe2-ef39c41591fb', 'Logic Solar', 'active'),
  ('d94cfde2-0751-4002-a149-c83b4c6c956d', 'Show Me Design', 'active'),
  ('9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'Show Me Electrical', 'active'),
  ('db9009c2-a04b-4e93-843f-e20c49263b5b', 'Ginger Huff Interiors', 'launching'),
  ('102d3b20-2795-44ae-bd64-d1e43916291c', 'Lucas Construction', 'launching'),
  ('1e12fc47-731a-4d84-a4f1-4aed777db451', 'Pensacola Equipment Rentals', 'launching'),
  ('a88f5ce2-30ac-508b-b217-cf22d277b278', 'Shewmaker Brothers Masonry', 'launching');
alter table clients enable trigger user;
commit;
create table ck.eight (client_id uuid primary key, price int);
insert into ck.eight values
  ('3eaa3389-2a33-4004-837c-8aef90404410', 500), ('a88f5ce2-30ac-508b-b217-cf22d277b278', 500),
  ('70211d71-d9f4-46ab-abe2-ef39c41591fb', 650), ('d94cfde2-0751-4002-a149-c83b4c6c956d', 650),
  ('9a8e05f5-3d28-4839-9735-79bcdd0e277d', 650), ('102d3b20-2795-44ae-bd64-d1e43916291c', 650),
  ('db9009c2-a04b-4e93-843f-e20c49263b5b', 650), ('1e12fc47-731a-4d84-a4f1-4aed777db451', 650);

\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.sql
\ir ../../cutover/02_agreements.sql
select ck.ok('K3b agreements run cleanly and are idempotent', :'LAST_ERROR_MESSAGE' = '', :'LAST_ERROR_MESSAGE');
select ck.ok('K3c one Compass Standard package, standard, active, not yet mapped to Stripe, no prices',
  (select count(*) from billing_packages where key = 'compass_standard' or name ilike 'compass standard%') = 1
  and (select kind = 'standard' and active and stripe_product_id is null from billing_packages where key = 'compass_standard')
  and not exists (select 1 from billing_package_prices bpp join billing_packages bp on bp.id = bpp.package_id where bp.key = 'compass_standard'));
select ck.ok('K3d one entitlement definition: nine features, quotas 8 / 8 / 8 / 4 / 1',
  (select string_agg(service_key || '=' || case when enabled then coalesce(quantity::text, 'on') else 'off' end, ',' order by service_key)
     from package_entitlements pe join billing_packages bp on bp.id = pe.package_id where bp.key = 'compass_standard')
  = 'blog_posts=8,client_portal=on,crm=on,gbp=on,gbp_posts=8,hosting=on,paid_ads=on,reporting=on,seo=on,social=on,social_posts=8,website=on,website_pages=4,website_refreshes=1');
select ck.ok('K3e eight agreements on the one package: Stripe, month-to-month from 2026-10-01, no overrides',
  (select count(*) from plans pl join ck.eight e using (client_id) join billing_packages bp on bp.id = pl.package_id
    where bp.key = 'compass_standard' and pl.collection = 'stripe' and pl.external_method is null
      and pl.term_months is null and pl.renewal_date is null and pl.start_date = '2026-10-01') = 8
  and not exists (select 1 from client_entitlement_overrides o join ck.eight e using (client_id)));
select ck.ok('K3f six at the $650 default, BHG and Shewmaker at the $500 legacy price',
  (select count(*) from plans pl join ck.eight e using (client_id) where e.price = 650 and pl.notes like 'Compass Standard at the default price, $650.00/month.%') = 6
  and (select string_agg(c.name, ',' order by c.name) from plans pl join clients c on c.id = pl.client_id
        where pl.notes like 'Compass Standard at the legacy price, $500.00/month%') = 'BHG Safety Partners,Shewmaker Brothers Masonry');
select ck.ok('K3g every one of the eight reads the same entitlements from the package',
  (select count(distinct x) from (
     select e.client_id, string_agg(f.service_key || '=' || f.enabled || '/' || coalesce(f.quantity::text, '-') || '/' || f.source, ',' order by f.service_key) x
     from ck.eight e cross join lateral client_entitlements_for(e.client_id) f group by e.client_id) d) = 1
  and (select count(*) from ck.eight e cross join lateral client_entitlements_for(e.client_id) f where f.enabled) = 8 * 14
  and (select bool_and(f.source = 'package') from ck.eight e cross join lateral client_entitlements_for(e.client_id) f where f.enabled));
select ck.ok('K3h this month''s blog allocation is 8 for an active client on Compass Standard',
  (select allocation from client_quota_usage('3eaa3389-2a33-4004-837c-8aef90404410') where service_key = 'blog_posts') = 8);
select ck.ok('K3i each agreement is in the agreement history once, with no actor (run as postgres)',
  (select count(*) from client_agreement_events ev join ck.eight e using (client_id)
    where ev.subject = 'plan' and ev.action = 'insert' and ev.actor_team_member_id is null) = 8);

-- A differing existing agreement is refused, and the refusal writes nothing.
delete from plans where client_id = '102d3b20-2795-44ae-bd64-d1e43916291c';
update plans set start_date = '2026-11-01' where client_id = '3eaa3389-2a33-4004-837c-8aef90404410';
\set ON_ERROR_STOP off
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.sql
\set ON_ERROR_STOP on
select ck.ok('K3j a differing agreement is refused and named; nothing is written',
  :'LAST_ERROR_MESSAGE' like 'agreements: existing agreement differs from the confirmed terms%BHG Safety Partners%'
  and :'LAST_ERROR_MESSAGE' not like '%Lucas%'
  and not exists (select 1 from plans where client_id = '102d3b20-2795-44ae-bd64-d1e43916291c')
  and (select start_date from plans where client_id = '3eaa3389-2a33-4004-837c-8aef90404410') = '2026-11-01', :'LAST_ERROR_MESSAGE');
update plans set start_date = '2026-10-01' where client_id = '3eaa3389-2a33-4004-837c-8aef90404410';
update package_entitlements set quantity = 9 where service_key = 'blog_posts'
  and package_id = (select id from billing_packages where key = 'compass_standard');
\set ON_ERROR_STOP off
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.sql
\set ON_ERROR_STOP on
select ck.ok('K3k a differing entitlement definition is refused and named',
  :'LAST_ERROR_MESSAGE' like 'agreements: compass_standard entitlements differ%blog_posts has 9%'
  and not exists (select 1 from plans where client_id = '102d3b20-2795-44ae-bd64-d1e43916291c'), :'LAST_ERROR_MESSAGE');
update package_entitlements set quantity = 8 where service_key = 'blog_posts'
  and package_id = (select id from billing_packages where key = 'compass_standard');
\set LAST_ERROR_MESSAGE ''
\ir ../../cutover/02_agreements.sql
select ck.ok('K3l once corrected, a re-run restores the missing agreement',
  :'LAST_ERROR_MESSAGE' = '' and (select count(*) from plans join ck.eight using (client_id)) = 8, :'LAST_ERROR_MESSAGE');

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
select ck.ok('K8 validate refuses while an active client has no agreement, and names none of the eight',
  :'LAST_ERROR_MESSAGE' like 'cutover: active client(s) with no agreement:%'
  and not exists (select 1 from ck.eight e where :'LAST_ERROR_MESSAGE' like '%' || e.client_id || '%'), :'LAST_ERROR_MESSAGE');
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
select ck.ok('K9a none of the eight needed excluding',
  not exists (select 1 from ck.eight e where e.client_id = any (current_setting('compass.cutover_excluded')::uuid[])));

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
