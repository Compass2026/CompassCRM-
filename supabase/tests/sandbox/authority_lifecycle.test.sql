-- Authority lifecycle actions (PR A of Authority Decisions): accept, release,
-- dismiss for 30 / 60 / 90 days, never recommend again and reopen, all
-- through 0048's authority_decide, the only writer. Run by
-- scripts/test-portal-sandbox.sh after authority.test.sql, on the same
-- replay, on a client of its own. Own harness schema (al). Fictional data.
--
-- Callers, the way each reaches production:
--   person    psql as authenticator, role authenticated, team JWT (the app's server action)
--   portal    psql as authenticator, role authenticated, portal JWT
--   stranger  psql as authenticator, role authenticated, a sign-in on no team / portal row
--   anon      psql as authenticator, role anon
--   function  psql as authenticator, role service_role (authority-run)
--   worker    psql as postgres

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set cl     '00000000-0000-4000-b000-0000000000c1'

\c - postgres
\o /dev/null
create schema al;
create table al.results (n serial, status text, name text, detail text);
create table al.ids (k text primary key, id uuid);
grant usage on schema al to anon, authenticated, service_role;
grant insert, select on al.results to anon, authenticated, service_role;
grant select, insert, update on al.ids to anon, authenticated, service_role;
grant usage on sequence al.results_n_seq to anon, authenticated, service_role;

create function al.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into al.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function al.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function al.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function al.id(p_k text) returns uuid language sql stable as $$ select id from al.ids where k = p_k $$;
create function al.put(p_k text, p_id uuid) returns void language sql as $$
  insert into al.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id $$;
create function al.opp(p_key text, p_section text default 'fix_now') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', p_section, 'action', 'improve', 'tier', 'B', 'content_type', 'data_fix',
    'topic', p_key, 'service_id', null, 'objective', null, 'order', jsonb_build_array(1), 'eligible_from', null,
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', null, 'owner_path', '/x', 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture'))) $$;
create function al.opps() returns jsonb language sql immutable as $$
  select jsonb_agg(al.opp(k)) from unnest(array['data_fix:accept', 'data_fix:d30', 'data_fix:d60', 'data_fix:d90',
    'data_fix:never', 'data_fix:linked', 'data_fix:portal']) k $$;
create function al.payload(p_status text, p_as_of date) returns jsonb language sql stable as $$
  select jsonb_build_object('status', p_status, 'engine_version', 'authority-v1.1', 'judged_at', now(), 'as_of', p_as_of,
    'input_hash', 'sha256:' || repeat('cd', 32), 'section_hashes', authority_fingerprint('00000000-0000-4000-b000-0000000000c1'),
    'inventory', jsonb_build_object('fetched_at', now(), 'pages', '[]'::jsonb), 'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', '00000000-0000-4000-b000-0000000000c1'), 'as_of', p_as_of,
      'sources', jsonb_build_object('gsc', jsonb_build_object('coverage', 'complete')), 'opportunities', al.opps())) $$;
-- one full run, as the authority-run function
create function al.run(p_status text, p_as_of date) returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run('00000000-0000-4000-b000-0000000000c1', 'refresh', 'worker');
  perform authority_record_run(r, al.payload(p_status, p_as_of));
  return r;
end $$;
create function al.oid(p_key text) returns uuid language sql stable security definer as $$
  select id from public.authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000c1' and key = p_key $$;
