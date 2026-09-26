-- Tests for migration 0049 (authority_apply: Authority decisions with their
-- canonical change in one transaction), run by scripts/test-portal-sandbox.sh
-- after the lifecycle tests, on clients of their own. Own harness (ap).
-- Fictional data only.
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
\set cd     '00000000-0000-4000-b000-0000000000d1'
\set ce     '00000000-0000-4000-b000-0000000000e1'
\set kwnav  '00000000-0000-4000-d000-0000000000d1'
\set kwbuy  '00000000-0000-4000-d000-0000000000d2'
\set kwe    '00000000-0000-4000-d000-0000000000e1'

\c - postgres
\o /dev/null
create schema ap;
create table ap.results (n serial, status text, name text, detail text);
create table ap.ids (k text primary key, id uuid);
create table ap.v (k text primary key, v jsonb);
grant usage on schema ap to anon, authenticated, service_role;
grant insert, select on ap.results to anon, authenticated, service_role;
grant select, insert, update on ap.ids, ap.v to anon, authenticated, service_role;
grant usage on sequence ap.results_n_seq to anon, authenticated, service_role;

create function ap.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into ap.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function ap.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ap.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function ap.id(p_k text) returns uuid language sql stable as $$ select id from ap.ids where k = p_k $$;
create function ap.put(p_k text, p_id uuid) returns void language sql as $$
  insert into ap.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id $$;

-- Report entries shaped like D1.1's decisions.
create function ap.intent_opp(p_kw uuid, p_keyword text, p_stored text, p_assessed text, p_topic_suffix text default '') returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', 'confirm_intent:' || p_kw, 'key', 'confirm_intent:' || p_kw, 'section', 'needs_decision',
    'action', 'requires_confirmation', 'tier', 'none', 'content_type', 'data_fix', 'topic', format('Intent: "%s"%s', p_keyword, p_topic_suffix),
    'service_id', null, 'objective', null, 'order', jsonb_build_array(0), 'eligible_from', null,
    'gap', format('Stored as %s; the query reads as %s.', p_stored, p_assessed),
    'target', jsonb_build_object('keyword_id', p_kw, 'keyword', p_keyword, 'intent', p_stored, 'location', null, 'owner_path', null, 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'Stored intent: ' || p_stored)))
$$;
create function ap.opp(p_key text, p_section text, p_location text default null, p_path text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', p_section, 'action', case when p_section = 'needs_decision' then 'requires_confirmation' else 'improve' end,
    'tier', 'none', 'content_type', 'data_fix', 'topic', p_key, 'service_id', null, 'objective', null, 'order', jsonb_build_array(0),
    'eligible_from', null, 'gap', 'fixture',
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', p_location, 'owner_path', p_path, 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
-- The standard report for client D; p_nav overrides the brand keyword's entry.
create function ap.opps(p_nav jsonb default null) returns jsonb language sql immutable as $$
  select jsonb_build_array(
    coalesce(p_nav, ap.intent_opp('00000000-0000-4000-d000-0000000000d1', 'apply roofing', 'commercial', 'navigational')),
    ap.intent_opp('00000000-0000-4000-d000-0000000000d2', 'roof repair near me', 'informational', 'commercial or transactional'),
    ap.intent_opp('00000000-0000-4000-d000-0000000000e1', 'other client keyword', 'commercial', 'navigational'),
    ap.opp('confirm_market:ofallon', 'needs_decision', 'O''Fallon', '/service-areas/ofallon'),
    ap.opp('confirm_market:lake-saint-louis', 'needs_decision', 'Lake Saint Louis', '/service-areas/lake-saint-louis'),
    ap.opp('confirm_market:chesterfield', 'needs_decision', 'Chesterfield', '/service-areas/chesterfield'),
    ap.opp('confirm_service:/services/commercial-roofing', 'needs_decision', null, '/services/commercial-roofing'),
    ap.opp('confirm_service:/services/solar', 'needs_decision', null, '/services/solar'),
    ap.opp('data_fix:work', 'fix_now'),
    ap.opp('data_fix:atomic', 'fix_now'),
    ap.opp('data_fix:dismissed', 'fix_now'))
$$;
create function ap.run(p_opps jsonb) returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run('00000000-0000-4000-b000-0000000000d1', 'refresh', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.1', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('ef', 32), 'section_hashes', authority_fingerprint('00000000-0000-4000-b000-0000000000d1'),
    'inventory', jsonb_build_object('fetched_at', now(), 'pages', '[]'::jsonb), 'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', '00000000-0000-4000-b000-0000000000d1'), 'as_of', current_date,
      'sources', '{}'::jsonb, 'opportunities', p_opps)));
  return r;
