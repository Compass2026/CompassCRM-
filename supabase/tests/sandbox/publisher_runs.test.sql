-- Tests for migration 0046 (Business Profile publisher), run by
-- scripts/test-portal-sandbox.sh against the full replay + fixtures, after
-- the other sandbox tests. Own harness schema (pb).
--
-- The publisher's behaviour is tested end to end by npm run test:publisher
-- (the real function over PostgREST); this file pins the schema it relies
-- on: who can read and write publisher_runs, the outcomes it accepts
-- (including uncertain and ambiguous), that a reminder is a cycle rather
-- than a lifetime flag, and publisher_reminder_state()'s "latest event
-- wins" rule.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'

\o /dev/null
create schema pb;
create table pb.results (n serial, status text, name text, detail text);
create table pb.ids (k text primary key, id uuid);
grant usage on schema pb to anon, authenticated, service_role;
grant insert, select on pb.results to anon, authenticated, service_role;
grant select on pb.ids to anon, authenticated, service_role;
grant usage on sequence pb.results_n_seq to anon, authenticated, service_role;
create function pb.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into pb.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function pb.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function pb.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute format('select count(*) from (%s) q', p_sql) into n; return n;
exception when others then return -1; end $$;
create function pb.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function pb.id(p_k text) returns uuid language sql stable as $$ select id from pb.ids where k = p_k $$;
grant execute on all functions in schema pb to anon, authenticated, service_role;

-- ── Shape (as postgres) ─────────────────────────────────────────────────────
do $$
begin
  perform pb.ok('S1 publisher_runs has RLS and only an is_team() read policy',
    (select relrowsecurity from pg_class where oid = 'public.publisher_runs'::regclass)
    and (select count(*) from pg_policies where tablename = 'publisher_runs') = 1
    and exists (select 1 from pg_policies where tablename = 'publisher_runs' and cmd = 'SELECT' and qual like '%is_team()%'));
  perform pb.ok('S2 anon has no privilege on publisher_runs',
    not has_table_privilege('anon', 'public.publisher_runs', 'select,insert,update,delete,truncate'));
  perform pb.ok('S3 authenticated may only read publisher_runs',
    has_table_privilege('authenticated', 'public.publisher_runs', 'select')
    and not has_table_privilege('authenticated', 'public.publisher_runs', 'insert,update,delete,truncate'));
  perform pb.ok('S4 no unique index beyond the key: reminders are cycles, not a lifetime flag',
    not exists (select 1 from pg_indexes where tablename = 'publisher_runs' and indexdef ilike '%unique%' and indexname <> 'publisher_runs_pkey'));
  perform pb.ok('S5 publisher_reminder_state is for the service role only',
    not has_function_privilege('anon', 'public.publisher_reminder_state(uuid[])', 'execute')
    and not has_function_privilege('authenticated', 'public.publisher_reminder_state(uuid[])', 'execute')
    and has_function_privilege('service_role', 'public.publisher_reminder_state(uuid[])', 'execute'));
  perform pb.ok('S6 the switch is off with an empty pilot list',
    (select value = '{"enabled": false, "clients": []}'::jsonb from app_settings where key = 'publisher'));
  perform pb.ok('S7 the tick runs every 5 minutes',
    exists (select 1 from cron.job where jobname = 'post-publisher-tick' and schedule = '*/5 * * * *'));
  perform pb.ok('S8 no portal view reads publisher_runs',
    not exists (select 1 from pg_views where viewname like 'portal\_%' and definition ilike '%publisher_runs%'));
end $$;

-- ── Fixtures: two Facebook posts (worker drafts are enough for runs) ─────────
-- Inserted by the cluster superuser: since 0047 the worker's own SQL cannot
-- create posts (only the post-drafter function can).
\c - supabase_admin
do $$
declare v uuid;
begin
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
  values ('00000000-0000-4000-b000-00000000000a', 'facebook', 'navigational', true, 'Sandbox Client A, plumbing in Springfield.')
  returning id into v;
  insert into pb.ids values ('fb1', v);
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
  values ('00000000-0000-4000-b000-00000000000a', 'instagram', 'navigational', true, 'Sandbox Client A, open Saturdays.')
  returning id into v;
  insert into pb.ids values ('ig1', v);
end $$;
\c - postgres

