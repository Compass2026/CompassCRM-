-- Tests for migration 0051 (atomic Home re-home: the keyword leaves every
-- service / hub page group's supporting list in the same transaction that
-- gives it to Home), run by scripts/test-portal-sandbox.sh after the 0050
-- suite, on a client of its own. Own harness (hc). Fictional data only.
--
-- Callers as in authority_reconcile.test.sql: person = authenticator +
-- authenticated + team JWT; worker = postgres.

\set team '00000000-0000-4000-a000-000000000001'

\c - postgres
\o /dev/null
create schema hc;
create table hc.results (n serial, status text, name text, detail text);
create table hc.ids (k text primary key, id uuid);
grant usage on schema hc to anon, authenticated, service_role;
grant insert, select on hc.results to anon, authenticated, service_role;
grant select on hc.ids to anon, authenticated, service_role;
grant usage on sequence hc.results_n_seq to anon, authenticated, service_role;

create function hc.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into hc.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function hc.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function hc.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function hc.id(p_k text) returns uuid language sql stable as $$ select id from hc.ids where k = p_k $$;

insert into hc.ids values
  ('c', '00000000-0000-4000-b000-0000000000c5'),
  ('rr', '00000000-0000-4000-e000-0000000000c1'), ('gu', '00000000-0000-4000-e000-0000000000c2'),
  ('kh1', '00000000-0000-4000-d000-0000000000c1'), ('kh2', '00000000-0000-4000-d000-0000000000c2'),
  ('kh3', '00000000-0000-4000-d000-0000000000c3'), ('kp', '00000000-0000-4000-d000-0000000000c4'),
  ('kg', '00000000-0000-4000-d000-0000000000c5'), ('ks', '00000000-0000-4000-d000-0000000000c6'),
  ('kh0', '00000000-0000-4000-d000-0000000000c7'),
  ('home', '00000000-0000-4000-f000-0000000000c0'), ('g_rr', '00000000-0000-4000-f000-0000000000c1'),
  ('g_rr_old', '00000000-0000-4000-f000-0000000000c2'), ('g_gu', '00000000-0000-4000-f000-0000000000c3'),
  ('g_city', '00000000-0000-4000-f000-0000000000c4');

create function hc.page(p_path text) returns jsonb language sql immutable as $$
  select jsonb_build_object('url', 'https://cleanup.example.test' || p_path, 'status', 200, 'final_url', 'https://cleanup.example.test' || p_path,
    'final_status', 200, 'redirect_loop', false, 'in_sitemap', true, 'title', null, 'h1', null, 'h2', '[]'::jsonb, 'canonical', null, 'words', 300, 'text', 'x')
$$;
create function hc.kw(p_k text, p_flags text[]) returns jsonb language sql stable as $$
  select jsonb_build_object('keyword_id', hc.id(p_k), 'role', 'homepage_pollution', 'flags', to_jsonb(p_flags), 'service_id', hc.id('rr'))
$$;
create function hc.opp(p_key text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', 'fix_now', 'action', 'improve', 'tier', 'A', 'content_type', 'data_fix',
    'topic', p_key, 'service_id', null, 'objective', null, 'order', jsonb_build_array(0), 'eligible_from', null, 'gap', 'fixture',
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', null, 'owner_path', '/', 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
create function hc.run() returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run(hc.id('c'), 'full', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.2', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('cd', 32), 'section_hashes', authority_fingerprint(hc.id('c')),
    'inventory', jsonb_build_object('fetched_at', now(), 'site', 'https://cleanup.example.test', 'pages', jsonb_build_array(hc.page('/'), hc.page('/roof-replacement'))),
    'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', hc.id('c')), 'as_of', current_date, 'sources', '{}'::jsonb,
      'keywords', jsonb_build_array(
        hc.kw('kh1', '{homepage_pollution,home_eligible}'), hc.kw('kh2', '{homepage_pollution,home_eligible}'),
        hc.kw('kh3', '{homepage_pollution,home_eligible}'), hc.kw('kp', '{homepage_pollution,home_eligible}'),
        hc.kw('kg', '{homepage_pollution,home_eligible}'), hc.kw('ks', '{homepage_pollution}')),
      'opportunities', jsonb_build_array(hc.opp('data_fix:keyword-ownership:' || hc.id('rr'))))));
  return r;