create function al.row(p_key text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000c1' and key = p_key $$;
create function al.state(p_key text) returns text language sql stable security definer as $$
  select effective_status from public.authority_opportunity_state where client_id = '00000000-0000-4000-b000-0000000000c1' and key = p_key $$;
create function al.events(p_key text, p_kind text) returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_events where opportunity_id = al.oid(p_key) and kind = p_kind $$;
create function al.last_event(p_key text) returns public.authority_opportunity_events language sql stable security definer as $$
  select * from public.authority_opportunity_events where opportunity_id = al.oid(p_key) order by created_at desc, id desc limit 1 $$;
create function al.decide(p_key text, p_verb text, p_payload jsonb default '{}') returns text language sql as $$
  select al.try(format('select authority_decide(%L, %L, %L::jsonb)', al.oid(p_key), p_verb, p_payload)) $$;
create function al.chicago_today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
grant execute on all functions in schema al to anon, authenticated, service_role;

insert into clients (id, name, city, state, website_url, status) values
  (:'cl', 'Lifecycle Roofing', 'Wentzville', 'MO', 'https://lifecycle.example.test', 'active');
insert into tasks (client_id, title) values (:'cl', 'Fix the page') returning id \gset task_
select al.put('task', :'task_id');

-- ── R. One completed run with seven opportunities (the function) ────────────
\c - authenticator
set role service_role;
select al.as_user('service_role', null);
select al.put('r1', al.run('completed', al.chicago_today()));
do $$ begin
  perform al.ok('R1 seven open opportunities', (select count(*) from authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000c1' and status = 'open') = 7);
end $$;
-- The function may accept / link (the Drafter path) but never dismiss, suppress, release or reopen.
do $$
declare e text;
begin
  e := al.decide('data_fix:portal', 'dismiss', jsonb_build_object('reason', 'x', 'until', al.chicago_today() + 30));
  perform al.ok('F1 the service caller cannot dismiss', e like '42501%', e);
  e := al.decide('data_fix:portal', 'suppress', '{"reason": "x"}');
  perform al.ok('F2 ...or suppress', e like '42501%', e);
  e := al.decide('data_fix:portal', 'reopen');
  perform al.ok('F3 ...or reopen', e like '42501%', e);
end $$;
reset role;

-- ── L. A teammate ───────────────────────────────────────────────────────────
set role authenticated;
select al.as_user('authenticated', :'team');
do $$
declare e text; me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  -- Accept, and a duplicate accept
  e := al.decide('data_fix:accept', 'accept');
  perform al.ok('L1 accept: open → accepted', e is null and (al.row('data_fix:accept')).status = 'accepted', e);
  perform al.ok('L2 ...one accepted event naming the teammate',
    al.events('data_fix:accept', 'accepted') = 1 and (al.last_event('data_fix:accept')).actor_kind = 'team' and (al.last_event('data_fix:accept')).actor_id = me);
  perform al.ok('L3 ...decided_by / decided_at stamped', (al.row('data_fix:accept')).decided_by = me and (al.row('data_fix:accept')).decided_at is not null);
  e := al.decide('data_fix:accept', 'accept');
  perform al.ok('L4 a duplicate accept is refused and records nothing', e like '22023%' and al.events('data_fix:accept', 'accepted') = 1, e);
  -- Release, and a duplicate release
  e := al.decide('data_fix:accept', 'release');
  perform al.ok('L5 release: accepted → open', e is null and (al.row('data_fix:accept')).status = 'open' and al.events('data_fix:accept', 'released') = 1, e);
  e := al.decide('data_fix:accept', 'release');
  perform al.ok('L6 a duplicate release is refused', e like '22023%' and al.events('data_fix:accept', 'released') = 1, e);
  e := al.decide('data_fix:accept', 'reopen');
  perform al.ok('L7 reopen of an open opportunity is refused', e like '22023%', e);

  -- 30 / 60 / 90 days
  e := al.decide('data_fix:d30', 'dismiss', jsonb_build_object('reason', 'After the photo shoot', 'until', al.chicago_today() + 30));
  perform al.ok('L8 dismiss for 30 days', e is null and (al.row('data_fix:d30')).dismissed_until = al.chicago_today() + 30
    and al.state('data_fix:d30') = 'dismissed' and not (al.row('data_fix:d30')).suppressed, e);
  e := al.decide('data_fix:d60', 'dismiss', jsonb_build_object('reason', 'Budget next quarter', 'until', al.chicago_today() + 60));
  perform al.ok('L9 dismiss for 60 days', e is null and (al.row('data_fix:d60')).dismissed_until = al.chicago_today() + 60, e);
  e := al.decide('data_fix:d90', 'dismiss', jsonb_build_object('reason', 'Seasonal', 'until', al.chicago_today() + 90));
  perform al.ok('L10 dismiss for 90 days', e is null and (al.row('data_fix:d90')).dismissed_until = al.chicago_today() + 90, e);
  perform al.ok('L11 the dismissal event carries the reason and the date',
    (al.last_event('data_fix:d60')).kind = 'dismissed' and (al.last_event('data_fix:d60')).detail->>'reason' = 'Budget next quarter'
    and ((al.last_event('data_fix:d60')).detail->>'until')::date = al.chicago_today() + 60);
  e := al.decide('data_fix:portal', 'dismiss', jsonb_build_object('reason', '   ', 'until', al.chicago_today() + 30));
  perform al.ok('L12 a blank reason is refused', e like '22023%' and (al.row('data_fix:portal')).status = 'open', e);
  e := al.decide('data_fix:portal', 'dismiss', jsonb_build_object('reason', 'x', 'until', al.chicago_today()));
  perform al.ok('L13 today is not a future date', e like '22023%', e);

  -- Never recommend again, then reopen
  e := al.decide('data_fix:never', 'suppress', '{"reason": "Not a service they offer"}');
  perform al.ok('L14 never recommend again: dismissed + suppressed, no date',
    e is null and (al.row('data_fix:never')).suppressed and (al.row('data_fix:never')).dismissed_until is null
    and (al.row('data_fix:never')).status_reason = 'Not a service they offer' and al.events('data_fix:never', 'suppressed') = 1, e);

  -- Linked work blocks dismissal and suppression
  perform authority_decide(al.oid('data_fix:linked'), 'link', jsonb_build_object('kind', 'task', 'id', al.id('task')));
  perform al.ok('L15 a linked open task: in progress', al.state('data_fix:linked') = 'in_progress');
  e := al.decide('data_fix:linked', 'dismiss', jsonb_build_object('reason', 'x', 'until', al.chicago_today() + 30));
  perform al.ok('L16 dismissal refused while linked work is open', e like '22023%Work is linked%' and (al.row('data_fix:linked')).status = 'accepted', e);
  e := al.decide('data_fix:linked', 'suppress', '{"reason": "x"}');
  perform al.ok('L17 ...and never-recommend too', e like '22023%Work is linked%' and not (al.row('data_fix:linked')).suppressed, e);
end $$;
reset role;

-- ── P. Portal contact, stranger, anon, the worker: every lifecycle verb refused ─
set role authenticated;
select al.as_user('authenticated', :'pa');
do $$
declare e text; v text;
begin
  perform al.ok('P1 a portal contact reads no opportunity', (select count(*) from authority_opportunities) = 0);
  foreach v in array array['accept', 'release', 'dismiss', 'suppress', 'reopen'] loop
    e := al.decide('data_fix:portal', v, jsonb_build_object('reason', 'x', 'until', al.chicago_today() + 30));
    perform al.ok('P2 a portal contact cannot ' || v, e like '42501%', e);
  end loop;
end $$;
select al.as_user('authenticated', :'strngr');
do $$
declare e text; v text;
begin
  foreach v in array array['accept', 'release', 'dismiss', 'suppress', 'reopen'] loop
    e := al.decide('data_fix:portal', v, jsonb_build_object('reason', 'x', 'until', al.chicago_today() + 30));
    perform al.ok('P3 a signed-in stranger cannot ' || v, e like '42501%', e);
  end loop;
end $$;
reset role;
set role anon;
select al.as_user('anon', null);
do $$ declare e text := al.decide('data_fix:portal', 'accept');
begin perform al.ok('P4 anon cannot call authority_decide', e like '42501%', e); end $$;
reset role;
\c - postgres
do $$
declare e text;
begin
  e := al.decide('data_fix:portal', 'accept');
  perform al.ok('P5 the worker''s SQL cannot accept', e like '42501%', e);
  e := al.decide('data_fix:portal', 'suppress', '{"reason": "x"}');
  perform al.ok('P6 ...or suppress', e like '42501%', e);
  perform al.ok('P7 ...so the opportunity is untouched', (al.row('data_fix:portal')).status = 'open' and al.events('data_fix:portal', 'created') = 1
    and (select count(*) from authority_opportunity_events where opportunity_id = al.oid('data_fix:portal')) = 1);
end $$;

-- ── N. Later runs: dates hold, suppression persists ─────────────────────────
\c - authenticator
set role service_role;
select al.as_user('service_role', null);
select al.put('r2', al.run('completed', al.chicago_today() + 29));
do $$ begin
  perform al.ok('N1 a run the day before the 30-day date keeps it dismissed',
    (al.row('data_fix:d30')).status = 'dismissed' and (al.row('data_fix:d30')).dismissed_until = al.chicago_today() + 30);
end $$;
select al.put('r3', al.run('degraded', al.chicago_today() + 400));
do $$ begin
  perform al.ok('N2 a degraded run changes no dismissal, even long after its date',
    (al.row('data_fix:d30')).status = 'dismissed' and (al.row('data_fix:d90')).status = 'dismissed');
end $$;
select al.put('r4', al.run('completed', al.chicago_today() + 30));
do $$ begin
  perform al.ok('N3 on the 30-day date a completed run reopens it, recorded as the engine',
    (al.row('data_fix:d30')).status = 'open' and (al.row('data_fix:d30')).dismissed_until is null
    and (al.last_event('data_fix:d30')).kind = 'reopened' and (al.last_event('data_fix:d30')).actor_kind = 'engine'
    and (al.last_event('data_fix:d30')).run_id = al.id('r4'));
  perform al.ok('N4 ...while the 60 and 90-day dismissals hold', (al.row('data_fix:d60')).status = 'dismissed' and (al.row('data_fix:d90')).status = 'dismissed');
end $$;
select al.put('r5', al.run('completed', al.chicago_today() + 400));
do $$ begin
  perform al.ok('N5 more than a year later, never-recommend still holds',
    (al.row('data_fix:never')).suppressed and al.state('data_fix:never') = 'dismissed' and al.events('data_fix:never', 'reopened') = 0);
  perform al.ok('N6 ...and the 60 / 90-day ones have returned', (al.row('data_fix:d60')).status = 'open' and (al.row('data_fix:d90')).status = 'open');
end $$;
reset role;

-- ── O. Only a person lifts a suppression ────────────────────────────────────
set role authenticated;
select al.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := al.decide('data_fix:never', 'reopen');
  perform al.ok('O1 reopen lifts never-recommend', e is null and (al.row('data_fix:never')).status = 'open'
    and not (al.row('data_fix:never')).suppressed and (al.row('data_fix:never')).status_reason is null
    and (al.last_event('data_fix:never')).kind = 'reopened' and (al.last_event('data_fix:never')).actor_kind = 'team', e);
  e := al.decide('data_fix:never', 'reopen');
  perform al.ok('O2 a duplicate reopen is refused', e like '22023%' and al.events('data_fix:never', 'reopened') = 1, e);
end $$;
reset role;

\c - postgres
\o
\pset footer off
select status, count(*) from al.results group by status order by status;
select n, status, name, detail from al.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from al.results where status = 'fail';
  if f > 0 then raise exception '% authority lifecycle check(s) failed', f; end if;
end $$;
