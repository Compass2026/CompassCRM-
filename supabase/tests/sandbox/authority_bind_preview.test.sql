-- Tests for migration 0052 (every reconciliation write bound to its preview:
-- set_service_page's target_url, each re-home / map row's destination_url, a
-- Home re-home's removed_from page groups; map_keywords refuses a keyword the
-- analysis flags location_unapproved), run by scripts/test-portal-sandbox.sh
-- after the 0051 suite, on a client of its own. Own harness (bp). Fictional
-- data only.
--
-- A "concurrent edit" is made as postgres between building the preview and
-- applying it, the way a second teammate's edit would land.
-- Callers as in authority_reconcile.test.sql: person = authenticator +
-- authenticated + team JWT; worker = postgres.

\set team '00000000-0000-4000-a000-000000000001'

\c - postgres
\o /dev/null
create schema bp;
create table bp.results (n serial, status text, name text, detail text);
create table bp.ids (k text primary key, id uuid);
create table bp.saved (k text primary key, v jsonb);
grant usage on schema bp to anon, authenticated, service_role;
grant insert, select on bp.results to anon, authenticated, service_role;
grant select on bp.ids to anon, authenticated, service_role;
grant select, insert, update on bp.saved to anon, authenticated, service_role;
grant usage on sequence bp.results_n_seq to anon, authenticated, service_role;

create function bp.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into bp.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function bp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function bp.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function bp.id(p_k text) returns uuid language sql stable as $$ select id from bp.ids where k = p_k $$;

insert into bp.ids values
  ('c', '00000000-0000-4000-b000-000000000091'),
  ('rr', '00000000-0000-4000-e000-000000000091'), ('gu', '00000000-0000-4000-e000-000000000092'),
  ('sd', '00000000-0000-4000-e000-000000000093'),
  ('kh1', '00000000-0000-4000-d000-000000000091'), ('kh2', '00000000-0000-4000-d000-000000000092'),
  ('ks', '00000000-0000-4000-d000-000000000093'), ('ku1', '00000000-0000-4000-d000-000000000094'),
  ('ku2', '00000000-0000-4000-d000-000000000095'), ('kul', '00000000-0000-4000-d000-000000000096'),
  ('kh0', '00000000-0000-4000-d000-000000000097'),
  ('home', '00000000-0000-4000-f000-000000000090'), ('g_rr', '00000000-0000-4000-f000-000000000091'),
  ('g_gu', '00000000-0000-4000-f000-000000000092'), ('g_sd', '00000000-0000-4000-f000-000000000093'),
  ('g_hub', '00000000-0000-4000-f000-000000000094');

create function bp.page(p_path text) returns jsonb language sql immutable as $$
  select jsonb_build_object('url', 'https://bind.example.test' || p_path, 'status', 200, 'final_url', 'https://bind.example.test' || p_path,
    'final_status', 200, 'redirect_loop', false, 'in_sitemap', true, 'title', null, 'h1', null, 'h2', '[]'::jsonb, 'canonical', null, 'words', 300, 'text', 'x')
$$;
create function bp.kw(p_k text, p_role text, p_flags text[], p_service text) returns jsonb language sql stable as $$
  select jsonb_build_object('keyword_id', bp.id(p_k), 'role', p_role, 'flags', to_jsonb(p_flags), 'service_id', bp.id(p_service))
$$;
create function bp.opp(p_key text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', 'fix_now', 'action', 'improve', 'tier', 'A', 'content_type', 'data_fix',
    'topic', p_key, 'service_id', null, 'objective', null, 'order', jsonb_build_array(0), 'eligible_from', null, 'gap', 'fixture',
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', null, 'owner_path', null, 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
create function bp.run() returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run(bp.id('c'), 'full', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.3', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('ef', 32), 'section_hashes', authority_fingerprint(bp.id('c')),
    'inventory', jsonb_build_object('fetched_at', now(), 'site', 'https://bind.example.test', 'pages', jsonb_build_array(
      bp.page('/'), bp.page('/roof-replacement'), bp.page('/roofs'), bp.page('/gutters'), bp.page('/gutter-guards'))),
    'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', bp.id('c')), 'as_of', current_date, 'sources', '{}'::jsonb,
      'keywords', jsonb_build_array(
        bp.kw('kh1', 'homepage_pollution', '{homepage_pollution,home_eligible}', 'rr'),
        bp.kw('kh2', 'homepage_pollution', '{homepage_pollution,home_eligible}', 'rr'),
        bp.kw('ks', 'homepage_pollution', '{homepage_pollution}', 'rr'),
        bp.kw('ku1', 'unmapped', '{}', null), bp.kw('ku2', 'unmapped', '{}', null),
        bp.kw('kul', 'unmapped', '{location_unapproved}', null)),
      'opportunities', jsonb_build_array(
        bp.opp('data_fix:service-page:' || bp.id('rr')), bp.opp('data_fix:service-page:' || bp.id('gu')),
        bp.opp('data_fix:keyword-ownership:' || bp.id('rr')), bp.opp('data_fix:unmapped-keywords')))));
  return r;
