-- Security-definer regression tests (billing production-readiness review,
-- Sept 30 2026), run by scripts/test-portal-sandbox.sh after the 0062 suite.
-- Own harness schema (sd).
--
-- Every billing security-definer function (0058 – 0062), the planners and
-- the identity helpers the portal rests on pin search_path to `public,
-- pg_temp`, so a session's temporary tables cannot shadow the real ones; no
-- such function is executable by PUBLIC or anon; a signed-in user executes
-- only the self-scoping read helpers; every service-only function re-checks
-- its session.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'

\o /dev/null
create schema sd;
create table sd.results (n serial, status text, name text, detail text);
grant usage on schema sd to anon, authenticated, service_role, authenticator;
grant insert, select on sd.results to anon, authenticated, service_role, authenticator;
grant usage on sequence sd.results_n_seq to anon, authenticated, service_role, authenticator;
create function sd.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into sd.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function sd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function sd.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
grant execute on all functions in schema sd to anon, authenticated, service_role, authenticator;

-- ── S. Inventory ─────────────────────────────────────────────────────────────
create temp view sd_fns as
select p.oid, p.proname, p.proconfig, p.prorettype = 'trigger'::regtype as is_trigger
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and (p.proname like 'billing\_%' or p.proname like 'portal\_billing%' or p.proname like 'portal\_entitlement%'
       or p.proname in ('create_weekly_blog_tasks', 'fire_website_updates', 'record_client_agreement_event',
                        'portal_client_id', 'is_team'));
do $$
declare v text; n int;
begin
  select count(*) into n from sd_fns;
  perform sd.ok('S1 the inventory holds the billing security-definer functions (18 + portal_client_id + is_team)', n = 20, n::text);
  select string_agg(proname, ', ') into v from sd_fns
   where proconfig is null or not exists (select 1 from unnest(proconfig) c where c = 'search_path=public, pg_temp');
  perform sd.ok('S2 every one pins search_path = public, pg_temp', v is null, v);
  select string_agg(proname, ', ') into v from sd_fns
   where has_function_privilege('anon', oid, 'execute')
      or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = sd_fns.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE');
  perform sd.ok('S3 none is executable by PUBLIC or anon', v is null, v);
  select string_agg(proname, ', ' order by proname) into v from sd_fns where has_function_privilege('authenticated', oid, 'execute');
  perform sd.ok('S4 a signed-in user executes only the self-scoping helpers',
    v = 'billing_livemode, is_team, portal_billing_summary_row, portal_client_id, portal_entitlement_rows', v);
  select string_agg(proname, ', ') into v from sd_fns
   where not is_trigger and has_function_privilege('service_role', oid, 'execute')
     and proname not in ('billing_livemode', 'portal_billing_summary_row', 'portal_entitlement_rows', 'portal_client_id', 'is_team')
     and not exists (select 1 from pg_proc p where p.oid = sd_fns.oid
                     and (p.prosrc like '%billing_require_service()%' or p.prosrc like '%billing_caller_is_service()%'));
  perform sd.ok('S5 every service-role function re-checks its session in its own body', v is null, v);
  perform sd.ok('S6 the planners and the history trigger are not callable through the API (service_role included)',
    not has_function_privilege('service_role', 'create_weekly_blog_tasks()', 'execute')
    and not has_function_privilege('service_role', 'fire_website_updates(date)', 'execute')
    and not has_function_privilege('service_role', 'record_client_agreement_event()', 'execute'));
  select string_agg(pg_get_userbyid(p.proowner) || ':' || p.proname, ', ') into v
  from pg_proc p join sd_fns f on f.oid = p.oid where pg_get_userbyid(p.proowner) <> 'postgres';
  perform sd.ok('S7 every one is owned by postgres (the migration owner; not a superuser)', v is null, v);
end $$;

-- ── T. Temporary objects cannot shadow the real tables ───────────────────────
-- A signed-in user who could run SQL creates temp tables named like the ones
-- the functions read. With pg_temp last on the pinned path, the functions
-- still read public.*.
set role authenticated;
select sd.as_user('authenticated', :'strngr');
create temp table app_settings (key text, value jsonb);
insert into app_settings values ('billing', '{"livemode": true}');
create temp table portal_users (client_id uuid, auth_user_id uuid, is_active boolean, email text);
insert into portal_users values (:'ca', :'strngr', true, 'x@example.test');
create temp table team_members (id uuid, auth_user_id uuid, role text);
insert into team_members values (gen_random_uuid(), :'strngr', 'admin');
do $$ begin
  perform sd.ok('T1 billing_livemode() ignores a temp app_settings (stays test mode)', billing_livemode() = false);
  perform sd.ok('T2 portal_client_id() ignores a temp portal_users (a stranger stays nobody)', portal_client_id() is null);
  perform sd.ok('T3 a stranger still reads no portal billing through a shadow',
    (select count(*) from portal_billing_summary) + (select count(*) from portal_entitlements)
    + (select count(*) from portal_billing_summary_row()) + (select count(*) from portal_entitlement_rows()) = 0);
  perform sd.ok('T4 is_team() ignores a temp team_members (a stranger is not a teammate)', not is_team());
end $$;
drop table pg_temp.app_settings, pg_temp.portal_users, pg_temp.team_members;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── C. Caller identity is re-derived, never passed ───────────────────────────
set role authenticated;
select sd.as_user('authenticated', :'pa');
do $$
declare e text;
begin
  e := sd.try($q$select * from portal_billing_summary_row('00000000-0000-4000-b000-00000000000b')$q$);
  perform sd.ok('C1 the portal row functions take no client argument (nothing to spoof)', e like '42883%', e);
  e := sd.try($q$select billing_sync_apply('{}'::jsonb)$q$);
  perform sd.ok('C2 a portal contact cannot call the sync', e like '42501%', e);
  e := sd.try($q$select billing_record_external_payment('{}'::jsonb)$q$);
  perform sd.ok('C3 ...or record a payment', e like '42501%', e);
end $$;
reset role;
set role authenticated;
select sd.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := sd.try($q$select billing_link_customer('{}'::jsonb)$q$);
  perform sd.ok('C4 a teammate''s JWT cannot call a service-only function', e like '42501%', e);
  e := sd.try($q$select create_weekly_blog_tasks()$q$);
  perform sd.ok('C5 a teammate cannot run the planner', e like '42501%', e);
end $$;
reset role;
-- The service role through PostgREST (authenticator session): refused the
-- planners even though it holds the service key.
\c - authenticator
set role service_role;
do $$
declare e text;
begin
  e := sd.try($q$select create_weekly_blog_tasks()$q$);
  perform sd.ok('C6 the service role cannot run the weekly planner', e like '42501%', e);
  e := sd.try($q$select fire_website_updates()$q$);
  perform sd.ok('C7 ...or the website-update planner', e like '42501%', e);
end $$;
reset role;

\c - postgres
\o
\pset footer off
select status, count(*) from sd.results group by status order by status;
select n, status, name, detail from sd.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from sd.results where status = 'fail';
  if f > 0 then raise exception '% security-definer check(s) failed', f; end if;
end $$;
