-- Tests for migration 0050 (Authority CRM reconciliation: set_service_page,
-- rehome_keywords, record_content, map_keywords through authority_apply;
-- content_posts.origin; the portal work log's Compass-only filter), run by
-- scripts/test-portal-sandbox.sh after the 0049 suite, on clients of their
-- own. Own harness (rc). Fictional data only.
--
-- Callers, the way each reaches production:
--   person    psql as authenticator, role authenticated, team JWT (the app's server action)
--   portal    psql as authenticator, role authenticated, portal JWT
--   stranger  psql as authenticator, role authenticated, a sign-in on no team / portal row
--   anon      psql as authenticator, role anon
--   function  psql as authenticator, role service_role (authority-run)
--   worker    psql as postgres
--
-- :vectors is tests/fixtures/authority-norm-path-vectors.json, passed in by
-- the sandbox script; tests/authority-norm-path.test.mjs runs the same
-- vectors through the engine's normPath.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set prc    '00000000-0000-4000-a000-000000000016'
\set strngr '00000000-0000-4000-a000-000000000014'

\c - postgres
\o /dev/null
create schema rc;
create table rc.results (n serial, status text, name text, detail text);
create table rc.ids (k text primary key, id uuid);
grant usage on schema rc to anon, authenticated, service_role;
grant insert, select on rc.results to anon, authenticated, service_role;
grant select, insert, update on rc.ids to anon, authenticated, service_role;
grant usage on sequence rc.results_n_seq to anon, authenticated, service_role;

create function rc.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into rc.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function rc.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function rc.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function rc.id(p_k text) returns uuid language sql stable as $$ select id from rc.ids where k = p_k $$;
create function rc.put(p_k text, p_id uuid) returns void language sql as $$
  insert into rc.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id $$;

insert into rc.ids values
  ('cr', '00000000-0000-4000-b000-0000000000f1'), ('cx', '00000000-0000-4000-b000-0000000000f2'),
  ('rr', '00000000-0000-4000-e000-0000000000f1'), ('gu', '00000000-0000-4000-e000-0000000000f2'),
  ('sd', '00000000-0000-4000-e000-0000000000f3'), ('pr', '00000000-0000-4000-e000-0000000000f4'),
  ('xs', '00000000-0000-4000-e000-0000000000f9'),
  ('kh0', '00000000-0000-4000-d000-0000000000f0'), ('kh1', '00000000-0000-4000-d000-0000000000f1'),
  ('kh2', '00000000-0000-4000-d000-0000000000f2'), ('kh3', '00000000-0000-4000-d000-0000000000f3'),
  ('kh4', '00000000-0000-4000-d000-0000000000f4'), ('kh5', '00000000-0000-4000-d000-0000000000f5'),
  ('ku1', '00000000-0000-4000-d000-0000000000f6'), ('ku2', '00000000-0000-4000-d000-0000000000f7'),
  ('ku3', '00000000-0000-4000-d000-0000000000f8'), ('ku4', '00000000-0000-4000-d000-0000000000f9'),
  ('kx1', '00000000-0000-4000-d000-0000000000fa'),
  ('home', '00000000-0000-4000-f000-0000000000f0');

-- A page of the stored site snapshot, shaped like authority/types.ts SitePage.
create function rc.page(p_path text, p_status int, p_final text default null, p_h1 text default null, p_title text default null, p_final_status int default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object('url', 'https://www.recon.example.test' || p_path, 'status', p_status,
    'final_url', 'https://www.recon.example.test' || coalesce(p_final, p_path), 'final_status', coalesce(p_final_status, p_status),
    'redirect_loop', false, 'in_sitemap', true, 'title', p_title, 'h1', p_h1, 'h2', '[]'::jsonb, 'canonical', null, 'words', 300, 'text', 'fixture')
$$;
create function rc.inventory() returns jsonb language sql immutable as $$
  select jsonb_build_object('fetched_at', now(), 'site', 'https://www.recon.example.test', 'pages', jsonb_build_array(
    rc.page('/', 200, null, 'Recon Roofing', 'Recon Roofing'),
    rc.page('/roof-replacement', 200, null, 'Roof Replacement'),
    rc.page('/gutters', 200, null, 'Gutters'),
    rc.page('/storm-damage', 404),
    rc.page('/blog', 200, null, 'Blog'),
    rc.page('/blog/post-one', 200, null, 'Post One', 'Post One | Recon Roofing'),
    rc.page('/blog/post-two', 200, null, null, 'Post Two | Recon Roofing'),
    rc.page('/blog/old', 301, '/blog/new', null, null, 200),
    rc.page('/blog/dup', 200, null, 'Dup'),
    rc.page('/blog/broken', 500),
    rc.page('/blog/%E2%9C%93-check', 200, null, 'Check')))
$$;
create function rc.opp(p_key text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_key, 'key', p_key, 'section', 'fix_now', 'action', 'improve', 'tier', 'A', 'content_type', 'data_fix',
    'topic', p_key, 'service_id', null, 'objective', null, 'order', jsonb_build_array(0), 'eligible_from', null, 'gap', 'fixture',
    'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', null, 'owner_path', null, 'cta', null),
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
create function rc.kw(p_k text, p_role text, p_flags text[], p_service text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('keyword_id', rc.id(p_k), 'role', p_role, 'flags', to_jsonb(p_flags), 'service_id', rc.id(p_service), 'target_path', null)
$$;
create function rc.report() returns jsonb language sql stable as $$
  select jsonb_build_object('client', jsonb_build_object('id', rc.id('cr')), 'as_of', current_date, 'sources', '{}'::jsonb,
    'keywords', jsonb_build_array(
      rc.kw('kh0', 'primary', '{}'),
      rc.kw('kh1', 'homepage_pollution', '{homepage_pollution,home_eligible}', 'rr'),
      rc.kw('kh2', 'homepage_pollution', '{homepage_pollution,home_eligible}', 'rr'),
      rc.kw('kh3', 'homepage_pollution', '{homepage_pollution}', 'rr'),
      rc.kw('kh4', 'homepage_pollution', '{homepage_pollution}', 'rr'),
      rc.kw('kh5', 'primary', '{}', 'rr'),
      rc.kw('ku1', 'unmapped', '{}'), rc.kw('ku2', 'unmapped', '{}'), rc.kw('ku3', 'unmapped', '{}'),
      rc.kw('ku4', 'supporting', '{}')),
    'opportunities', jsonb_build_array(
      rc.opp('data_fix:service-page:' || rc.id('rr')), rc.opp('data_fix:service-page:' || rc.id('gu')),
      rc.opp('data_fix:service-page:' || rc.id('sd')), rc.opp('data_fix:service-page:' || rc.id('pr')),
      rc.opp('data_fix:service-page:' || rc.id('xs')),
      rc.opp('data_fix:keyword-ownership:' || rc.id('rr')),
      rc.opp('data_fix:record-live-blog-posts'), rc.opp('data_fix:unmapped-keywords'),
      rc.opp('confirm_market:elsewhere')))
$$;
create function rc.run() returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run(rc.id('cr'), 'full', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.1', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('ab', 32), 'section_hashes', authority_fingerprint(rc.id('cr')),
    'inventory', rc.inventory(), 'inventory_errors', 0, 'report', rc.report()));
  return r;
end $$;
create function rc.o(p_key text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = rc.id('cr') and key = p_key $$;
create function rc.oid(p_key text) returns uuid language sql stable as $$ select (rc.o(p_key)).id $$;
create function rc.events(p_key text, p_kind text default null) returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_events where opportunity_id = rc.oid(p_key) and (p_kind is null or kind = p_kind) $$;
create function rc.last(p_key text, p_kind text) returns jsonb language sql stable security definer as $$
  select detail from public.authority_opportunity_events where opportunity_id = rc.oid(p_key) and kind = p_kind order by created_at desc, id desc limit 1 $$;
create function rc.exp(p_key text, p_extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('run_id', (rc.o(p_key)).last_seen_run_id, 'status', (rc.o(p_key)).status,
    'suppressed', (rc.o(p_key)).suppressed, 'dismissed_until', (rc.o(p_key)).dismissed_until) || p_extra $$;
-- The preview's rows: each selected keyword as it stands now.
create function rc.rows_exp(p_keys text[]) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('keyword_id', k.id, 'service_id', k.service_id, 'target_url', k.target_url)), '[]'::jsonb)
  from unnest(p_keys) n join public.keywords k on k.id = rc.id(n) $$;
create function rc.apply(p_key text, p_action text, p_payload jsonb, p_expected jsonb) returns text language sql as $$
  select rc.try(format('select authority_apply(%L, %L, %L::jsonb, %L::jsonb)', rc.oid(p_key), p_action, p_payload, p_expected)) $$;
create function rc.kwrow(p_k text) returns public.keywords language sql stable security definer as $$ select * from public.keywords where id = rc.id(p_k) $$;
create function rc.count(p_sql text) returns bigint language plpgsql security definer as $$
declare n bigint; begin execute p_sql into n; return n; end $$;
grant execute on all functions in schema rc to anon, authenticated, service_role;

-- Keys, spelled once.
create function rc.sp(p text) returns text language sql stable as $$ select 'data_fix:service-page:' || rc.id(p) $$;
create function rc.own() returns text language sql stable as $$ select 'data_fix:keyword-ownership:' || rc.id('rr') $$;
grant execute on function rc.sp(text), rc.own() to anon, authenticated, service_role;

insert into auth.users (id, email, email_confirmed_at) values (:'prc', 'portal-recon@example.test', now());
insert into clients (id, name, city, state, website_url, status) values
  (rc.id('cr'), 'Recon Roofing', 'Wentzville', 'MO', 'https://www.recon.example.test', 'active'),
  (rc.id('cx'), 'Other Recon', 'Columbia', 'MO', 'https://other-recon.example.test', 'active');
insert into portal_users (client_id, email, is_active) values (rc.id('cr'), 'portal-recon@example.test', true);
insert into services (id, client_id, name, status, page_url) values
  (rc.id('rr'), rc.id('cr'), 'Roof Replacement', 'approved', null),
  (rc.id('gu'), rc.id('cr'), 'Gutters', 'approved', null),
  (rc.id('sd'), rc.id('cr'), 'Storm Damage', 'approved', null),
  (rc.id('pr'), rc.id('cr'), 'Skylights', 'proposed', null),
  (rc.id('xs'), rc.id('cx'), 'Siding', 'approved', null);
insert into keywords (id, client_id, keyword, service_id, target_url) values
  (rc.id('kh0'), rc.id('cr'), 'recon roofing', null, 'https://www.recon.example.test/'),
  (rc.id('kh1'), rc.id('cr'), 'roofer near me', rc.id('rr'), 'https://www.recon.example.test/'),
  (rc.id('kh2'), rc.id('cr'), 'roofing company', rc.id('rr'), '/'),
  (rc.id('kh3'), rc.id('cr'), 'roof replacement cost', rc.id('rr'), 'https://recon.example.test'),
  (rc.id('kh4'), rc.id('cr'), 'new roof price', rc.id('rr'), '/'),
  (rc.id('kh5'), rc.id('cr'), 'roof replacement', rc.id('rr'), '/roof-replacement'),
  (rc.id('ku1'), rc.id('cr'), 'gutter guards', null, null),
  (rc.id('ku2'), rc.id('cr'), 'hail damage roof', null, null),
  (rc.id('ku3'), rc.id('cr'), 'seamless gutters', null, null),
  (rc.id('ku4'), rc.id('cr'), 'metal roof', null, null),
  (rc.id('kx1'), rc.id('cx'), 'other siding', rc.id('xs'), '/');
insert into page_groups (id, client_id, name, page_type, target_url, primary_keyword_id, supporting_keyword_ids, status) values
  (rc.id('home'), rc.id('cr'), 'Home', 'home', 'https://www.recon.example.test/', rc.id('kh0'), '{}', 'approved');
insert into page_groups (client_id, name, page_type, target_url, supporting_keyword_ids, status) values
  (rc.id('cr'), 'Roof Replacement', 'service', 'https://www.recon.example.test/roof-replacement/', '{}', 'approved'),
  (rc.id('cr'), 'Gutters', 'service', 'https://recon.example.test/gutters', '{}', 'approved'),
  (rc.id('cr'), 'Storm Damage', 'service', 'https://www.recon.example.test/storm-damage', '{}', 'approved'),
  (rc.id('cx'), 'Siding', 'service', 'https://other-recon.example.test/siding', '{}', 'approved');
-- Compass's own post, recorded before 0050 would have been: no origin given.
insert into content_posts (client_id, title, status, url, published_at) values
  (rc.id('cr'), 'Dup (written by Compass)', 'published', 'https://recon.example.test/blog/dup/', '2026-09-01');
-- A switch the atomicity test uses to make the link insert fail AFTER the content_posts insert.
create function rc.fail_link() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('rc.fail_link', true), '') = 'on' then raise exception 'forced link failure' using errcode = 'XX001'; end if;
  return new;
end $$;
create trigger rc_fail_link before insert on authority_opportunity_links for each row execute function rc.fail_link();

-- ── D. Schema ───────────────────────────────────────────────────────────────
do $$ begin
  perform rc.ok('D1 an existing row defaults to origin compass',
    (select origin from content_posts where client_id = rc.id('cr')) = 'compass'
    and not exists (select 1 from content_posts where origin <> 'compass'));
  perform rc.ok('D2 origin takes only compass or site_inventory',
    rc.try($q$insert into content_posts (client_id, title, origin) values ('00000000-0000-4000-b000-0000000000f2', 'x', 'imported')$q$) like '23514%');
  perform rc.ok('D3 no 0050 helper is security definer and authority_apply is not',
    not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('authority_apply', 'authority_url_decode', 'authority_norm_path', 'authority_page_state', 'authority_service_group', 'authority_selected_rows')));
  perform rc.ok('D4 anon can execute none of them',
    not has_function_privilege('anon', 'authority_apply(uuid, text, jsonb, jsonb)', 'execute')
    and not has_function_privilege('anon', 'authority_page_state(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'authority_norm_path(text, text)', 'execute')
    and not has_function_privilege('anon', 'authority_selected_rows(jsonb, jsonb)', 'execute'));
  perform rc.ok('D5 record_content serialises per client (advisory lock in the body)',
    (select prosrc from pg_proc where oid = 'authority_apply(uuid, text, jsonb, jsonb)'::regprocedure) like '%pg_advisory_xact_lock(hashtextextended(''authority:content_posts:''%');
  perform rc.ok('D6 the portal work log is still client-filtered, Compass-only, owner-run and select-only',
    pg_get_viewdef('portal_work_log'::regclass) like '%portal_client_id()%'
    and pg_get_viewdef('portal_work_log'::regclass) like '%origin = ''compass''%'
    and (select reloptions from pg_class where oid = 'portal_work_log'::regclass) = array['security_invoker=false']
    and not has_table_privilege('anon', 'portal_work_log', 'select')
    and not has_table_privilege('authenticated', 'portal_work_log', 'insert,update,delete'));
end $$;

-- ── N. authority_norm_path agrees with the engine's normPath ────────────────
create temp table rc_vectors as select :'vectors'::jsonb as j;
do $$
declare v jsonb; site text; got text; bad text[] := '{}';
begin
  select j->>'site' into site from rc_vectors;
  for v in select x from rc_vectors, jsonb_array_elements(j->'vectors') x loop
    got := authority_norm_path(v->>'url', site);
    if got is distinct from (v->>'expect') then bad := bad || format('%s → %s (want %s)', v->>'url', coalesce(got, 'null'), coalesce(v->>'expect', 'null')); end if;
  end loop;
  perform rc.ok('N1 every shared vector matches normPath', cardinality(bad) = 0 and (select jsonb_array_length(j->'vectors') from rc_vectors) >= 10, array_to_string(bad, '; '));
  perform rc.ok('N2 stricter than the engine on what can never be ours: another scheme, protocol-relative',
    authority_norm_path('mailto:x@recon.example.test', site) is null and authority_norm_path('//recon.example.test/blog', site) is null);
end $$;

-- ── R. The report (the authority-run function) ──────────────────────────────
\c - authenticator
set role service_role;
select rc.as_user('service_role', null);
select rc.put('r1', rc.run());
do $$ begin
  perform rc.ok('R1 nine opportunities for the client', (select count(*) from authority_opportunities where client_id = rc.id('cr')) = 9);
  perform rc.ok('R2 the page states come from the stored snapshot',
    authority_page_state(rc.id('r1'), '/roof-replacement')->>'state' = 'live'
    and authority_page_state(rc.id('r1'), '/storm-damage')->>'state' = 'missing'
    and authority_page_state(rc.id('r1'), '/blog/old')->>'state' = 'redirects'
    and authority_page_state(rc.id('r1'), '/blog/old')->>'final_path' = '/blog/new'
    and authority_page_state(rc.id('r1'), '/blog/broken')->>'state' = 'error'
    and authority_page_state(rc.id('r1'), '/blog/nope')->>'state' = 'not_checked'
    and authority_page_state(rc.id('r1'), '/blog/✓-check')->>'state' = 'live');
end $$;
do $$ declare e text := rc.apply('data_fix:record-live-blog-posts', 'record_content', '{"paths": ["/blog/post-one"]}', rc.exp('data_fix:record-live-blog-posts'));
begin perform rc.ok('C1 the service caller cannot apply', e like '42501%', e); end $$;
reset role;

-- ── C. Nobody but a teammate ────────────────────────────────────────────────
set role authenticated;
select rc.as_user('authenticated', :'prc');
do $$ declare e text := rc.apply('data_fix:record-live-blog-posts', 'record_content', '{"paths": ["/blog/post-one"]}', '{}');
begin perform rc.ok('C2 the client''s own portal contact cannot apply', e like '42501%', e); end $$;
select rc.as_user('authenticated', :'strngr');
do $$ declare e text := rc.apply('data_fix:record-live-blog-posts', 'record_content', '{"paths": ["/blog/post-one"]}', '{}');
begin perform rc.ok('C3 a signed-in stranger cannot apply', e like '42501%', e); end $$;
reset role;
set role anon;
select rc.as_user('anon', null);
do $$ declare e text := rc.apply('data_fix:record-live-blog-posts', 'record_content', '{"paths": ["/blog/post-one"]}', '{}');
begin perform rc.ok('C4 anon cannot apply', e like '42501%', e); end $$;
reset role;
\c - postgres
do $$ declare e text := rc.apply('data_fix:record-live-blog-posts', 'record_content', '{"paths": ["/blog/post-one"]}', rc.exp('data_fix:record-live-blog-posts'));
begin perform rc.ok('C5 the worker''s SQL cannot apply', e like '42501%', e); end $$;
set role authenticated;
select rc.as_user('authenticated', :'team');
do $$ declare e text := rc.apply(rc.sp('rr'), 'set_service_page', '{}', rc.exp(rc.sp('rr'), '{"page_url": null}'));
begin perform rc.ok('C6 ...nor after SET ROLE authenticated with a team JWT (session_user is still postgres)', e like '42501%', e); end $$;
reset role;
do $$ begin
  perform rc.ok('C7 none of the refused calls wrote anything',
    (select count(*) from content_posts where client_id = rc.id('cr')) = 1
    and (select page_url from services where id = rc.id('rr')) is null
    and (select count(*) from authority_opportunity_events e join authority_opportunities o on o.id = e.opportunity_id
         where o.client_id = rc.id('cr') and e.kind <> 'created') = 0);
end $$;

-- ── S. Batches: 1-25 explicitly selected rows, exactly the preview's ────────
do $$ begin
  perform rc.ok('S1 no rows is refused', rc.try($q$select authority_selected_rows('[]', '[]')$q$) like '22023%');
  perform rc.ok('S2 26 rows is refused (the SQL cap)', rc.try(format('select authority_selected_rows(%L, %L)',
    (select jsonb_agg(jsonb_build_object('keyword_id', gen_random_uuid())) from generate_series(1, 26)), '[]')) like '22023%');
  perform rc.ok('S3 25 rows is allowed', rc.try(format('select authority_selected_rows(%1$L, %1$L)',
    (select jsonb_agg(jsonb_build_object('keyword_id', gen_random_uuid())) from generate_series(1, 25)))) is null);
  perform rc.ok('S4 a keyword selected twice is refused',
    rc.try(format('select authority_selected_rows(%1$L, %1$L)', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1')), jsonb_build_object('keyword_id', rc.id('ku1'))))) like '22023%');
  perform rc.ok('S5 a selection other than the preview''s is refused (AU409)',
    rc.try(format('select authority_selected_rows(%L, %L)', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1')), jsonb_build_object('keyword_id', rc.id('ku2'))),
      jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1'))))) like 'AU409%');
  perform rc.ok('S6 a row with no keyword is refused',
    rc.try($q$select authority_selected_rows('[{"destination": "home"}]', '[{}]')$q$) like '22023%');
end $$;

-- ── T. A teammate ───────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select rc.as_user('authenticated', :'team');

-- set_service_page
do $$
declare e text;
begin
  e := rc.apply(rc.sp('rr'), 'set_service_page', '{}', rc.exp(rc.sp('rr'), '{"page_url": "https://www.recon.example.test/old"}'));
  perform rc.ok('P1 a page URL other than the preview''s is refused (AU409)', e like 'AU409%', e);
  e := rc.apply(rc.sp('rr'), 'set_service_page', '{}', rc.exp(rc.sp('rr'), '{"page_url": null}') || '{"run_id": "00000000-0000-4000-0000-000000000000"}');
  perform rc.ok('P2 another run than the preview''s is refused (AU409)', e like 'AU409%', e);
  e := rc.apply(rc.sp('pr'), 'set_service_page', '{}', rc.exp(rc.sp('pr'), '{"page_url": null}'));
  perform rc.ok('P3 a proposed service takes no service page', e like '22023%', e);
  e := rc.apply(rc.sp('sd'), 'set_service_page', '{}', rc.exp(rc.sp('sd'), '{"page_url": null}'));
  perform rc.ok('P4 a page group whose page is missing (404) is refused, page_url untouched',
    e like '22023%' and (rc.count($q$select count(*) from services where id = '00000000-0000-4000-e000-0000000000f3' and page_url is null$q$)) = 1, e);
  e := rc.apply(rc.sp('xs'), 'set_service_page', '{}', rc.exp(rc.sp('xs'), '{"page_url": null}'));
  perform rc.ok('P5 another client''s service is out of reach (AU409, gone)', e like 'AU409%'
    and rc.count($q$select count(*) from services where id = '00000000-0000-4000-e000-0000000000f9' and page_url is null$q$) = 1, e);
  e := rc.apply(rc.sp('rr'), 'record_content', '{"paths": ["/blog/post-one"]}', rc.exp(rc.sp('rr')));
  perform rc.ok('P6 another reconciliation action on a service-page fix is refused', e like '22023%', e);
  e := rc.apply(rc.sp('rr'), 'set_service_page', '{}', rc.exp(rc.sp('rr'), '{"page_url": null}'));
  perform rc.ok('P7 set_service_page writes the approved page group''s live target',
    e is null and rc.count($q$select count(*) from services where id = '00000000-0000-4000-e000-0000000000f1' and page_url = 'https://www.recon.example.test/roof-replacement/'$q$) = 1, e);
  perform rc.ok('P8 ...with one decision event carrying before / after',
    rc.events(rc.sp('rr'), 'decision') = 1 and rc.last(rc.sp('rr'), 'decision')->>'action' = 'set_service_page'
    and rc.last(rc.sp('rr'), 'decision')->'before'->'services.page_url' = 'null'::jsonb
    and rc.last(rc.sp('rr'), 'decision')->'after'->>'services.page_url' = 'https://www.recon.example.test/roof-replacement/');
  e := rc.apply(rc.sp('rr'), 'set_service_page', '{}', rc.exp(rc.sp('rr'), '{"page_url": null}'));
  perform rc.ok('P9 applying the same preview twice is refused (AU409)', e like 'AU409%' and rc.events(rc.sp('rr'), 'decision') = 1, e);
  e := rc.apply('confirm_market:elsewhere', 'set_service_page', '{}', rc.exp('confirm_market:elsewhere'));
  perform rc.ok('P10 set_service_page on another kind of opportunity is refused', e like '22023%', e);
end $$;

-- rehome_keywords
do $$
declare e text;
begin
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', (select jsonb_agg(jsonb_build_object('keyword_id', gen_random_uuid(), 'destination', 'home')) from generate_series(1, 26))),
    rc.exp(rc.own(), '{"rows": []}'));
  perform rc.ok('K1 more than 25 rows is refused', e like '22023%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh1'), 'destination', 'home'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh1,kh2}'))));
  perform rc.ok('K2 a selection other than the preview''s is refused (AU409)', e like 'AU409%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh3'), 'destination', 'home'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh3}'))));
  perform rc.ok('K3 Home is refused for a keyword the analysis does not mark home_eligible (no arbitrary keyword to Home)',
    e like '22023%' and (rc.kwrow('kh3')).service_id = rc.id('rr'), e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh1'), 'destination', 'blog'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh1}'))));
  perform rc.ok('K4 an unknown destination is refused', e like '22023%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh5'), 'destination', 'service_page'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh5}'))));
  perform rc.ok('K5 a keyword that does not target the home page is refused', e like '22023%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kx1'), 'destination', 'service_page'))),
    jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kx1'), 'service_id', rc.id('xs'), 'target_url', '/'))) || rc.exp(rc.own()));
  perform rc.ok('K6 another client''s keyword is out of reach (AU409, gone)', e like 'AU409%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh1'), 'destination', 'home'))),
    rc.exp(rc.own(), jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh1'), 'service_id', rc.id('rr'), 'target_url', '/other')))));
  perform rc.ok('K7 a keyword that changed since the preview is refused (AU409)', e like 'AU409%', e);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', rc.id('kh4'), 'destination', 'service_page'),
      jsonb_build_object('keyword_id', rc.id('kh3'), 'destination', 'home'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh3,kh4}'))));
  perform rc.ok('K8 one refused row rolls the whole batch back', e like '22023%'
    and (rc.kwrow('kh4')).target_url = '/' and (rc.kwrow('kh3')).service_id = rc.id('rr'), e);

  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', rc.id('kh1'), 'destination', 'home'),
      jsonb_build_object('keyword_id', rc.id('kh2'), 'destination', 'home'),
      jsonb_build_object('keyword_id', rc.id('kh3'), 'destination', 'service_page'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh1,kh2,kh3}'))));
  perform rc.ok('K9 home_eligible keywords move to Home: no service, the Home page group''s target', e is null
    and (rc.kwrow('kh1')).service_id is null and (rc.kwrow('kh1')).target_url = 'https://www.recon.example.test/'
    and (rc.kwrow('kh2')).service_id is null, e);
  perform rc.ok('K10 ...and support the approved Home page group (once each; the primary stays primary)',
    rc.count($q$select count(*) from page_groups where id = '00000000-0000-4000-f000-0000000000f0'
      and supporting_keyword_ids = array['00000000-0000-4000-d000-0000000000f1', '00000000-0000-4000-d000-0000000000f2']::uuid[]
      and primary_keyword_id = '00000000-0000-4000-d000-0000000000f0'$q$) = 1);
  perform rc.ok('K11 a service-specific keyword stays with its service, re-homed to the live service page',
    (rc.kwrow('kh3')).service_id = rc.id('rr') and (rc.kwrow('kh3')).target_url = 'https://www.recon.example.test/roof-replacement/');
  perform rc.ok('K12 one decision event listing every row with before / after',
    rc.events(rc.own(), 'decision') = 1 and jsonb_array_length(rc.last(rc.own(), 'decision')->'rows') = 3
    and rc.last(rc.own(), 'decision')->'rows'->0->'before'->>'service_id' = rc.id('rr')::text);
  e := rc.apply(rc.own(), 'rehome_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh1'), 'destination', 'home'))),
    rc.exp(rc.own(), jsonb_build_object('rows', rc.rows_exp('{kh1}'))));
  perform rc.ok('K13 re-homing a keyword already moved is refused', e like '22023%', e);
