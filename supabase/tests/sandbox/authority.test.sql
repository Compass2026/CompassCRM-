-- Tests for migration 0048 (Authority runs, opportunities, history, links),
-- run by scripts/test-portal-sandbox.sh after the 0047 tests, on the same
-- replay. Own harness schema (au). Fictional data only.
--
-- Callers, the way each reaches production:
--   function  psql as authenticator, role service_role (authority-run through PostgREST)
--   person    psql as authenticator, role authenticated, team JWT
--   portal    psql as authenticator, role authenticated, portal JWT
--   stranger  psql as authenticator, role authenticated, a sign-in on no team / portal row
--   anon      psql as authenticator, role anon
--   worker    psql as postgres (the Supabase connector's login)

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'
\set svc    '00000000-0000-4000-e000-0000000000a1'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema au;
create table au.results (n serial, status text, name text, detail text);
create table au.ids (k text primary key, id uuid);
grant usage on schema au to anon, authenticated, service_role;
grant insert, select on au.results to anon, authenticated, service_role;
grant select, insert, update on au.ids to anon, authenticated, service_role;
grant usage on sequence au.results_n_seq to anon, authenticated, service_role;

create function au.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into au.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function au.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function au.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function au.id(p_k text) returns uuid language sql stable as $$ select id from au.ids where k = p_k $$;
create function au.put(p_k text, p_id uuid) returns void language sql as $$
  insert into au.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id $$;

-- One engine opportunity, shaped like D1.1's output.
create function au.opp(p_key text, p_section text, p_action text, p_topic text, p_service uuid default null, p_tier text default 'B')
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', p_section, 'action', p_action, 'tier', p_tier,
    'content_type', case when p_key like 'gbp_post:%' then 'gbp_post' else 'data_fix' end, 'topic', p_topic,
    'service_id', p_service, 'objective', null, 'order', jsonb_build_array(1, -3, -3, -2, 0, 0, -40), 'eligible_from', null,
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', 'commercial', 'location', null, 'owner_path', '/x', 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
-- A finish payload for client p_client with these opportunities.
create function au.payload(p_client uuid, p_opps jsonb, p_status text default 'completed', p_as_of date default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('status', p_status, 'engine_version', 'authority-v1.1', 'judged_at', now(),
    'as_of', coalesce(p_as_of, current_date), 'input_hash', 'sha256:' || repeat('ab', 32),
    'section_hashes', authority_fingerprint(p_client),
    'inventory', jsonb_build_object('fetched_at', now(), 'pages', '[]'::jsonb), 'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', p_client), 'as_of', coalesce(p_as_of, current_date),
      'sources', jsonb_build_object('gsc', jsonb_build_object('coverage', 'complete')), 'opportunities', p_opps))
$$;
create function au.opp_id(p_client uuid, p_key text) returns uuid language sql stable security definer as $$
  select id from public.authority_opportunities where client_id = p_client and key = p_key $$;
create function au.state(p_client uuid, p_key text) returns text language sql stable security definer as $$
  select effective_status from public.authority_opportunity_state where client_id = p_client and key = p_key $$;