-- ── The publisher writes (service role) ─────────────────────────────────────
set role service_role;
select pb.as_user('service_role', null);
do $$
declare st text;
begin
  -- Outcomes, including the two the hardening added.
  foreach st in array array['published','reconciled','uncertain','ambiguous','failed','blocked','lapsed','retry_scheduled'] loop
    perform pb.ok('W1 outcome accepted: ' || st,
      pb.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome) values (%L, %L, 'tick', %L)$q$,
        pb.id('ig1'), '00000000-0000-4000-b000-00000000000a', st)) is null);
  end loop;
  st := pb.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome) values (%L, %L, 'tick', 'maybe')$q$,
    pb.id('ig1'), '00000000-0000-4000-b000-00000000000a'));
  perform pb.ok('W2 an unknown outcome is refused', st like '23514%', st);
  st := pb.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome) values (%L, %L, 'tick', 'published')$q$,
    pb.id('ig1'), '00000000-0000-4000-b000-00000000000b'));
  perform pb.ok('W3 a run must belong to its post''s client', st like '23503%', st);

  -- A reminder cycle, twice, on the same post: opened → closed → opened.
  insert into publisher_runs (post_id, client_id, mode, outcome, detail) values
    (pb.id('fb1'), '00000000-0000-4000-b000-00000000000a', 'reminder', 'reminder_opened', 'first cycle'),
    (pb.id('fb1'), '00000000-0000-4000-b000-00000000000a', 'reminder', 'reminder_closed', 'No longer scheduled');
  st := pb.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, detail) values (%L, %L, 'reminder', 'reminder_opened', 'second cycle')$q$,
    pb.id('fb1'), '00000000-0000-4000-b000-00000000000a'));
  perform pb.ok('R1 a second reminder_opened for the same post is accepted (a new cycle)', st is null, st);
  perform pb.ok('R2 the latest event wins: the post has an open reminder',
    (select outcome from publisher_reminder_state(array[pb.id('fb1')])) = 'reminder_opened'
    and (select detail from publisher_runs where post_id = pb.id('fb1') order by id desc limit 1) = 'second cycle');
  perform pb.ok('R3 posts without reminders are not listed; the unfiltered call lists each post once',
    pb.cnt(format('select 1 from publisher_reminder_state(array[%L::uuid])', pb.id('ig1'))) = 0
    and pb.cnt('select 1 from publisher_reminder_state() where post_id = ''' || pb.id('fb1') || '''') = 1);
  insert into publisher_runs (post_id, client_id, mode, outcome, detail)
  values (pb.id('fb1'), '00000000-0000-4000-b000-00000000000a', 'reminder', 'reminder_closed', 'Marked published');
  perform pb.ok('R4 closing the second cycle closes the reminder',
    (select outcome from publisher_reminder_state(array[pb.id('fb1')])) = 'reminder_closed');
  perform pb.ok('R5 other outcomes never count as reminder events',
    (select count(*) from publisher_reminder_state(array[pb.id('ig1'), pb.id('fb1')])) = 1);
end $$;
reset role;

-- ── People ──────────────────────────────────────────────────────────────────
set role authenticated;
select pb.as_user('authenticated', :'team');
do $$
declare st text;
begin
  perform pb.ok('P1 a team member reads the runs', pb.cnt('select 1 from publisher_runs') >= 12);
  st := pb.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome) values (%L, %L, 'now', 'published')$q$,
    pb.id('fb1'), '00000000-0000-4000-b000-00000000000a'));
  perform pb.ok('P2 a team member cannot write a run', st like '42501%', st);
  st := pb.try('delete from publisher_runs');
  perform pb.ok('P3 a team member cannot delete runs', st like '42501%', st);
  st := pb.try('select * from publisher_reminder_state()');
  perform pb.ok('P4 a team member cannot call publisher_reminder_state', st like '42501%', st);
end $$;
select pb.as_user('authenticated', :'pa');
do $$ begin
  perform pb.ok('P5 a portal contact sees no runs', pb.cnt('select 1 from publisher_runs') = 0);
end $$;
select pb.as_user('authenticated', :'strngr');
do $$ begin
  perform pb.ok('P6 a sign-in on neither list sees no runs', pb.cnt('select 1 from publisher_runs') = 0);
end $$;
reset role;
set role anon;
select pb.as_user('anon', null);
do $$ begin
  perform pb.ok('P7 anon cannot read runs', pb.try('select 1 from publisher_runs') like '42501%');
end $$;
reset role;

-- ── Cleanup of the posts (runs go with them) ────────────────────────────────
do $$ begin
  delete from social_posts where id in (pb.id('fb1'), pb.id('ig1'));
  perform pb.ok('C1 runs are deleted with their post', pb.cnt(format('select 1 from publisher_runs where post_id in (%L, %L)', pb.id('fb1'), pb.id('ig1'))) = 0);
end $$;

\o
\pset footer off
select status, count(*) from pb.results group by status order by status;
select n, status, name, detail from pb.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from pb.results where status = 'fail';
  if f > 0 then raise exception '% publisher check(s) failed', f; end if;
end $$;