end $$;

-- record_content
do $$
declare e text; k text := 'data_fix:record-live-blog-posts';
begin
  e := rc.apply(k, 'record_content', '{"paths": []}', rc.exp(k));
  perform rc.ok('B1 no pages is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', jsonb_build_object('paths', (select jsonb_agg('/blog/p' || i) from generate_series(1, 26) i)), rc.exp(k));
  perform rc.ok('B2 more than 25 pages is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one", "/blog/post-one"]}', rc.exp(k));
  perform rc.ok('B3 a page selected twice is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one/"]}', rc.exp(k));
  perform rc.ok('B4 a path that is not normalised is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["https://elsewhere.example.test/blog/post-one"]}', rc.exp(k));
  perform rc.ok('B5 a page on another site is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/gutters"]}', rc.exp(k));
  perform rc.ok('B6 a page outside the blog is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog"]}', rc.exp(k));
  perform rc.ok('B7 the blog index is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/old"]}', rc.exp(k));
  perform rc.ok('B8 a page that redirects is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/broken"]}', rc.exp(k));
  perform rc.ok('B9 a page that errors is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/nope"]}', rc.exp(k));
  perform rc.ok('B10 a page not in the snapshot is refused', e like '22023%', e);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one"]}', rc.exp(k) || '{"status": "accepted"}');
  perform rc.ok('B11 a workflow that changed since the preview is refused (AU409)', e like 'AU409%', e);
  perform set_config('rc.fail_link', 'on', false);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one"]}', rc.exp(k));
  perform set_config('rc.fail_link', '', false);
  perform rc.ok('B12 a link that fails after the insert rolls the content_posts row back', e like 'XX001%'
    and rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1'$q$) = 1 and rc.events(k) = 1, e);
  perform rc.ok('B13 nothing was written by any refusal', rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1'$q$) = 1);

  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one", "/blog/post-two", "/blog/dup", "/blog/✓-check"]}', rc.exp(k));
  perform rc.ok('B14 record_content records each new live page as site_inventory, published', e is null
    and rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1' and origin = 'site_inventory' and status = 'published'$q$) = 3, e);
  perform rc.ok('B15 ...titled from the h1, else the title without its site suffix, with the page''s URL',
    rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1' and origin = 'site_inventory'
      and ((title = 'Post One' and url = 'https://www.recon.example.test/blog/post-one')
        or (title = 'Post Two' and url = 'https://www.recon.example.test/blog/post-two')
        or (title = 'Check' and url = 'https://www.recon.example.test/blog/%E2%9C%93-check'))$q$) = 3);
  perform rc.ok('B16 ...never claimed as Compass''s work',
    rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1' and origin = 'site_inventory'
      and notes like '%Not produced by Compass.%' and published_at is null$q$) = 3);
  perform rc.ok('B17 a URL already recorded is skipped, not duplicated',
    rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1' and url like '%/blog/dup%'$q$) = 1
    and rc.last(k, 'decision')->'skipped' = '["/blog/dup"]'::jsonb);
  perform rc.ok('B18 each new row is linked to the opportunity, with one decision event',
    rc.count(format($q$select count(*) from authority_opportunity_links where opportunity_id = %L and kind = 'content_post'$q$, rc.oid(k))) = 3
    and rc.events(k, 'linked') = 3 and rc.events(k, 'decision') = 1
    and rc.last(k, 'decision')->>'origin' = 'site_inventory' and jsonb_array_length(rc.last(k, 'decision')->'rows') = 3);
  e := rc.apply(k, 'record_content', '{"paths": ["/blog/post-one", "/blog/post-two"]}', rc.exp(k));
  perform rc.ok('B19 recording the same pages again writes nothing', e is null
    and rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1'$q$) = 4
    and rc.events(k, 'decision') = 1, e);
  e := rc.try($q$update content_posts set origin = 'compass' where client_id = '00000000-0000-4000-b000-0000000000f1' and origin = 'site_inventory'$q$);
  perform rc.ok('B20 a teammate cannot relabel recorded content as Compass''s', e like '42501%'
    and rc.count($q$select count(*) from content_posts where client_id = '00000000-0000-4000-b000-0000000000f1' and origin = 'site_inventory'$q$) = 3, e);
  perform rc.ok('B21 a teammate still edits other fields of a recorded row',
    rc.try($q$update content_posts set notes = notes || ' Checked.' where client_id = '00000000-0000-4000-b000-0000000000f1' and title = 'Check'$q$) is null);
end $$;

-- map_keywords
do $$
declare e text; k text := 'data_fix:unmapped-keywords';
  one jsonb;
begin
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku4'), 'service_id', rc.id('gu')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku4}'))));
  perform rc.ok('M1 a keyword the analysis does not call unmapped is refused', e like '22023%', e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku2'), 'service_id', rc.id('sd')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku2}'))));
  perform rc.ok('M2 a service whose owner page is missing is not a destination (no temporary mapping)',
    e like '22023%' and (rc.kwrow('ku2')).service_id is null, e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1'), 'service_id', rc.id('pr')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku1}'))));
  perform rc.ok('M3 a proposed service is not a destination', e like '22023%', e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1'), 'service_id', rc.id('xs')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku1}'))));
  perform rc.ok('M4 another client''s service is not a destination', e like '22023%' and (rc.kwrow('ku1')).service_id is null, e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku1'), 'service_id', rc.id('gu')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku1}'))));
  perform rc.ok('M5 map_keywords to an approved service with a live owner page applies', e is null, e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('kh5'), 'service_id', rc.id('gu')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{kh5}'))));
  perform rc.ok('M6 a keyword that already has a service is refused', e like '22023%' and (rc.kwrow('kh5')).service_id = rc.id('rr'), e);
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku3'), 'service_id', rc.id('gu')))),
    rc.exp(k, jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('keyword_id', rc.id('ku3'), 'service_id', null, 'target_url', '/gutters')))));
  perform rc.ok('M7 a keyword that changed since the preview is refused (AU409)', e like 'AU409%', e);