end $$;
create function hc.key() returns text language sql stable as $$ select 'data_fix:keyword-ownership:' || hc.id('rr') $$;
create function hc.o() returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = hc.id('c') and key = hc.key() $$;
-- The preview: each row as it stands, the destination written (0052) and,
-- for Home, the service / hub page groups the keyword leaves (0052).
create function hc.exp(p_rows jsonb) returns jsonb language sql stable security definer as $$
  select jsonb_build_object('run_id', (hc.o()).last_seen_run_id, 'status', (hc.o()).status, 'suppressed', (hc.o()).suppressed,
    'dismissed_until', (hc.o()).dismissed_until,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('keyword_id', k.id, 'service_id', k.service_id, 'target_url', k.target_url,
               'destination_url', (select target_url from public.page_groups where id = hc.id(case when r->>'destination' = 'home' then 'home' else 'g_rr' end)),
               'removed_from', (select coalesce(jsonb_agg(g.id order by g.id), '[]') from public.page_groups g
                                 where g.client_id = k.client_id and g.page_type in ('service', 'hub') and k.id = any (g.supporting_keyword_ids)))), '[]')
             from jsonb_array_elements(p_rows) r join public.keywords k on k.id = (r->>'keyword_id')::uuid))
$$;
create function hc.rehome(p_rows jsonb, p_keys text[]) returns text language sql as $$
  select hc.try(format('select authority_apply(%L, %L, %L::jsonb, %L::jsonb)', (hc.o()).id, 'rehome_keywords', jsonb_build_object('rows', p_rows), hc.exp(p_rows))) $$;
create function hc.row(p_k text, p_dest text default 'home') returns jsonb language sql stable as $$
  select jsonb_build_object('keyword_id', hc.id(p_k), 'destination', p_dest) $$;
-- Which groups list a keyword as supporting, by fixture name.
create function hc.listed(p_k text) returns text[] language sql stable security definer as $$
  select coalesce(array_agg(i.k order by i.k), '{}') from public.page_groups g join hc.ids i on i.id = g.id
   where hc.id(p_k) = any (g.supporting_keyword_ids) $$;
create function hc.svc(p_k text) returns uuid language sql stable security definer as $$ select service_id from public.keywords where id = hc.id(p_k) $$;
create function hc.home_support() returns uuid[] language sql stable security definer as $$ select supporting_keyword_ids from public.page_groups where id = hc.id('home') $$;
create function hc.decisions() returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_events where opportunity_id = (hc.o()).id and kind = 'decision' $$;
create function hc.last_decision() returns jsonb language sql stable security definer as $$
  select detail from public.authority_opportunity_events where opportunity_id = (hc.o()).id and kind = 'decision' order by created_at desc, id desc limit 1 $$;
grant execute on all functions in schema hc to anon, authenticated, service_role;

insert into clients (id, name, city, state, website_url, status) values (hc.id('c'), 'Cleanup Roofing', 'Wentzville', 'MO', 'https://cleanup.example.test', 'active');
insert into services (id, client_id, name, status) values
  (hc.id('rr'), hc.id('c'), 'Roof Replacement', 'approved'), (hc.id('gu'), hc.id('c'), 'Gutters', 'approved');