end $$;
create function bp.o(p_key text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = bp.id('c') and key = p_key $$;
create function bp.base(p_key text) returns jsonb language sql stable security definer as $$
  select jsonb_build_object('run_id', (bp.o(p_key)).last_seen_run_id, 'status', (bp.o(p_key)).status,
    'suppressed', (bp.o(p_key)).suppressed, 'dismissed_until', (bp.o(p_key)).dismissed_until) $$;
create function bp.sp(p text) returns text language sql stable as $$ select 'data_fix:service-page:' || bp.id(p) $$;
create function bp.own() returns text language sql stable as $$ select 'data_fix:keyword-ownership:' || bp.id('rr') $$;
create function bp.tgt(p_group text) returns text language sql stable security definer as $$ select target_url from public.page_groups where id = bp.id(p_group) $$;
-- A row's preview exactly as the app builds it: the keyword now, the destination, and (Home) the groups it leaves.
create function bp.row_exp(p_k text, p_dest_group text) returns jsonb language sql stable security definer as $$
  select jsonb_build_object('keyword_id', k.id, 'service_id', k.service_id, 'target_url', k.target_url,
    'destination_url', bp.tgt(p_dest_group),
    'removed_from', (select coalesce(jsonb_agg(g.id order by g.id), '[]') from public.page_groups g
                      where g.client_id = k.client_id and g.page_type in ('service', 'hub') and k.id = any (g.supporting_keyword_ids)))
  from public.keywords k where k.id = bp.id(p_k) $$;
create function bp.apply(p_key text, p_action text, p_payload jsonb, p_expected jsonb) returns text language sql as $$
  select bp.try(format('select authority_apply(%L, %L, %L::jsonb, %L::jsonb)', (bp.o(p_key)).id, p_action, p_payload, p_expected)) $$;
create function bp.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into bp.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function bp.saved(p_k text) returns jsonb language sql stable as $$ select v from bp.saved where k = p_k $$;
create function bp.kwrow(p_k text) returns public.keywords language sql stable security definer as $$ select * from public.keywords where id = bp.id(p_k) $$;
create function bp.page_url(p_s text) returns text language sql stable security definer as $$ select page_url from public.services where id = bp.id(p_s) $$;
create function bp.listed(p_k text) returns text[] language sql stable security definer as $$
  select coalesce(array_agg(i.k order by i.k), '{}') from public.page_groups g join bp.ids i on i.id = g.id
   where bp.id(p_k) = any (g.supporting_keyword_ids) $$;
create function bp.decisions(p_key text) returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_events where opportunity_id = (bp.o(p_key)).id and kind = 'decision' $$;
grant execute on all functions in schema bp to anon, authenticated, service_role;

insert into clients (id, name, city, state, website_url, status) values (bp.id('c'), 'Bind Roofing', 'Wentzville', 'MO', 'https://bind.example.test', 'active');
insert into services (id, client_id, name, status) values
  (bp.id('rr'), bp.id('c'), 'Roof Replacement', 'approved'), (bp.id('gu'), bp.id('c'), 'Gutters', 'approved'),
  (bp.id('sd'), bp.id('c'), 'Siding', 'approved');
insert into keywords (id, client_id, keyword, service_id, target_url) values
  (bp.id('kh0'), bp.id('c'), 'bind roofing', null, 'https://bind.example.test/'),
  (bp.id('kh1'), bp.id('c'), 'roofer near me', bp.id('rr'), '/'),
  (bp.id('kh2'), bp.id('c'), 'roofing company', bp.id('rr'), '/'),
  (bp.id('ks'), bp.id('c'), 'roof replacement near me', bp.id('rr'), '/'),
  (bp.id('ku1'), bp.id('c'), 'gutter guards', null, null),
  (bp.id('ku2'), bp.id('c'), 'seamless gutters', null, null),
  (bp.id('kul'), bp.id('c'), 'gutters farawayville', null, null);
insert into page_groups (id, client_id, name, page_type, target_url, primary_keyword_id, supporting_keyword_ids, status) values
  (bp.id('home'), bp.id('c'), 'Home', 'home', 'https://bind.example.test/', bp.id('kh0'), '{}', 'approved'),
  (bp.id('g_rr'), bp.id('c'), 'Roof Replacement', 'service', 'https://bind.example.test/roof-replacement', null, array[bp.id('kh1'), bp.id('kh2')], 'approved'),
  (bp.id('g_gu'), bp.id('c'), 'Gutters', 'service', 'https://bind.example.test/gutters', null, '{}', 'approved'),
  (bp.id('g_hub'), bp.id('c'), 'Exterior', 'hub', null, null, '{}', 'approved');

\c - authenticator
set role service_role;
select bp.as_user('service_role', null);
select bp.run();
reset role;

-- ── Worker and definition ───────────────────────────────────────────────────
\c - postgres
do $$ declare e text := bp.apply(bp.sp('rr'), 'set_service_page', '{}', bp.base(bp.sp('rr')) || jsonb_build_object('page_url', null, 'target_url', bp.tgt('g_rr')));
begin perform bp.ok('W1 the worker''s SQL still cannot apply', e like '42501%', e); end $$;
do $$
declare v_src text := (select prosrc from pg_proc where oid = 'authority_apply(uuid, text, jsonb, jsonb)'::regprocedure);
begin
  perform bp.ok('D1 authority_apply carries the 0052 bindings and is not security definer',
    v_src like '%(p_expected->>''target_url'') is distinct from g.target_url%' and v_src like '%''removed_from''%'
    and v_src like '%''location_unapproved''%' and v_src like '%array_remove(supporting_keyword_ids, v_kw.id)%'
    and not (select prosecdef from pg_proc where oid = 'authority_apply(uuid, text, jsonb, jsonb)'::regprocedure));
end $$;

-- ── set_service_page ────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := bp.sp('rr');
begin
  e := bp.apply(k, 'set_service_page', '{}', bp.base(k) || '{"page_url": null}');
  perform bp.ok('S1 a preview without target_url is refused (AU409), nothing written', e like 'AU409%' and bp.page_url('rr') is null, e);
  perform bp.save('s_exp', bp.base(k) || jsonb_build_object('page_url', null, 'target_url', bp.tgt('g_rr')));
end $$;
reset role;
\c - postgres
-- A second teammate re-points the group to another live page after the preview.
update page_groups set target_url = 'https://bind.example.test/roofs' where id = bp.id('g_rr');
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := bp.sp('rr');
begin
  e := bp.apply(k, 'set_service_page', '{}', bp.saved('s_exp'));
  perform bp.ok('S2 a page group re-pointed after the preview is refused (AU409), page_url untouched',
    e like 'AU409%' and bp.page_url('rr') is null and bp.decisions(k) = 0, e);
  e := bp.apply(k, 'set_service_page', '{}', bp.base(k) || jsonb_build_object('page_url', null, 'target_url', bp.tgt('g_rr')));
  perform bp.ok('S3 a fresh preview of the new target applies exactly that target',
    e is null and bp.page_url('rr') = 'https://bind.example.test/roofs' and bp.decisions(k) = 1, e);
end $$;
reset role;
\c - postgres
update page_groups set target_url = 'https://bind.example.test/roof-replacement' where id = bp.id('g_rr');

-- ── rehome_keywords ─────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := bp.own();
begin
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kh1'), 'destination', 'home'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('kh1', 'home') - 'removed_from')));
  perform bp.ok('H1 a Home preview without removed_from is refused (AU409)', e like 'AU409%' and (bp.kwrow('kh1')).service_id = bp.id('rr'), e);
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kh1'), 'destination', 'home'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('kh1', 'home') - 'destination_url')));
  perform bp.ok('H2 a Home preview without destination_url is refused (AU409)', e like 'AU409%' and (bp.kwrow('kh1')).service_id = bp.id('rr'), e);
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kh1'), 'destination', 'home'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('kh1', 'home') || '{"removed_from": []}')));
  perform bp.ok('H3 a Home preview naming fewer page groups than list the keyword is refused (AU409)',
    e like 'AU409%' and bp.listed('kh1') = array['g_rr'], e);
  perform bp.save('h_kh1', bp.row_exp('kh1', 'home'));
  perform bp.save('h_ks', bp.row_exp('ks', 'g_rr'));
  perform bp.save('h_kh2', bp.row_exp('kh2', 'home'));
end $$;
reset role;
\c - postgres
-- After the preview, another group starts listing kh1 and Roof Replacement is re-pointed.
update page_groups set supporting_keyword_ids = array[bp.id('kh1')] where id = bp.id('g_hub');
update page_groups set target_url = 'https://bind.example.test/roofs' where id = bp.id('g_rr');
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := bp.own();
begin
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kh1'), 'destination', 'home'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.saved('h_kh1'))));
  perform bp.ok('H4 a page group that started listing the keyword after the preview is refused (AU409), nothing written',
    e like 'AU409%' and (bp.kwrow('kh1')).service_id = bp.id('rr') and bp.listed('kh1') = array['g_hub', 'g_rr'] and bp.decisions(k) = 0, e);
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('ks'), 'destination', 'service_page'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.saved('h_ks'))));
  perform bp.ok('H5 a service page re-pointed after the preview is refused (AU409)', e like 'AU409%' and (bp.kwrow('ks')).target_url = '/', e);
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', bp.id('kh2'), 'destination', 'home'),
      jsonb_build_object('keyword_id', bp.id('ks'), 'destination', 'service_page'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.saved('h_kh2'), bp.saved('h_ks'))));
  perform bp.ok('H6 one stale row rolls back the valid Home row in the same batch',
    e like 'AU409%' and (bp.kwrow('kh2')).service_id = bp.id('rr') and bp.listed('kh2') = array['g_rr'] and bp.decisions(k) = 0, e);
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', bp.id('kh1'), 'destination', 'home'),
      jsonb_build_object('keyword_id', bp.id('ks'), 'destination', 'service_page'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('kh1', 'home'), bp.row_exp('ks', 'g_rr'))));
  perform bp.ok('H7 a fresh preview applies: Home row leaves exactly the groups it named, the service row takes the previewed target',
    e is null and (bp.kwrow('kh1')).service_id is null and bp.listed('kh1') = array['home']
    and (bp.kwrow('ks')).target_url = 'https://bind.example.test/roofs' and bp.decisions(k) = 1, e);