create function au.row(p_client uuid, p_key text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = p_client and key = p_key $$;
grant execute on all functions in schema au to anon, authenticated, service_role;

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
insert into services (id, client_id, name, status, page_url) values
  (:'svc', :'ca', 'Roof Replacement', 'approved', 'https://a.example.test/services/roof-replacement');
insert into tasks (client_id, title) values (:'ca', 'Build the Roof Repair page') returning id \gset task_a_
select au.put('task_a', :'task_a_id');
insert into tasks (client_id, title) values (:'cb', 'B task') returning id \gset task_b_
select au.put('task_b', :'task_b_id');
insert into change_log (client_id, change_type, object_type, status, after)
values (:'ca', 'page_added', 'site', 'proposed', '{"url": "https://a.example.test/services/roof-repair"}') returning id \gset cl_a_
select au.put('cl_a', :'cl_a_id');

-- ── S. Static checks ────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['authority_runs', 'authority_opportunities', 'authority_opportunity_events', 'authority_opportunity_links',
                           'authority_latest', 'authority_opportunity_state'] loop
    perform au.ok('S1 anon has no privilege on ' || t, not has_table_privilege('anon', 'public.' || t, 'select'));
    perform au.ok('S2 authenticated cannot write ' || t, not has_table_privilege('authenticated', 'public.' || t, 'insert')
      and not has_table_privilege('authenticated', 'public.' || t, 'update') and not has_table_privilege('authenticated', 'public.' || t, 'delete'));
  end loop;
  perform au.ok('S3 authenticated cannot begin or record runs',
    not has_function_privilege('authenticated', 'public.authority_begin_run(uuid, text, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.authority_record_run(uuid, jsonb)', 'execute'));
  perform au.ok('S4 anon cannot decide', not has_function_privilege('anon', 'public.authority_decide(uuid, text, jsonb)', 'execute'));
  perform au.ok('S5 no portal view reads Authority',
    not exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%' and definition ilike '%authority%'));
end $$;

-- ── W. The worker's SQL (postgres) writes nothing ───────────────────────────
do $$
declare e text;
begin
  e := au.try($q$insert into authority_runs (client_id, mode, requested_via) values ('00000000-0000-4000-b000-00000000000a', 'full', 'worker')$q$);
  perform au.ok('W1 the worker cannot insert a run', e like '42501%', e);
  e := au.try($q$select set_config('compass.authority_write', 'on', false);
                 insert into authority_runs (client_id, mode, requested_via) values ('00000000-0000-4000-b000-00000000000a', 'full', 'worker')$q$);
  perform au.ok('W2 ...not even with the write flag set', e like '42501%', e);
  perform set_config('compass.authority_write', '', false);
  e := au.try($q$select authority_begin_run('00000000-0000-4000-b000-00000000000a', 'full', 'worker')$q$);
  perform au.ok('W3 the worker cannot begin a run', e like '42501%', e);
end $$;
set role service_role;
do $$
declare e text := au.try($q$select authority_begin_run('00000000-0000-4000-b000-00000000000a', 'full', 'worker')$q$);
begin perform au.ok('W4 ...nor after SET ROLE service_role (session_user is still postgres)', e like '42501%', e); end $$;
reset role;

-- ── R. The authority-run function (authenticator → service_role) ────────────
\c - authenticator
set role service_role;
select au.as_user('service_role', null);
select au.put('r1', authority_begin_run(:'ca', 'full', 'worker'));
do $$
declare e text;
begin
  perform au.ok('R1 a run begins as running', (select status from authority_runs where id = au.id('r1')) = 'running');
  e := au.try($q$select authority_begin_run('00000000-0000-4000-b000-00000000000a', 'refresh', 'worker')$q$);
  perform au.ok('R2 one running run per client', e like '55P03%', e);
  e := au.try($q$select authority_begin_run('00000000-0000-4000-b000-00000000000b', 'full', 'worker')$q$);
  perform au.ok('R3 ...another client may run at the same time', e is null, e);
  e := au.try($q$insert into authority_runs (client_id, mode, requested_via) values ('00000000-0000-4000-b000-00000000000b', 'full', 'worker')$q$);
  perform au.ok('R4 a raw service-role insert is refused (only the functions write)', e like '42501%', e);
  e := au.try(format($q$update authority_runs set error = 'x' where id = %L$q$, au.id('r1')));
  perform au.ok('R5 a raw service-role update is refused', e like '42501%', e);
  e := au.try(format($q$select authority_record_run(%L, au.payload('00000000-0000-4000-b000-00000000000b', '[]'))$q$, au.id('r1')));
  perform au.ok('R6 a report for another client is refused', e like '22023%', e);
  e := au.try(format($q$select authority_record_run(%L, au.payload('00000000-0000-4000-b000-00000000000a',
       jsonb_build_array(au.opp('data_fix:x', 'fix_now', 'improve', 'X'), au.opp('data_fix:x', 'fix_now', 'improve', 'X'))))$q$, au.id('r1')));
  perform au.ok('R7 duplicate keys in one report are refused', e like '22023%', e);
end $$;
-- Finish run 1: five opportunities, one keyed by the service id.
select authority_record_run(au.id('r1'), au.payload(:'ca', jsonb_build_array(
  au.opp('service_page:' || :'svc', 'fix_now', 'create', 'Roof Replacement', :'svc', 'A'),
  au.opp('gbp_post:' || :'svc' || ':commercial', 'ready', 'create', 'Roof Replacement', :'svc'),
  au.opp('confirm_market:ofallon', 'needs_decision', 'requires_confirmation', 'Market: O''Fallon', null, 'none'),
  au.opp('topic:signs_replacement', 'research', 'research_required', 'Signs a roof may need replacement', null, 'none'),
  au.opp('data_fix:record-live-blog-posts', 'fix_now', 'improve', 'Content inventory'))));
do $$
declare e text;
begin
  perform au.ok('R8 a completed run creates one opportunity per key',
    (select count(*) from authority_opportunities where client_id = '00000000-0000-4000-b000-00000000000a') = 5);
  perform au.ok('R9 ...each open and present, with a created event',
    (select bool_and(status = 'open' and present) from authority_opportunities where client_id = '00000000-0000-4000-b000-00000000000a')
    and (select count(*) from authority_opportunity_events where client_id = '00000000-0000-4000-b000-00000000000a' and kind = 'created') = 5);
  perform au.ok('R10 the run is completed with counts and a diff',
    (select status = 'completed' and counts->'by_section'->>'fix_now' = '2' and jsonb_array_length(diff->'added') = 5
     from authority_runs where id = au.id('r1')));
  e := au.try(format($q$select authority_record_run(%L, au.payload('00000000-0000-4000-b000-00000000000a', '[]'))$q$, au.id('r1')));
  perform au.ok('R11 a finished run cannot be recorded again', e like '42501%', e);
  e := au.try(format($q$update authority_runs set counts = '{}' where id = %L$q$, au.id('r1')));
  perform au.ok('R12 a finished run is immutable', e like '42501%', e);
end $$;
reset role;

-- ── H. A person (authenticator → authenticated, team JWT) ───────────────────
set role authenticated;
select au.as_user('authenticated', :'team');
do $$
declare e text; a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  perform au.ok('H1 the team reads runs and opportunities',
    (select count(*) from authority_runs where client_id = a) = 1 and (select count(*) from authority_opportunities where client_id = a) = 5);
  perform au.ok('H2 ...and the latest run, not stale', (select stale_sections = '{}' from authority_latest where client_id = a));
  e := au.try(format($q$update authority_opportunities set status = 'dismissed' where id = %L$q$, au.opp_id(a, 'data_fix:record-live-blog-posts')));
  perform au.ok('H3 a person cannot update an opportunity directly', e like '42501%', e);
  e := au.try(format($q$delete from authority_runs where id = %L$q$, au.id('r1')));
  perform au.ok('H4 ...or delete a run', e like '42501%', e);
  -- accept
  perform authority_decide(au.opp_id(a, 'service_page:00000000-0000-4000-e000-0000000000a1'), 'accept');
  perform au.ok('H5 accept: open → accepted', au.state(a, 'service_page:00000000-0000-4000-e000-0000000000a1') = 'accepted');
  -- dismissal needs a reason; the date is optional and must be in the future
  e := au.try(format($q$select authority_decide(%L, 'dismiss', '{}')$q$, au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')));
  perform au.ok('H6 a dismissal without a reason is refused', e like '22023%', e);
  e := au.try(format($q$select authority_decide(%L, 'dismiss', jsonb_build_object('reason', 'x', 'until', current_date))$q$,
       au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')));
  perform au.ok('H7 dismissed_until must be in the future', e like '22023%', e);
  perform authority_decide(au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial'), 'dismiss',
    jsonb_build_object('reason', 'Waiting for new photos', 'until', current_date + 1));
  perform au.ok('H8 dismiss with a date: dismissed, not suppressed',
    (au.row(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')).status = 'dismissed'
    and not (au.row(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')).suppressed);
  perform authority_decide(au.opp_id(a, 'confirm_market:ofallon'), 'suppress', jsonb_build_object('reason', 'Not a market we serve'));
  perform au.ok('H9 suppress is explicit and separate', (au.row(a, 'confirm_market:ofallon')).suppressed);
  e := au.try(format($q$select authority_decide(%L, 'dismiss', '{"reason": "Not now"}')$q$, au.opp_id(a, 'topic:signs_replacement')));
  perform au.ok('H10 a normal dismissal without a date is refused', e like '22023%', e);
  perform au.ok('H10b ...and changed nothing', (au.row(a, 'topic:signs_replacement')).status = 'open');
  perform authority_decide(au.opp_id(a, 'topic:signs_replacement'), 'dismiss', jsonb_build_object('reason', 'Not now', 'until', current_date + 90));
  perform au.ok('H10c a 90-day dismissal: dismissed with its date, not suppressed',
    (au.row(a, 'topic:signs_replacement')).status = 'dismissed' and (au.row(a, 'topic:signs_replacement')).dismissed_until = current_date + 90
    and not (au.row(a, 'topic:signs_replacement')).suppressed);
  e := au.try(format($q$select authority_decide(%L, 'suppress', '{}')$q$, au.opp_id(a, 'data_fix:record-live-blog-posts')));
  perform au.ok('H10d a suppression needs a reason too', e like '22023%', e);
  -- links: accepted → in_progress only through a link; completed only when the asset is done
  perform authority_decide(au.opp_id(a, 'service_page:00000000-0000-4000-e000-0000000000a1'), 'link',
    jsonb_build_object('kind', 'task', 'id', au.id('task_a')));
  perform au.ok('H11 linking a task: accepted → in_progress', au.state(a, 'service_page:00000000-0000-4000-e000-0000000000a1') = 'in_progress');
  e := au.try(format($q$select authority_decide(%L, 'link', jsonb_build_object('kind', 'task', 'id', %L))$q$,
       au.opp_id(a, 'data_fix:record-live-blog-posts'), au.id('task_b')));
  perform au.ok('H12 linking another client''s task is refused (composite FK)', e like '23503%', e);
  e := au.try(format($q$select authority_decide(%L, 'dismiss', '{"reason": "x"}')$q$, au.opp_id(a, 'service_page:00000000-0000-4000-e000-0000000000a1')));
  perform au.ok('H13 an opportunity with open linked work cannot be dismissed', e like '22023%', e);
  perform authority_decide(au.opp_id(a, 'data_fix:record-live-blog-posts'), 'link', jsonb_build_object('kind', 'change_log', 'id', au.id('cl_a')));
  perform au.ok('H14 link on an open opportunity accepts it and moves it to in_progress',
    (au.row(a, 'data_fix:record-live-blog-posts')).status = 'accepted' and au.state(a, 'data_fix:record-live-blog-posts') = 'in_progress');
  e := au.try(format($q$insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind) values (%L, %L, 'decision', 'team')$q$,
       au.opp_id(a, 'data_fix:record-live-blog-posts'), a));
  perform au.ok('H15 history is written only by the functions', e like '42501%', e);
  perform authority_decide(au.opp_id(a, 'data_fix:record-live-blog-posts'), 'decision', '{"decision": "Recorded the 5 live posts"}');
  perform au.ok('H16 a decision is recorded in the history',
    exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'data_fix:record-live-blog-posts') and kind = 'decision'));
end $$;
reset role;

-- ── P. Portal contact, stranger, anon: nothing ──────────────────────────────
set role authenticated;
select au.as_user('authenticated', :'pa');
do $$
declare e text;
begin
  perform au.ok('P1 a portal contact reads no runs, even their own client''s', (select count(*) from authority_runs) = 0);
  perform au.ok('P2 ...no opportunities, history, links or state',
    (select count(*) from authority_opportunities) = 0 and (select count(*) from authority_opportunity_events) = 0
    and (select count(*) from authority_opportunity_links) = 0 and (select count(*) from authority_opportunity_state) = 0
    and (select count(*) from authority_latest) = 0);
  e := au.try(format($q$select authority_decide(%L, 'accept')$q$, au.opp_id('00000000-0000-4000-b000-00000000000a', 'topic:signs_replacement')));
  perform au.ok('P3 ...and cannot decide', e like '42501%', e);
end $$;
select au.as_user('authenticated', :'strngr');
do $$
declare e text;
begin
  perform au.ok('P4 a signed-in stranger reads nothing', (select count(*) from authority_runs) = 0 and (select count(*) from authority_opportunities) = 0);
  e := au.try(format($q$select authority_decide(%L, 'dismiss', '{"reason": "x"}')$q$, au.opp_id('00000000-0000-4000-b000-00000000000a', 'data_fix:record-live-blog-posts')));
  perform au.ok('P5 ...and cannot decide', e like '42501%', e);
end $$;
reset role;
set role anon;
select au.as_user('anon', null);
do $$
declare e text := au.try('select count(*) from authority_runs');
begin
  perform au.ok('P6 anon is refused outright', e like '42501%', e);
  e := au.try('select count(*) from authority_opportunities');
  perform au.ok('P7 ...on opportunities too', e like '42501%', e);
end $$;
reset role;

-- ── L. Asset lifecycle and a rename (as postgres) ───────────────────────────
\c - postgres
update tasks set status = 'done' where id = au.id('task_a');
update change_log set status = 'vetoed' where id = au.id('cl_a');
update services set name = 'Full Roof Replacement' where id = :'svc';
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  perform au.ok('L1 the linked task done → completed', au.state(a, 'service_page:00000000-0000-4000-e000-0000000000a1') = 'completed');
  perform au.ok('L2 a vetoed change is dead work → back to accepted', au.state(a, 'data_fix:record-live-blog-posts') = 'accepted');
  perform au.ok('L3 renaming the service makes the run stale (intelligence)',
    (select 'intelligence' = any (stale_sections) from authority_latest where client_id = a));
end $$;

-- ── N. Next runs: presence, degraded, regression, expiry, suppression ───────
\c - authenticator
set role service_role;
select au.as_user('service_role', null);
-- Run 2 (as of tomorrow): the service's topic carries its new name; the
-- blog-record item is no longer reported.
select au.put('r2', authority_begin_run(:'ca', 'refresh', 'worker'));
select authority_record_run(au.id('r2'), au.payload(:'ca', jsonb_build_array(
  au.opp('service_page:' || :'svc', 'fix_now', 'create', 'Full Roof Replacement', :'svc', 'A'),
  au.opp('gbp_post:' || :'svc' || ':commercial', 'ready', 'create', 'Full Roof Replacement', :'svc'),
  au.opp('confirm_market:ofallon', 'needs_decision', 'requires_confirmation', 'Market: O''Fallon', null, 'none'),
  au.opp('topic:signs_replacement', 'research', 'research_required', 'Signs a roof may need replacement', null, 'none')),
  'completed', current_date + 1));
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; s authority_opportunities;
begin
  s := au.row(a, 'service_page:00000000-0000-4000-e000-0000000000a1');
  perform au.ok('N1 the key survives the rename: same row, first seen in run 1, new topic',
    s.first_seen_run_id = au.id('r1') and s.last_seen_run_id = au.id('r2') and s.topic = 'Full Roof Replacement'
    and (select count(*) from authority_opportunities where client_id = a and key like 'service_page:%') = 1);
  perform au.ok('N2 a missing opportunity is resolved (no longer reported)',
    not (au.row(a, 'data_fix:record-live-blog-posts')).present and au.state(a, 'data_fix:record-live-blog-posts') = 'resolved'
    and (au.row(a, 'data_fix:record-live-blog-posts')).status = 'accepted'
    and exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'data_fix:record-live-blog-posts')
                and kind = 'resolved' and run_id = au.id('r2')));
  perform au.ok('N3 a dated dismissal expires on its date → open',
    (au.row(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')).status = 'open'
    and exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial') and kind = 'reopened'));
  perform au.ok('N4 a dismissal whose date has not come stays dismissed',
    (au.row(a, 'topic:signs_replacement')).status = 'dismissed');
  perform au.ok('N5 a suppression survives', (au.row(a, 'confirm_market:ofallon')).suppressed and au.state(a, 'confirm_market:ofallon') = 'dismissed');
end $$;

-- A resolved, never-linked opportunity (to test the resolved state).
select au.put('r3', authority_begin_run(:'ca', 'refresh', 'worker'));
select authority_record_run(au.id('r3'), au.payload(:'ca', jsonb_build_array(
  au.opp('service_page:' || :'svc', 'fix_now', 'create', 'Full Roof Replacement', :'svc', 'A'),
  au.opp('confirm_market:ofallon', 'needs_decision', 'requires_confirmation', 'Market: O''Fallon', null, 'none'),
  au.opp('topic:signs_replacement', 'research', 'research_required', 'Signs a roof may need replacement', null, 'none')),
  'completed', current_date + 1));
do $$ begin
  perform au.ok('N6 an open opportunity no longer reported reads as resolved',
    au.state('00000000-0000-4000-b000-00000000000a', 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial') = 'resolved');
end $$;

-- Run 4 is degraded and reports almost nothing: no presence or lifecycle change.
create temp table au_before as select id, present, status, section, last_seen_run_id from authority_opportunities;
select au.put('r4', authority_begin_run(:'ca', 'full', 'worker'));
select authority_record_run(au.id('r4'), au.payload(:'ca', jsonb_build_array(
  au.opp('topic:signs_replacement', 'research', 'research_required', 'Signs a roof may need replacement', null, 'none')), 'degraded', current_date + 30));
do $$ begin
  perform au.ok('N7 a degraded run is stored', (select status from authority_runs where id = au.id('r4')) = 'degraded');
  perform au.ok('N8 ...and changes no opportunity (presence, status, section, last seen)',
    not exists (select 1 from authority_opportunities o join au_before b using (id)
                where (o.present, o.status, o.section, o.last_seen_run_id) is distinct from (b.present, b.status, b.section, b.last_seen_run_id))
    and (select count(*) from authority_opportunities) = (select count(*) from au_before));
  perform au.ok('N9 ...and does not become the current run',
    (select run_id from authority_latest where client_id = '00000000-0000-4000-b000-00000000000a') = au.id('r3'));
end $$;

-- Run 5: the resolved items come back → regressed and open; a dismissal
-- whose item changed section stays dismissed until its date; the
-- suppression stays.
select au.put('r5', authority_begin_run(:'ca', 'refresh', 'worker'));
select authority_record_run(au.id('r5'), au.payload(:'ca', jsonb_build_array(
  au.opp('service_page:' || :'svc', 'fix_now', 'create', 'Full Roof Replacement', :'svc', 'A'),
  au.opp('gbp_post:' || :'svc' || ':commercial', 'ready', 'create', 'Full Roof Replacement', :'svc'),
  au.opp('data_fix:record-live-blog-posts', 'fix_now', 'improve', 'Content inventory'),
  au.opp('confirm_market:ofallon', 'needs_decision', 'requires_confirmation', 'Market: O''Fallon', null, 'none'),
  au.opp('topic:signs_replacement', 'avoid', 'avoid', 'Signs a roof may need replacement', null, 'none')),
  'completed', current_date + 60));
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  perform au.ok('N10 a reappearing opportunity regresses and returns to open (accepted → open)',
    (au.row(a, 'data_fix:record-live-blog-posts')).present and (au.row(a, 'data_fix:record-live-blog-posts')).status = 'open'
    and exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'data_fix:record-live-blog-posts') and kind = 'regressed'));
  perform au.ok('N11 ...the other one too', au.state(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial') = 'open');
  perform au.ok('N12 a change of section does not end a dismissal (only its date does)',
    (au.row(a, 'topic:signs_replacement')).status = 'dismissed'
    and exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'topic:signs_replacement') and kind = 'section_changed'));
  perform au.ok('N13 the suppression survives every run', (au.row(a, 'confirm_market:ofallon')).suppressed);
  perform au.ok('N14 completed work stays completed', au.state(a, 'service_page:00000000-0000-4000-e000-0000000000a1') = 'completed');
  perform au.ok('N15 run 5 diff lists the regressions',
    (select diff->'regressed' ? 'data_fix:record-live-blog-posts' from authority_runs where id = au.id('r5')));
end $$;
-- The function may accept and link (the Drafter path, later); nothing else.
do $$
declare e text; a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  e := au.try(format($q$select authority_decide(%L, 'dismiss', '{"reason": "x"}')$q$, au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')));
  perform au.ok('N16 the function cannot dismiss', e like '42501%', e);
  e := au.try(format($q$select authority_decide(%L, 'accept')$q$, au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial')));
  perform au.ok('N17 ...but may accept (the Drafter claims an opportunity)', e is null, e);
  perform au.ok('N18 ...recorded as the drafter', exists (select 1 from authority_opportunity_events
    where opportunity_id = au.opp_id(a, 'gbp_post:00000000-0000-4000-e000-0000000000a1:commercial') and kind = 'accepted' and actor_kind = 'drafter'));
end $$;
reset role;

-- Run 6, on the dismissal's date: it returns to open while still reported.
\c - authenticator
set role service_role;
select au.as_user('service_role', null);
select au.put('r6', authority_begin_run(:'ca', 'refresh', 'worker'));
select authority_record_run(au.id('r6'), au.payload(:'ca', jsonb_build_array(
  au.opp('service_page:' || :'svc', 'fix_now', 'create', 'Full Roof Replacement', :'svc', 'A'),
  au.opp('confirm_market:ofallon', 'needs_decision', 'requires_confirmation', 'Market: O''Fallon', null, 'none'),
  au.opp('topic:signs_replacement', 'avoid', 'avoid', 'Signs a roof may need replacement', null, 'none')),
  'completed', current_date + 90));
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  perform au.ok('N19 an expired dismissal returns to open when still reported',
    (au.row(a, 'topic:signs_replacement')).status = 'open' and (au.row(a, 'topic:signs_replacement')).dismissed_until is null
    and exists (select 1 from authority_opportunity_events where opportunity_id = au.opp_id(a, 'topic:signs_replacement')
                and kind = 'reopened' and run_id = au.id('r6') and detail->>'reason' = 'dismissal expired'));
  perform au.ok('N20 ...while the suppression still holds', (au.row(a, 'confirm_market:ofallon')).suppressed
    and au.state(a, 'confirm_market:ofallon') = 'dismissed');
end $$;
reset role;

-- ── C. Deleting a linked asset keeps the link's history ─────────────────────
\c - postgres
delete from tasks where id = au.id('task_b');
do $$ begin
  delete from change_log where id = au.id('cl_a');
  perform au.ok('C1 a deleted asset nulls the link column, the link row stays',
    (select change_log_id is null and ref_id = au.id('cl_a') from authority_opportunity_links where kind = 'change_log'));
end $$;

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from au.results group by status order by status;
select n, status, name, detail from au.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from au.results where status = 'fail';
  if f > 0 then raise exception '% authority check(s) failed', f; end if;
end $$;