insert into keywords (id, client_id, keyword, service_id, target_url) values
  (hc.id('kh0'), hc.id('c'), 'cleanup roofing', null, 'https://cleanup.example.test/'),
  (hc.id('kh1'), hc.id('c'), 'roofer near me', hc.id('rr'), 'https://cleanup.example.test/'),
  (hc.id('kh2'), hc.id('c'), 'roofing company near me', hc.id('rr'), '/'),
  (hc.id('kh3'), hc.id('c'), 'local roofer near me', hc.id('rr'), '/'),
  (hc.id('kp'), hc.id('c'), 'roofer wentzville', hc.id('rr'), '/'),
  (hc.id('kg'), hc.id('c'), 'roofing contractor near me', hc.id('rr'), '/'),
  (hc.id('ks'), hc.id('c'), 'roof replacement near me', hc.id('rr'), '/');
update services set primary_keyword_id = hc.id('kp') where id = hc.id('rr');
insert into page_groups (id, client_id, name, page_type, target_url, primary_keyword_id, supporting_keyword_ids, status) values
  (hc.id('home'), hc.id('c'), 'Home', 'home', 'https://cleanup.example.test/', hc.id('kh0'), array[hc.id('kh3')], 'approved'),
  (hc.id('g_rr'), hc.id('c'), 'Roof Replacement', 'service', 'https://cleanup.example.test/roof-replacement', null,
     array[hc.id('kh1'), hc.id('kh2'), hc.id('kh3'), hc.id('ks')], 'approved'),
  (hc.id('g_rr_old'), hc.id('c'), 'Roof Replacement (old)', 'service', null, null, array[hc.id('kh1')], 'proposed'),
  (hc.id('g_gu'), hc.id('c'), 'Gutters', 'service', null, hc.id('kg'), array[hc.id('kh2')], 'approved'),
  (hc.id('g_city'), hc.id('c'), 'Wentzville', 'city', null, null, array[hc.id('kh1')], 'approved');

-- A switch that makes the decision event (the last write) fail, to prove the whole re-home rolls back.
create function hc.fail_event() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('hc.fail_event', true), '') = 'on' and new.kind = 'decision' then raise exception 'forced event failure' using errcode = 'XX002'; end if;
  return new;
end $$;
create trigger hc_fail_event before insert on authority_opportunity_events for each row execute function hc.fail_event();

\c - authenticator
set role service_role;
select hc.as_user('service_role', null);
select hc.run();
reset role;

-- ── The worker cannot call it (unchanged gate) ──────────────────────────────
\c - postgres
do $$ declare e text := hc.rehome(jsonb_build_array(hc.row('kh1')), array['kh1']);
begin perform hc.ok('W1 the worker''s SQL cannot re-home', e like '42501%', e); end $$;
do $$ begin
  perform hc.ok('D1 authority_apply carries the 0051 cleanup and is not security definer',
    (select prosrc from pg_proc where oid = 'authority_apply(uuid, text, jsonb, jsonb)'::regprocedure) like '%array_remove(supporting_keyword_ids, v_kw.id)%'
    and not (select prosecdef from pg_proc where oid = 'authority_apply(uuid, text, jsonb, jsonb)'::regprocedure));
end $$;