end $$;
reset role;
\c - postgres
-- The Home page group itself is re-pointed after a preview (to a URL that is still the home page).
do $$ begin perform bp.save('h_kh2b', bp.row_exp('kh2', 'home')); end $$;
update page_groups set target_url = 'https://bind.example.test' where id = bp.id('home');
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := bp.own();
begin
  e := bp.apply(k, 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kh2'), 'destination', 'home'))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.saved('h_kh2b'))));
  perform bp.ok('H8 a Home page group re-pointed after the preview is refused (AU409)',
    e like 'AU409%' and (bp.kwrow('kh2')).service_id = bp.id('rr'), e);
end $$;
reset role;

-- ── map_keywords ────────────────────────────────────────────────────────────
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := 'data_fix:unmapped-keywords';
begin
  e := bp.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('kul'), 'service_id', bp.id('gu')))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('kul', 'g_gu'))));
  perform bp.ok('M1 a keyword the analysis flags location_unapproved is refused (22023) with the market message',
    e like '22023%references an unapproved market. Decide on that market first.%' and (bp.kwrow('kul')).service_id is null, e);
  e := bp.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('ku1'), 'service_id', bp.id('gu')))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('ku1', 'g_gu') - 'destination_url')));
  perform bp.ok('M2 a map preview without destination_url is refused (AU409)', e like 'AU409%' and (bp.kwrow('ku1')).service_id is null, e);
  perform bp.save('m_ku1', bp.row_exp('ku1', 'g_gu'));
  perform bp.save('m_ku2', bp.row_exp('ku2', 'g_gu'));