end $$;
reset role;
-- M5 mapped ku1 to Gutters; M8 checks the result, then a two-row batch.
set role authenticated;
select rc.as_user('authenticated', :'team');
do $$
declare e text; k text := 'data_fix:unmapped-keywords';
begin
  perform rc.ok('M8 map_keywords sets the service and its live owner page',
    (rc.kwrow('ku1')).service_id = rc.id('gu') and (rc.kwrow('ku1')).target_url = 'https://recon.example.test/gutters'
    and rc.last(k, 'decision')->>'action' = 'map_keywords'
    and rc.last(k, 'decision')->'rows'->0->'after'->>'service' = 'Gutters');
  e := rc.apply(k, 'map_keywords', jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('keyword_id', rc.id('ku3'), 'service_id', rc.id('gu')),
      jsonb_build_object('keyword_id', rc.id('ku2'), 'service_id', rc.id('sd')))),
    rc.exp(k, jsonb_build_object('rows', rc.rows_exp('{ku2,ku3}'))));
  perform rc.ok('M9 one refused row rolls the whole batch back', e like '22023%' and (rc.kwrow('ku3')).service_id is null, e);
  perform rc.ok('M10 the decision events: one per applied batch', rc.events(k, 'decision') = 1);
end $$;
reset role;

-- ── W. Who sees what ────────────────────────────────────────────────────────
set role authenticated;
select rc.as_user('authenticated', :'prc');
do $$ begin
  perform rc.ok('W1 the client''s portal work log shows Compass''s post only',
    (select count(*) from portal_work_log where kind = 'post') = 1
    and (select min(label) from portal_work_log where kind = 'post') = 'Dup (written by Compass)');
  perform rc.ok('W2 ...never the pages recorded from the client''s own site',
    not exists (select 1 from portal_work_log where label in ('Post One', 'Post Two', 'Check')));
  perform rc.ok('W3 the portal still cannot read content_posts or call the helpers',
    rc.try('select count(*) from content_posts') like '42501%' or (select count(*) from content_posts) = 0);
end $$;
select rc.as_user('authenticated', :'pa');
do $$ begin
  perform rc.ok('W4 another client''s portal sees none of it', not exists (select 1 from portal_work_log where label like 'Dup%' or label in ('Post One', 'Post Two', 'Check')));
end $$;
select rc.as_user('authenticated', :'team');
do $$ begin
  perform rc.ok('W5 Authority coverage (authority_input) counts both origins',
    jsonb_array_length(authority_input(rc.id('cr'))->'authority'->'contentPosts') = 4);
end $$;
reset role;

\c - postgres
do $$ begin
  perform rc.ok('W6 the worker cannot relabel either', rc.try($q$update content_posts set origin = 'compass' where origin = 'site_inventory'$q$) like '42501%');
end $$;
drop trigger rc_fail_link on authority_opportunity_links;
\o
\pset footer off
select status, count(*) from rc.results group by status order by status;
select n, status, name, detail from rc.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from rc.results where status = 'fail';
  if f > 0 then raise exception '% authority reconciliation check(s) failed', f; end if;
end $$;