-- ── A teammate ──────────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select hc.as_user('authenticated', :'team');
do $$
declare e text;
begin
  -- A service's primary keyword (services.primary_keyword_id) is refused, nothing written.
  e := hc.rehome(jsonb_build_array(hc.row('kp')), array['kp']);
  perform hc.ok('P1 a service''s primary keyword is refused', e like '22023%' and hc.svc('kp') = hc.id('rr'), e);
  -- A service page group's primary keyword is refused too.
  e := hc.rehome(jsonb_build_array(hc.row('kg')), array['kg']);
  perform hc.ok('P2 a service page group''s primary keyword is refused', e like '22023%' and hc.svc('kg') = hc.id('rr'), e);
  -- One refused row in a batch: nothing is written for any row.
  e := hc.rehome(jsonb_build_array(hc.row('kh2'), hc.row('kp')), array['kh2', 'kp']);
  perform hc.ok('P3 a batch with one refused row writes nothing',
    e like '22023%' and hc.svc('kh2') = hc.id('rr') and hc.listed('kh2') = array['g_gu', 'g_rr'] and not (hc.id('kh2') = any (hc.home_support())), e);

  -- A failure at the very end (the decision event) rolls every write back.
  perform set_config('hc.fail_event', 'on', false);
  e := hc.rehome(jsonb_build_array(hc.row('kh2')), array['kh2']);
  perform set_config('hc.fail_event', '', false);
  perform hc.ok('R1 a failed decision event rolls back the keyword, the removal and the Home add',
    e like 'XX002%' and hc.svc('kh2') = hc.id('rr') and hc.listed('kh2') = array['g_gu', 'g_rr']
    and not (hc.id('kh2') = any (hc.home_support())) and hc.decisions() = 0, e);

  -- The real thing: kh1 (on the service group, an old draft group and a city group) and kh2 (on two service groups).
  e := hc.rehome(jsonb_build_array(hc.row('kh1'), hc.row('kh2')), array['kh1', 'kh2']);
  perform hc.ok('H1 re-home to Home succeeds', e is null, e);
  perform hc.ok('H2 the keywords leave their service', hc.svc('kh1') is null and hc.svc('kh2') is null);
  perform hc.ok('H3 removed from every service page group (approved or not), still listed where a service group is not involved',
    hc.listed('kh1') = array['g_city', 'home'] and hc.listed('kh2') = array['home'], array_to_string(hc.listed('kh1'), ',') || ' / ' || array_to_string(hc.listed('kh2'), ','));
  perform hc.ok('H4 added to Home''s supporting list once each',
    (select count(*) from unnest(hc.home_support()) u where u = hc.id('kh1')) = 1 and (select count(*) from unnest(hc.home_support()) u where u = hc.id('kh2')) = 1);
  perform hc.ok('H5 never on a service page group and Home at once',
    not exists (select 1 from hc.ids i where i.k in ('kh1', 'kh2') and exists (
      select 1 from page_groups g where g.page_type in ('service', 'hub') and i.id = any (g.supporting_keyword_ids))));
  perform hc.ok('H6 one decision event, naming the groups each keyword left',
    hc.decisions() = 1
    and (select jsonb_agg(x->'removed_from_page_groups') from jsonb_array_elements(hc.last_decision()->'rows') x)
      = jsonb_build_array(
          jsonb_build_array(jsonb_build_object('id', hc.id('g_rr'), 'name', 'Roof Replacement'), jsonb_build_object('id', hc.id('g_rr_old'), 'name', 'Roof Replacement (old)')),
          jsonb_build_array(jsonb_build_object('id', hc.id('g_gu'), 'name', 'Gutters'), jsonb_build_object('id', hc.id('g_rr'), 'name', 'Roof Replacement'))),
    hc.last_decision()::text);

  -- Already on Home's supporting list: stays once; still leaves the service group.
  e := hc.rehome(jsonb_build_array(hc.row('kh3')), array['kh3']);
  perform hc.ok('H7 a keyword Home already lists stays listed once and leaves the service group',
    e is null and hc.listed('kh3') = array['home'] and (select count(*) from unnest(hc.home_support()) u where u = hc.id('kh3')) = 1, e);

  -- The service-page destination is untouched by 0051: the keyword stays on its service group.
  e := hc.rehome(jsonb_build_array(hc.row('ks', 'service_page')), array['ks']);
  perform hc.ok('S1 re-homing to the service page keeps the service group listing', e is null and hc.listed('ks') = array['g_rr'] and hc.svc('ks') = hc.id('rr'), e);
end $$;
reset role;

\c - postgres
drop trigger hc_fail_event on authority_opportunity_events;
\o
\pset footer off
select status, count(*) from hc.results group by status order by status;
select n, status, name, detail from hc.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from hc.results where status = 'fail';
  if f > 0 then raise exception '% Home re-home cleanup check(s) failed', f; end if;
end $$;