end $$;
reset role;
\c - postgres
update page_groups set target_url = 'https://bind.example.test/gutter-guards' where id = bp.id('g_gu');
\c - authenticator
set role authenticated;
select bp.as_user('authenticated', :'team');
do $$
declare e text; k text := 'data_fix:unmapped-keywords';
begin
  e := bp.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', bp.id('ku1'), 'service_id', bp.id('gu')), jsonb_build_object('keyword_id', bp.id('ku2'), 'service_id', bp.id('gu')))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.saved('m_ku1'), bp.saved('m_ku2'))));
  perform bp.ok('M3 a service page re-pointed after the preview is refused (AU409), no row mapped',
    e like 'AU409%' and (bp.kwrow('ku1')).service_id is null and (bp.kwrow('ku2')).service_id is null and bp.decisions(k) = 0, e);
  e := bp.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', bp.id('ku1'), 'service_id', bp.id('gu')))),
    bp.base(k) || jsonb_build_object('rows', jsonb_build_array(bp.row_exp('ku1', 'g_gu'))));
  perform bp.ok('M4 a fresh preview maps to exactly the previewed target',
    e is null and (bp.kwrow('ku1')).service_id = bp.id('gu') and (bp.kwrow('ku1')).target_url = 'https://bind.example.test/gutter-guards'
    and bp.decisions(k) = 1, e);
end $$;
reset role;

\c - postgres
\o
\pset footer off
select status, count(*) from bp.results group by status order by status;
select n, status, name, detail from bp.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from bp.results where status = 'fail';
  if f > 0 then raise exception '% preview-binding check(s) failed', f; end if;
end $$;