end $$;
create function ap.o(p_key text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000d1' and key = p_key $$;
create function ap.oid(p_key text) returns uuid language sql stable as $$ select (ap.o(p_key)).id $$;
create function ap.events(p_key text, p_kind text default null) returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_events where opportunity_id = ap.oid(p_key) and (p_kind is null or kind = p_kind) $$;
create function ap.last(p_key text, p_kind text) returns jsonb language sql stable security definer as $$
  select detail from public.authority_opportunity_events where opportunity_id = ap.oid(p_key) and kind = p_kind order by created_at desc, id desc limit 1 $$;
create function ap.state(p_key text) returns text language sql stable security definer as $$
  select effective_status from public.authority_opportunity_state where client_id = '00000000-0000-4000-b000-0000000000d1' and key = p_key $$;
-- What the preview showed: the opportunity's run and workflow, plus extras.
create function ap.exp(p_key text, p_extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('run_id', (ap.o(p_key)).last_seen_run_id, 'status', (ap.o(p_key)).status,
    'suppressed', (ap.o(p_key)).suppressed, 'dismissed_until', (ap.o(p_key)).dismissed_until) || p_extra $$;
create function ap.apply(p_key text, p_action text, p_payload jsonb, p_expected jsonb) returns text language sql as $$
  select ap.try(format('select authority_apply(%L, %L, %L::jsonb, %L::jsonb)', ap.oid(p_key), p_action, p_payload, p_expected)) $$;
create function ap.kw_intent(p_id uuid) returns text language sql stable security definer as $$ select intent from public.keywords where id = p_id $$;
create function ap.count(p_sql text) returns bigint language plpgsql security definer as $$
declare n bigint; begin execute p_sql into n; return n; end $$;
grant execute on all functions in schema ap to anon, authenticated, service_role;

insert into clients (id, name, city, state, website_url, status) values
  (:'cd', 'Apply Roofing', 'Wentzville', 'MO', 'https://www.apply.example.test', 'active'),
  (:'ce', 'Other Roofing', 'Columbia', 'MO', 'https://other.example.test', 'active');
insert into keywords (id, client_id, keyword, intent) values
  (:'kwnav', :'cd', 'apply roofing', 'commercial'),
  (:'kwbuy', :'cd', 'roof repair near me', 'informational'),
  (:'kwe', :'ce', 'other client keyword', 'commercial');
insert into locations (client_id, name, city, state, is_active) values (:'cd', 'Lake Saint Louis, MO', 'Lake Saint Louis', 'MO', false);
-- A switch the atomicity test uses to make the link insert fail AFTER the task insert.
create function ap.fail_link() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('ap.fail_link', true), '') = 'on' then raise exception 'forced link failure' using errcode = 'XX001'; end if;
  return new;
end $$;
create trigger ap_fail_link before insert on authority_opportunity_links for each row execute function ap.fail_link();

-- ── R. The report (the authority-run function) ──────────────────────────────
\c - authenticator
set role service_role;
select ap.as_user('service_role', null);
select ap.put('r1', ap.run(ap.opps()));
do $$ begin
  perform ap.ok('R1 eleven opportunities for client D', (select count(*) from authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000d1') = 11);
  perform ap.ok('R2 the basis of an intent conflict is its keyword, stored and assessed intent',
    authority_recommendation_basis('confirm_intent:x', ap.intent_opp('00000000-0000-4000-d000-0000000000d2', 'k', 'informational', 'commercial or transactional'))
    = jsonb_build_object('keyword_id', '00000000-0000-4000-d000-0000000000d2', 'stored', 'informational', 'assessed', 'commercial or transactional'));
  perform ap.ok('R3 other kinds carry no basis', authority_recommendation_basis('confirm_market:x', ap.opp('confirm_market:x', 'needs_decision')) is null);
end $$;
do $$ declare e text := ap.apply('data_fix:work', 'create_task', '{"title": "x"}', ap.exp('data_fix:work'));
begin perform ap.ok('C1 the service caller cannot apply', e like '42501%', e); end $$;
reset role;

-- ── C. Nobody but a teammate ────────────────────────────────────────────────
set role authenticated;
select ap.as_user('authenticated', :'pa');
do $$ declare e text := ap.apply('data_fix:work', 'create_task', '{"title": "x"}', '{}');
begin perform ap.ok('C2 a portal contact cannot apply', e like '42501%', e); end $$;
select ap.as_user('authenticated', :'strngr');
do $$ declare e text := ap.apply('data_fix:work', 'create_task', '{"title": "x"}', '{}');
begin perform ap.ok('C3 a signed-in stranger cannot apply', e like '42501%', e); end $$;
reset role;
set role anon;
select ap.as_user('anon', null);
do $$ declare e text := ap.apply('data_fix:work', 'create_task', '{"title": "x"}', '{}');
begin perform ap.ok('C4 anon cannot apply', e like '42501%', e); end $$;
reset role;
\c - postgres
do $$ declare e text := ap.apply('confirm_intent:00000000-0000-4000-d000-0000000000d2', 'set_intent', '{"intent": "transactional"}',
  ap.exp('confirm_intent:00000000-0000-4000-d000-0000000000d2', '{"intent": "informational"}'));
begin perform ap.ok('C5 the worker''s SQL cannot apply', e like '42501%', e); end $$;
set role authenticated;
select ap.as_user('authenticated', :'team');
do $$ declare e text := ap.apply('confirm_intent:00000000-0000-4000-d000-0000000000d2', 'set_intent', '{"intent": "transactional"}',
  ap.exp('confirm_intent:00000000-0000-4000-d000-0000000000d2', '{"intent": "informational"}'));
begin perform ap.ok('C6 ...nor after SET ROLE authenticated with a team JWT (session_user is still postgres)', e like '42501%', e); end $$;
reset role;
do $$ begin
  perform ap.ok('C7 none of the refused calls wrote anything',
    ap.kw_intent('00000000-0000-4000-d000-0000000000d2') = 'informational'
    and ap.count($q$select count(*) from tasks where client_id = '00000000-0000-4000-b000-0000000000d1' and key like 'authority:%'$q$) = 0
    and ap.count($q$select count(*) from authority_opportunity_events e join authority_opportunities o on o.id = e.opportunity_id
                   where o.client_id = '00000000-0000-4000-b000-0000000000d1' and e.kind <> 'created'$q$) = 0);
end $$;

-- ── T. A teammate ───────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select ap.as_user('authenticated', :'team');
do $$
declare
  e text;
  nav text := 'confirm_intent:00000000-0000-4000-d000-0000000000d1';
  buy text := 'confirm_intent:00000000-0000-4000-d000-0000000000d2';
  other text := 'confirm_intent:00000000-0000-4000-d000-0000000000e1';
begin
  -- Changed since the preview
  e := ap.apply(buy, 'set_intent', '{"intent": "transactional"}', ap.exp(buy, '{"intent": "informational"}') || '{"run_id": "00000000-0000-4000-0000-000000000000"}');
  perform ap.ok('V1 another run than the preview''s is refused (AU409)', e like 'AU409%', e);
  e := ap.apply(buy, 'set_intent', '{"intent": "transactional"}', ap.exp(buy, '{"intent": "commercial"}'));
  perform ap.ok('V2 a before-value that no longer matches is refused (AU409)', e like 'AU409%', e);
  e := ap.apply(buy, 'set_intent', '{"intent": "transactional"}', ap.exp(buy, '{"intent": "informational"}') || '{"status": "accepted"}');
  perform ap.ok('V3 a workflow that changed is refused (AU409)', e like 'AU409%', e);
  perform ap.ok('V4 ...and nothing was written', ap.kw_intent('00000000-0000-4000-d000-0000000000d2') = 'informational' and ap.events(buy) = 1);
  -- Cross-client: an opportunity of client D naming client E's keyword
  e := ap.apply(other, 'keep_intent', '{}', ap.exp(other, '{"intent": "commercial"}'));
  perform ap.ok('X1 another client''s keyword is out of reach (AU409, keyword gone)', e like 'AU409%', e);
  e := ap.apply(other, 'set_intent', '{"intent": "navigational"}', ap.exp(other, '{"intent": "commercial"}'));
  perform ap.ok('X2 ...and cannot be changed', e like 'AU409%' and ap.kw_intent('00000000-0000-4000-d000-0000000000e1') = 'commercial', e);
  -- Wrong action for the opportunity
  e := ap.apply(buy, 'approve_market', '{"city": "O''Fallon", "state": "MO", "lat": 38.8, "lng": -90.7}', ap.exp(buy, '{"location_id": null}'));
  perform ap.ok('X3 a market action on an intent decision is refused', e like '22023%', e);

  -- Intent: change to the recommended intent
  e := ap.apply(buy, 'set_intent', '{"intent": "navigational"}', ap.exp(buy, '{"intent": "informational"}'));
  perform ap.ok('I1 only the recommended intent (commercial or transactional) may be set', e like '22023%' and ap.kw_intent('00000000-0000-4000-d000-0000000000d2') = 'informational', e);
  e := ap.apply(buy, 'set_intent', '{"intent": "transactional"}', ap.exp(buy, '{"intent": "informational"}'));
  perform ap.ok('I2 set_intent writes keywords.intent', e is null and ap.kw_intent('00000000-0000-4000-d000-0000000000d2') = 'transactional', e);
  perform ap.ok('I3 ...with one decision event carrying before / after and the recommendation',
    ap.events(buy, 'decision') = 1 and ap.last(buy, 'decision')->'before'->>'keywords.intent' = 'informational'
    and ap.last(buy, 'decision')->'after'->>'keywords.intent' = 'transactional'
    and ap.last(buy, 'decision')->'recommendation'->>'assessed' = 'commercial or transactional');
  perform ap.ok('I4 ...and no suppression (the next refresh resolves it)', not (ap.o(buy)).suppressed and (ap.o(buy)).status = 'open');

  -- Intent: keep the current one (bound to the reviewed recommendation)
  e := ap.apply(nav, 'keep_intent', '{}', ap.exp(nav, '{"intent": "commercial"}'));
  perform ap.ok('K1 keep_intent: suppressed with the reviewed recommendation as its basis',
    e is null and (ap.o(nav)).suppressed and (ap.o(nav)).suppression_basis
      = jsonb_build_object('keyword_id', '00000000-0000-4000-d000-0000000000d1', 'stored', 'commercial', 'assessed', 'navigational'), e);
  perform ap.ok('K2 ...the keyword is untouched', ap.kw_intent('00000000-0000-4000-d000-0000000000d1') = 'commercial');
  perform ap.ok('K3 ...a decision event and a suppression event with the basis',
    ap.last(nav, 'decision')->>'action' = 'keep_intent' and ap.last(nav, 'suppressed')->'basis'->>'assessed' = 'navigational');
  -- authority_decide takes a basis only as the recommendation currently reported
  e := ap.try(format($q$select authority_decide(%L, 'suppress', '{"reason": "x", "basis": {"keyword_id": "x", "stored": "a", "assessed": "b"}}')$q$, ap.oid(buy)));
  perform ap.ok('K4 a forged basis is refused', e like '22023%', e);
  e := ap.try(format($q$select authority_decide(%L, 'dismiss', jsonb_build_object('reason', 'x', 'until', current_date + 30, 'basis', authority_recommendation_basis(%L, (select opportunity from authority_opportunities where id = %L))))$q$, ap.oid(buy), buy, ap.oid(buy)));
  perform ap.ok('K5 a basis on a dated dismissal is refused', e like '22023%', e);
end $$;
reset role;

-- Later runs: the same recommendation, an unrelated change, a different one.
set role service_role;
select ap.as_user('service_role', null);
select ap.put('r2', ap.run(ap.opps()));
do $$ begin
  perform ap.ok('K6 the same recommendation stays suppressed',
    (ap.o('confirm_intent:00000000-0000-4000-d000-0000000000d1')).suppressed and ap.state('confirm_intent:00000000-0000-4000-d000-0000000000d1') = 'dismissed');
end $$;
select ap.put('r3', ap.run(ap.opps(
  ap.intent_opp('00000000-0000-4000-d000-0000000000d1', 'apply roofing', 'commercial', 'navigational', ' (reworded)')
  || jsonb_build_object('tier', 'C', 'order', jsonb_build_array(9, 9), 'reasons', jsonb_build_array(jsonb_build_object('tag', 'HEURISTIC', 'text', 'new wording'))))));
do $$ begin
  perform ap.ok('K7 unrelated changes (topic, tier, order, reasons) do not reopen it',
    (ap.o('confirm_intent:00000000-0000-4000-d000-0000000000d1')).suppressed
    and ap.events('confirm_intent:00000000-0000-4000-d000-0000000000d1', 'reopened') = 0);
end $$;
select ap.put('r4', ap.run(ap.opps(ap.intent_opp('00000000-0000-4000-d000-0000000000d1', 'apply roofing', 'commercial', 'informational'))));
do $$
declare k text := 'confirm_intent:00000000-0000-4000-d000-0000000000d1';
begin
  perform ap.ok('K8 a materially different recommendation reopens the decision, same opportunity',
    not (ap.o(k)).suppressed and (ap.o(k)).status = 'open' and (ap.o(k)).suppression_basis is null and ap.oid(k) is not null
    and ap.last(k, 'reopened')->>'reason' = 'recommendation changed' and ap.last(k, 'reopened')->'reviewed'->>'assessed' = 'navigational'
    and ap.last(k, 'reopened')->'now'->>'assessed' = 'informational');
  perform ap.ok('K9 ...listed in the run''s diff as reopened',
    (select diff->'reopened' ? k from authority_runs where id = ap.id('r4')));
  perform ap.ok('K10 a never-recommend without a basis is untouched by the same change',
    (select count(*) from authority_opportunities where client_id = '00000000-0000-4000-b000-0000000000d1' and suppressed and suppression_basis is not null) = 0);
end $$;
reset role;

set role authenticated;
select ap.as_user('authenticated', :'team');
do $$
declare
  e text;
  nav text := 'confirm_intent:00000000-0000-4000-d000-0000000000d1';
  mkt text := 'confirm_market:ofallon';
  lsl text := 'confirm_market:lake-saint-louis';
  chf text := 'confirm_market:chesterfield';
  svc text := 'confirm_service:/services/commercial-roofing';
  sol text := 'confirm_service:/services/solar';
  AUTH_ONLY text := 'Authority decision only; no Client Intelligence record created.';
begin
  -- The stored intent changed after the analysis: keep refuses until a refresh.
  e := ap.apply(nav, 'keep_intent', '{}', ap.exp(nav, '{"intent": "commercial"}'));
  perform ap.ok('K11 keep again against the new recommendation: allowed, bound to it', e is null
    and (ap.o(nav)).suppression_basis->>'assessed' = 'informational', e);
  e := ap.try(format($q$select authority_decide(%L, 'reopen')$q$, ap.oid(nav)));
  perform ap.ok('K12 reopen clears the basis', e is null and (ap.o(nav)).suppression_basis is null and not (ap.o(nav)).suppressed, e);

  -- Markets
  e := ap.apply(mkt, 'approve_market', '{"city": "O''Fallon", "state": "MO"}', ap.exp(mkt, '{"location_id": null}'));
  perform ap.ok('M1 a market without coordinates is refused', e like '22023%', e);
  e := ap.apply(mkt, 'approve_market', '{"city": "Chesterfield", "state": "MO", "lat": 38.66, "lng": -90.58}', ap.exp(mkt, '{"location_id": null}'));
  perform ap.ok('M2 a different city than the decision''s is refused', e like '22023%', e);
  e := ap.apply(mkt, 'approve_market', '{"city": "O''Fallon", "state": "MO", "lat": 38.8106, "lng": -90.6998}', ap.exp(mkt, '{"location_id": null}'));
  perform ap.ok('M3 approve_market inserts an active location with coordinates', e is null
    and ap.count($q$select count(*) from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and city = 'O''Fallon' and state = 'MO' and is_active and lat = 38.8106 and lng = -90.6998$q$) = 1, e);
  perform ap.ok('M4 ...with a decision event (before: none, after: the row)',
    ap.last(mkt, 'decision')->>'action' = 'approve_market' and ap.last(mkt, 'decision')->'before'->'locations' = 'null'::jsonb
    and ap.last(mkt, 'decision')->'after'->'locations'->>'is_active' = 'true');
  e := ap.apply(mkt, 'approve_market', '{"city": "O''Fallon", "state": "MO", "lat": 38.8106, "lng": -90.6998}', ap.exp(mkt, '{"location_id": null}'));
  perform ap.ok('M5 approving it again is refused as changed since the preview', e like 'AU409%'
    and ap.count($q$select count(*) from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and city = 'O''Fallon'$q$) = 1, e);
  e := ap.apply(lsl, 'approve_market', '{"city": "Lake Saint Louis", "state": "MO", "lat": 38.79, "lng": -90.78}', ap.exp(lsl, '{"location_id": null}'));
  perform ap.ok('M6 an inactive row the preview did not show is refused (AU409)', e like 'AU409%', e);
  e := ap.apply(lsl, 'approve_market', '{"city": "Lake St. Louis", "state": "mo", "lat": 38.79, "lng": -90.78}',
    ap.exp(lsl, jsonb_build_object('location_id', (select id from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and city = 'Lake Saint Louis'))));
  perform ap.ok('M7 the existing inactive row is turned on (no duplicate; "St." matches Saint)', e is null
    and ap.count($q$select count(*) from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and city = 'Lake Saint Louis' and is_active and lat = 38.79$q$) = 1
    and ap.count($q$select count(*) from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and authority_norm_place(city) = 'lake saint louis'$q$) = 1, e);
  e := ap.apply(chf, 'decline_market', '{}', ap.exp(chf));
  perform ap.ok('M8 declining needs a reason', e like '22023%', e);
  e := ap.apply(chf, 'decline_market', '{"reason": "Too far east"}', ap.exp(chf));
  perform ap.ok('M9 decline: suppressed, no location written', e is null and (ap.o(chf)).suppressed
    and ap.count($q$select count(*) from locations where client_id = '00000000-0000-4000-b000-0000000000d1' and city = 'Chesterfield'$q$) = 0, e);
  perform ap.ok('M10 ...recorded as an Authority decision only',
    ap.last(chf, 'decision')->>'note' = AUTH_ONLY and ap.last(chf, 'decision')->>'client_intelligence_record' = 'false'
    and (ap.o(chf)).status_reason like '%' || AUTH_ONLY);

  -- Services
  e := ap.apply(svc, 'confirm_service', '{"name": "Commercial Roofing", "page_url": "https://elsewhere.example.test/services/commercial-roofing"}', ap.exp(svc));
  perform ap.ok('S1 a page on another site is refused', e like '22023%', e);
  e := ap.apply(svc, 'confirm_service', '{"name": "Commercial Roofing", "page_url": "https://apply.example.test/services/other"}', ap.exp(svc));
  perform ap.ok('S2 another page than the decision''s is refused', e like '22023%', e);
  e := ap.apply(svc, 'confirm_service', '{"name": "Commercial Roofing", "segment": "Roofing", "page_url": "https://apply.example.test/services/commercial-roofing/"}', ap.exp(svc, '{"service_id": null}'));
  perform ap.ok('S3 confirm_service inserts an approved service owning the page', e is null
    and ap.count($q$select count(*) from services where client_id = '00000000-0000-4000-b000-0000000000d1' and name = 'Commercial Roofing' and status = 'approved' and segment = 'Roofing'$q$) = 1, e);
  perform ap.ok('S4 ...with its decision event', ap.last(svc, 'decision')->>'action' = 'confirm_service' and ap.last(svc, 'decision')->'after'->'services'->>'status' = 'approved');
  e := ap.apply(sol, 'confirm_service', '{"name": "commercial roofing", "page_url": "https://apply.example.test/services/solar"}', ap.exp(sol, '{"service_id": null}'));
  perform ap.ok('S5 a duplicate service name is refused (AU409)', e like 'AU409%', e);
  e := ap.apply(sol, 'not_offered', '{"reason": "They stopped installing solar"}', ap.exp(sol));
  perform ap.ok('S6 not offered: suppressed, no service written, Authority decision only', e is null and (ap.o(sol)).suppressed
    and ap.count($q$select count(*) from services where client_id = '00000000-0000-4000-b000-0000000000d1' and page_url like '%/solar'$q$) = 0
    and ap.last(sol, 'decision')->>'note' = AUTH_ONLY, e);
end $$;

-- Work: task + link + events, atomically
do $$
declare e text;
begin
  e := ap.apply('data_fix:work', 'create_task', '{"title": "Fix it", "assignee_id": "00000000-0000-4000-a000-00000000ffff"}', ap.exp('data_fix:work'));
  perform ap.ok('W1 an assignee who is not on the team is refused, no task', e like '22023%'
    and ap.count($q$select count(*) from tasks where client_id = '00000000-0000-4000-b000-0000000000d1' and key like 'authority:%'$q$) = 0, e);
  e := ap.apply('data_fix:work', 'create_task', format('{"title": "Rewrite the page", "notes": "From Authority", "assignee_id": "%s"}',
    (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001'))::jsonb, ap.exp('data_fix:work'));
  perform ap.ok('W2 create_task: one TOM task keyed to the opportunity', e is null
    and ap.count($q$select count(*) from tasks where client_id = '00000000-0000-4000-b000-0000000000d1' and owner = 'TOM' and key = 'authority:data_fix:work' and title = 'Rewrite the page'$q$) = 1, e);
  perform ap.ok('W3 ...linked, accepted and in progress, with accepted + linked events',
    ap.state('data_fix:work') = 'in_progress' and ap.events('data_fix:work', 'accepted') = 1 and ap.events('data_fix:work', 'linked') = 1
    and ap.count(format($q$select count(*) from authority_opportunity_links where opportunity_id = %L and kind = 'task'$q$, ap.oid('data_fix:work'))) = 1);
  e := ap.apply('data_fix:work', 'create_task', '{"title": "Again"}', ap.exp('data_fix:work'));
  perform ap.ok('W4 a second task while one is open is refused (AU409)', e like 'AU409%'
    and ap.count($q$select count(*) from tasks where key = 'authority:data_fix:work'$q$) = 1, e);
  perform set_config('ap.fail_link', 'on', false);
  e := ap.apply('data_fix:atomic', 'create_task', '{"title": "Never saved"}', ap.exp('data_fix:atomic'));
  perform set_config('ap.fail_link', '', false);
  perform ap.ok('W5 a link that fails after the task insert rolls the task back (no orphan task, link or event)', e like 'XX001%'
    and ap.count($q$select count(*) from tasks where key = 'authority:data_fix:atomic'$q$) = 0
    and ap.events('data_fix:atomic') = 1 and (ap.o('data_fix:atomic')).status = 'open', e);
  perform authority_decide(ap.oid('data_fix:dismissed'), 'dismiss', jsonb_build_object('reason', 'later', 'until', current_date + 30));
  e := ap.apply('data_fix:dismissed', 'create_task', '{"title": "x"}', ap.exp('data_fix:dismissed'));
  perform ap.ok('W6 a dismissed opportunity takes no task', e like '22023%' and ap.count($q$select count(*) from tasks where key = 'authority:data_fix:dismissed'$q$) = 0, e);
end $$;
reset role;

-- Offboarded
\c - postgres
update clients set status = 'offboarded' where id = :'cd';
\c - authenticator
set role authenticated;
select ap.as_user('authenticated', :'team');
do $$ declare e text := ap.apply('data_fix:atomic', 'create_task', '{"title": "x"}', ap.exp('data_fix:atomic'));
begin perform ap.ok('O1 an offboarded client takes no decision', e like '22023%', e); end $$;
reset role;

\c - postgres
drop trigger ap_fail_link on authority_opportunity_links;
\o
\pset footer off
select status, count(*) from ap.results group by status order by status;
select n, status, name, detail from ap.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from ap.results where status = 'fail';
  if f > 0 then raise exception '% authority_apply check(s) failed', f; end if;
end $$;
