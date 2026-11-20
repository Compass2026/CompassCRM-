-- 20261120190000: linking a long-tail keyword to its core keyword. Fictional
-- clients and example.test hosts only; everything is rolled back. Run as
-- supabase_admin (it switches to PostgREST's authenticator login).
--   S  single site, approved core list v1 of 50:
--        kCore      service s1, commercial, Wichita       (the parent)
--        kCore2     s1, commercial, no city               (a parent for any city)
--        kCore3     s1, commercial, no city               (the relink target)
--        kCoreInfo  s1, informational                     (intent_mismatch)
--        kCoreSvc2  s2, commercial                        (service_mismatch)
--        kCoreMkt   s1, commercial, market Wichita        (market_mismatch)
--        kCoreChild s1, commercial, names kCore2          (parent_has_parent)
--        kCoreGone  s1, commercial, inactive              (parent_inactive)
--        kCoreOP    s1, commercial, no city, text names Overland Park (place_mismatch)
--        kCoreTxt   s1, commercial, no city, text names Wichita
--        40 fillers
--      outside the list: kChild (s1, commercial, Wichita: the Logic case),
--      kTopeka, kNoSvc, kNoIntent, kOff, kInactive, kHasKids + kKid
--   N  single site, no approved list (core_list_missing)
--   M  two brand sites: M1 owns sM1, M2 owns sM2; mUnsited's service is on
--      neither (program_unresolved); M2's list holds mCore2 (parent_wrong_site)
begin;
create schema kl;
create function kl.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function kl.id(k text) returns uuid language sql immutable as $$ select md5('kl:' || k)::uuid $$;
create function kl.msg(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function kl.code(child text, parent text) returns text language sql stable as $$
  select split_part(keyword_core_link_problem(kl.id(child), kl.id(parent)), ':', 1) $$;
grant usage on schema kl to anon, authenticated, service_role;
grant execute on all functions in schema kl to anon, authenticated, service_role;
-- The place reference (a data step on production), for place_mismatch.
\ir ../../seeds/place-names-v1.sql

set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values
  (kl.id('S'), 'KL Single', 'active', 'https://s.kl.example.test'),
  (kl.id('N'), 'KL No list', 'active', 'https://n.kl.example.test'),
  (kl.id('M'), 'KL Multi', 'active', 'https://m.kl.example.test');
insert into services (id, client_id, name, status, page_url) values
  (kl.id('s1'), kl.id('S'), 'Installation', 'approved', 'https://s.kl.example.test/services/installation'),
  (kl.id('s2'), kl.id('S'), 'Repair', 'approved', 'https://s.kl.example.test/services/repair'),
  (kl.id('sN'), kl.id('N'), 'N service', 'approved', 'https://n.kl.example.test/service'),
  (kl.id('sM1'), kl.id('M'), 'M1 service', 'approved', 'https://m1.kl.example.test/service'),
  (kl.id('sM2'), kl.id('M'), 'M2 service', 'approved', 'https://m2.kl.example.test/service'),
  (kl.id('sMx'), kl.id('M'), 'M unsited', 'approved', 'https://m1.kl.example.test/other');
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids) values
  (kl.id('S'), 'Installation', 'service', 'https://s.kl.example.test/services/installation', 'approved', '{}'),
  (kl.id('S'), 'Repair', 'service', 'https://s.kl.example.test/services/repair', 'approved', '{}');
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref)
select g.client_id, g.target_url, core_norm_url(g.target_url), g.target_url, 200, 'live', 'http', 'test fixture'
  from page_groups g where g.client_id = kl.id('S');
insert into client_service_markets (id, client_id, city, state, status, basis, source_ref, decided_on) values
  (kl.id('mk.wichita'), kl.id('S'), 'Wichita', 'KS', 'approved', 'office', 'test fixture', current_date),
  (kl.id('mk.topeka'), kl.id('S'), 'Topeka', 'KS', 'approved', 'office', 'test fixture', current_date);
insert into keywords (id, client_id, keyword, service_id, is_active, intent, city, market_id, core_parent_keyword_id) values
  (kl.id('kCore'), kl.id('S'), 'zqx installation wichita ks', kl.id('s1'), true, 'commercial', 'Wichita', null, null),
  (kl.id('kCore2'), kl.id('S'), 'zqx installation company', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kCore3'), kl.id('S'), 'zqx installation service', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kCoreInfo'), kl.id('S'), 'zqx how installation works', kl.id('s1'), true, 'informational', null, null, null),
  (kl.id('kCoreSvc2'), kl.id('S'), 'zqx repair wichita', kl.id('s2'), true, 'commercial', 'Wichita', null, null),
  (kl.id('kCoreMkt'), kl.id('S'), 'zqx installers in wichita', kl.id('s1'), true, 'commercial', null, kl.id('mk.wichita'), null),
  (kl.id('kCoreChild'), kl.id('S'), 'zqx installation contractor', kl.id('s1'), true, 'commercial', null, null, kl.id('kCore2')),
  (kl.id('kCoreGone'), kl.id('S'), 'zqx retired installation', kl.id('s1'), false, 'commercial', null, null, null),
  (kl.id('kCoreOP'), kl.id('S'), 'zqx solar panels overland park ks', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kCoreTxt'), kl.id('S'), 'zqx installation contractors wichita ks', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kCityOnly'), kl.id('S'), 'zqx installers nearby', kl.id('s1'), true, 'commercial', 'Wichita', null, null),
  (kl.id('kChild'), kl.id('S'), 'zqx installers wichita ks', kl.id('s1'), true, 'commercial', 'Wichita', null, null),
  (kl.id('kTopeka'), kl.id('S'), 'zqx installers topeka ks', kl.id('s1'), true, 'commercial', 'Topeka', null, null),
  (kl.id('kNoSvc'), kl.id('S'), 'zqx installers near me', null, true, 'commercial', null, null, null),
  (kl.id('kNoIntent'), kl.id('S'), 'zqx installers', kl.id('s1'), true, null, null, null, null),
  (kl.id('kOff'), kl.id('S'), 'zqx install pros', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kInactive'), kl.id('S'), 'zqx old installers', kl.id('s1'), false, 'commercial', null, null, null),
  (kl.id('kHasKids'), kl.id('S'), 'zqx install specialists', kl.id('s1'), true, 'commercial', null, null, null),
  (kl.id('kKid'), kl.id('S'), 'zqx install specialists wichita', kl.id('s1'), true, 'commercial', 'Wichita', null, kl.id('kHasKids')),
  (kl.id('kN'), kl.id('N'), 'zqx n service', kl.id('sN'), true, 'commercial', null, null, null),
  (kl.id('kN2'), kl.id('N'), 'zqx n service near me', kl.id('sN'), true, 'commercial', null, null, null),
  (kl.id('mCore1'), kl.id('M'), 'zqx m1 core', kl.id('sM1'), true, 'commercial', null, null, null),
  (kl.id('mChild1'), kl.id('M'), 'zqx m1 core near me', kl.id('sM1'), true, 'commercial', null, null, null),
  (kl.id('mCore2'), kl.id('M'), 'zqx m2 core', kl.id('sM2'), true, 'commercial', null, null, null),
  (kl.id('mUnsited'), kl.id('M'), 'zqx m unsited', kl.id('sMx'), true, 'commercial', null, null, null);
insert into keywords (id, client_id, keyword, service_id, is_active, intent)
select kl.id('kF' || n), kl.id('S'), 'zqx filler ' || n, kl.id('s2'), true, 'informational' from generate_series(1, 42) n;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status) values
  (kl.id('M1'), kl.id('M'), 'm1', 'M One', 'https://m1.kl.example.test', '5555555555', array[kl.id('sM1')], 'draft'),
  (kl.id('M2'), kl.id('M'), 'm2', 'M Two', 'https://m2.kl.example.test', '5555555555', array[kl.id('sM2')], 'draft');
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at) values
  (kl.id('list.S'), kl.id('S'), null, 1, 'approved',
   array[kl.id('kCore'), kl.id('kCore2'), kl.id('kCore3'), kl.id('kCoreInfo'), kl.id('kCoreSvc2'), kl.id('kCoreMkt'),
         kl.id('kCoreChild'), kl.id('kCoreGone'), kl.id('kCoreOP'), kl.id('kCoreTxt')]
         || (select array_agg(kl.id('kF' || n) order by n) from generate_series(1, 40) n),
   'test fixture', (select id from team_members limit 1), now()),
  (kl.id('list.M1'), kl.id('M'), kl.id('M1'), 1, 'approved', array[kl.id('mCore1')], 'test fixture', (select id from team_members limit 1), now()),
  (kl.id('list.M2'), kl.id('M'), kl.id('M2'), 1, 'approved', array[kl.id('mCore2')], 'test fixture', (select id from team_members limit 1), now());
set local session_replication_role = origin;

-- ── The rule ────────────────────────────────────────────────────────────────
do $$ begin
  perform kl.ok('C0 the fixture list is the approved 50, and kChild is outside it',
    (select cardinality(keyword_ids) from core_keyword_lists where id = kl.id('list.S')) = 50
    and not exists (select 1 from core_keyword_grounding(kl.id('S'), kl.id('kChild'))));
  perform kl.ok('C1 same service, intent and city, parent in the approved list: eligible', keyword_core_link_problem(kl.id('kChild'), kl.id('kCore')) is null);
  perform kl.ok('C2 a parent with no city serves any city', keyword_core_link_problem(kl.id('kTopeka'), kl.id('kCore2')) is null);
  perform kl.ok('C3 keyword_unknown', split_part(keyword_core_link_problem(kl.id('nope'), kl.id('kCore')), ':', 1) = 'keyword_unknown');
  perform kl.ok('C4 keyword_inactive', kl.code('kInactive', 'kCore') = 'keyword_inactive');
  perform kl.ok('C5 parent_is_self', kl.code('kChild', 'kChild') = 'parent_is_self');
  perform kl.ok('C6 parent_unknown', split_part(keyword_core_link_problem(kl.id('kChild'), kl.id('nope')), ':', 1) = 'parent_unknown');
  perform kl.ok('C7 parent_other_client', kl.code('kChild', 'kN') = 'parent_other_client');
  perform kl.ok('C8 parent_inactive', kl.code('kChild', 'kCoreGone') = 'parent_inactive');
  perform kl.ok('C9 core_list_missing (no approved list for the site)', kl.code('kN2', 'kN') = 'core_list_missing');
  perform kl.ok('C10 parent_not_core (the parent is outside the approved list)', kl.code('kChild', 'kOff') = 'parent_not_core');
  perform kl.ok('C11 keyword_is_core (a list member needs no parent)', kl.code('kCore', 'kCore2') = 'keyword_is_core');
  perform kl.ok('C12 parent_has_parent (no chains)', kl.code('kChild', 'kCoreChild') = 'parent_has_parent');
  perform kl.ok('C13 keyword_has_children (no chains)', kl.code('kHasKids', 'kCore2') = 'keyword_has_children');
  perform kl.ok('C14 service_missing', kl.code('kNoSvc', 'kCore2') = 'service_missing');
  perform kl.ok('C15 service_mismatch', kl.code('kChild', 'kCoreSvc2') = 'service_mismatch');
  perform kl.ok('C16 intent_missing', kl.code('kNoIntent', 'kCore2') = 'intent_missing');
  perform kl.ok('C17 intent_mismatch', kl.code('kChild', 'kCoreInfo') = 'intent_mismatch');
  perform kl.ok('C18 market_mismatch', kl.code('kChild', 'kCoreMkt') = 'market_mismatch');
  perform kl.ok('C19 city_mismatch', kl.code('kTopeka', 'kCore') = 'city_mismatch');
  perform kl.ok('C20 program_unresolved (a multi-brand keyword on no single site)', kl.code('mUnsited', 'mCore1') = 'program_unresolved');
  perform kl.ok('C21 parent_wrong_site (another brand site''s core keyword)', kl.code('mChild1', 'mCore2') = 'parent_wrong_site');
  perform kl.ok('C22 a brand site''s own core keyword is eligible', keyword_core_link_problem(kl.id('mChild1'), kl.id('mCore1')) is null);
  perform kl.ok('C24 place_mismatch: a parent with no city whose text names another place (Overland Park) is refused',
    kl.code('kChild', 'kCoreOP') = 'place_mismatch' and kl.code('kTopeka', 'kCoreOP') = 'place_mismatch'
    and keyword_core_link_problem(kl.id('kChild'), kl.id('kCoreOP')) like '%names Overland Park;%');
  perform kl.ok('C25 a place the parent names in text matches the keyword''s text or its recorded city',
    keyword_core_link_problem(kl.id('kChild'), kl.id('kCoreTxt')) is null
    and keyword_core_link_problem(kl.id('kCityOnly'), kl.id('kCoreTxt')) is null
    and kl.code('kTopeka', 'kCoreTxt') = 'place_mismatch');
  perform kl.ok('C26 the options offer exactly the pairs the full rule accepts (their place test is the rule''s)',
    not exists (
      with o as materialized (select * from keyword_core_link_options(kl.id('S')) union all select * from keyword_core_link_options(kl.id('M')))
      select 1 from keywords k
        join core_keyword_lists l on l.client_id = k.client_id and l.status = 'approved'
        join keywords pk on pk.id = any(l.keyword_ids) and pk.service_id = k.service_id and pk.intent = k.intent
       where k.client_id in (kl.id('S'), kl.id('M')) and k.is_active and pk.id is distinct from k.core_parent_keyword_id
         and (keyword_core_link_problem(k.id, pk.id) is null) <> exists (
               select 1 from o where o.keyword_id = k.id and o.parent_id = pk.id and not o.is_current)));
  perform kl.ok('C23 the options list only eligible parents, pre-link',
    (select array_agg(parent_id order by parent_id) from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kChild') and not is_current)
      = (select array_agg(x order by x) from unnest(array[kl.id('kCore'), kl.id('kCore2'), kl.id('kCore3'), kl.id('kCoreTxt')]) x)
    and not exists (select 1 from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kCore'))
    and not exists (select 1 from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kTopeka') and parent_id = kl.id('kCore')));
end $$;

-- ── The column has no other writer ──────────────────────────────────────────
do $$ begin
  perform kl.ok('G1 the worker''s SQL (postgres) cannot set, change or clear a core parent directly',
    kl.msg(format('update keywords set core_parent_keyword_id = %L where id = %L', kl.id('kCore'), kl.id('kChild'))) like '42501: core_parent_link_required%'
    and kl.msg(format('update keywords set core_parent_keyword_id = null where id = %L', kl.id('kKid'))) like '42501: core_parent_link_required%'
    and kl.msg(format($q$insert into keywords (client_id, keyword, is_active, core_parent_keyword_id) values (%L, 'zqx sneaky', true, %L)$q$,
                      kl.id('S'), kl.id('kCore'))) like '42501: core_parent_link_required%');
  perform kl.ok('G2 other keyword edits are untouched by the guard',
    kl.msg(format($q$update keywords set target_url = 'https://s.kl.example.test/services/installation', core_parent_keyword_id = core_parent_keyword_id where id = %L$q$, kl.id('kKid'))) = 'accepted');
  perform kl.ok('G3 the worker (postgres, no team sign-in) cannot call the link either',
    kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'worker try')$q$, kl.id('kChild'), kl.id('kCore'))) like '42501: not_team%');
end $$;

-- ── Callers ─────────────────────────────────────────────────────────────────
set local role anon;
select set_config('kl.anon', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'anon try')$q$, kl.id('kChild'), kl.id('kCore'))), true);
reset role;
set local role service_role;
select set_config('kl.service', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'service try')$q$, kl.id('kChild'), kl.id('kCore'))), true);
reset role;
-- A signed-in non-team user (a stranger) through PostgREST.
set local session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '00000000-0000-4000-a000-000000000014')::text, true);
select set_config('kl.stranger', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'stranger try')$q$, kl.id('kChild'), kl.id('kCore'))), true);
select set_config('kl.stranger_un', kl.msg(format($q$select keyword_unlink_core_parent(%L, 'stranger try')$q$, kl.id('kKid'))), true);
-- The teammate.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '00000000-0000-4000-a000-000000000001')::text, true);
select set_config('kl.direct', kl.msg(format('update keywords set core_parent_keyword_id = %L where id = %L', kl.id('kCore'), kl.id('kChild'))), true);
select set_config('kl.noreason', kl.msg(format($q$select keyword_link_core_parent(%L, %L, '  ')$q$, kl.id('kChild'), kl.id('kCore'))), true);
select set_config('kl.bad.city', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'wrong city')$q$, kl.id('kTopeka'), kl.id('kCore'))), true);
select set_config('kl.bad.core', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'off list')$q$, kl.id('kChild'), kl.id('kOff'))), true);
select set_config('kl.bad.chain', kl.msg(format($q$select keyword_link_core_parent(%L, %L, 'chain')$q$, kl.id('kChild'), kl.id('kCoreChild'))), true);
select set_config('kl.options', (select count(*)::text from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kChild')), true);
select set_config('kl.link', keyword_link_core_parent(kl.id('kChild'), kl.id('kCore'), 'Same service, city, intent and page as the core keyword.')::text, true);
select set_config('kl.again', keyword_link_core_parent(kl.id('kChild'), kl.id('kCore'), 'again')::text, true);
select set_config('kl.topeka', keyword_link_core_parent(kl.id('kTopeka'), kl.id('kCore2'), 'Topeka long tail of the company keyword')::text, true);
select set_config('kl.relink', keyword_link_core_parent(kl.id('kTopeka'), kl.id('kCore3'), 'The service keyword fits better')::text, true);
select set_config('kl.unlink', keyword_unlink_core_parent(kl.id('kKid'), 'Pre-guard link, cleared')::text, true);
select set_config('kl.unlink_none', keyword_unlink_core_parent(kl.id('kKid'), 'Nothing to clear')::text, true);
select set_config('kl.ev_insert', kl.msg(format($q$insert into keyword_core_link_events (client_id, keyword_id, keyword, action, parent_id, parent_keyword, list_id, list_version, reason, actor_id)
  values (%L, %L, 'x', 'linked', %L, 'y', %L, 1, 'forged', (select id from team_members limit 1))$q$, kl.id('S'), kl.id('kChild'), kl.id('kCore'), kl.id('list.S'))), true);
select set_config('kl.ev_read', (select count(*)::text from keyword_core_link_events where client_id = kl.id('S')), true);
reset role;
reset session authorization;

do $$
declare r jsonb;
begin
  perform kl.ok('X1 anon and service_role cannot execute the link (granted to authenticated only)',
    current_setting('kl.anon') like '42501:%' and current_setting('kl.service') like '42501:%');
  perform kl.ok('X2 a signed-in user who is not on the team is refused (not_team), link and unlink',
    current_setting('kl.stranger') like '42501: not_team%' and current_setting('kl.stranger_un') like '42501: not_team%');
  perform kl.ok('X3 a teammate''s direct PATCH of the column is refused; the RPC is the door',
    current_setting('kl.direct') like '42501: core_parent_link_required%');
  perform kl.ok('X4 a reason is required', current_setting('kl.noreason') like '22023: reason_required%');
  perform kl.ok('X5 the RPC refuses with the rule''s own codes (city, list membership, chains)',
    current_setting('kl.bad.city') like '22023: city_mismatch%' and current_setting('kl.bad.core') like '22023: parent_not_core%'
    and current_setting('kl.bad.chain') like '22023: parent_has_parent%');
  perform kl.ok('X6 a teammate reads the options (four eligible parents for kChild)', current_setting('kl.options') = '4');

  r := current_setting('kl.link')::jsonb;
  perform kl.ok('L1 a teammate links kChild to kCore: changed, list v1',
    (r->>'changed')::boolean and r->>'action' = 'linked' and (r->>'list_version')::int = 1
    and (select core_parent_keyword_id from keywords where id = kl.id('kChild')) = kl.id('kCore'));
  perform kl.ok('L2 the audit row records who, what, to what, the list version and why',
    exists (select 1 from keyword_core_link_events e join team_members t on t.id = e.actor_id
             where e.keyword_id = kl.id('kChild') and e.action = 'linked' and e.parent_id = kl.id('kCore')
               and e.previous_parent_id is null and e.list_id = kl.id('list.S') and e.list_version = 1
               and e.keyword = 'zqx installers wichita ks' and e.parent_keyword = 'zqx installation wichita ks'
               and e.reason = 'Same service, city, intent and page as the core keyword.'
               and t.auth_user_id = '00000000-0000-4000-a000-000000000001'));
  perform kl.ok('L3 linking the same parent again changes nothing and records nothing',
    not (current_setting('kl.again')::jsonb->>'changed')::boolean
    and (select count(*) from keyword_core_link_events where keyword_id = kl.id('kChild')) = 1);
  r := current_setting('kl.relink')::jsonb;
  perform kl.ok('L4 changing a link goes through the same function and is audited as relinked, with the previous parent',
    r->>'action' = 'relinked' and (r->>'previous_parent_id')::uuid = kl.id('kCore2')
    and (select core_parent_keyword_id from keywords where id = kl.id('kTopeka')) = kl.id('kCore3')
    and exists (select 1 from keyword_core_link_events where keyword_id = kl.id('kTopeka') and action = 'relinked'
                  and previous_parent_id = kl.id('kCore2') and previous_parent_keyword = 'zqx installation company' and parent_id = kl.id('kCore3')));
  perform kl.ok('L5 clearing a link is audited as unlinked; clearing nothing records nothing',
    (current_setting('kl.unlink')::jsonb->>'action') = 'unlinked'
    and (select core_parent_keyword_id from keywords where id = kl.id('kKid')) is null
    and not (current_setting('kl.unlink_none')::jsonb->>'changed')::boolean
    and (select count(*) from keyword_core_link_events where keyword_id = kl.id('kKid')) = 1
    and exists (select 1 from keyword_core_link_events where keyword_id = kl.id('kKid') and action = 'unlinked'
                  and previous_parent_id = kl.id('kHasKids') and parent_id is null and list_id is null));
  perform kl.ok('L6 a teammate reads the history and cannot forge it',
    current_setting('kl.ev_read') = '4' and current_setting('kl.ev_insert') like '42501:%');
  perform kl.ok('L7 the history is append-only, for the database owner too',
    kl.msg(format($q$update keyword_core_link_events set reason = 'edited' where keyword_id = %L$q$, kl.id('kChild'))) like '42501:%'
    and kl.msg(format('delete from keyword_core_link_events where keyword_id = %L', kl.id('kChild'))) like '42501:%');

  -- The gate itself is unchanged and now passes for the child.
  perform kl.ok('E1 core_keyword_eligibility passes for the linked child (four-argument and blog purpose)',
    core_keyword_eligibility(kl.id('S'), null, kl.id('kChild'), kl.id('s1')) is null
    and core_keyword_eligibility(kl.id('S'), null, kl.id('kChild'), kl.id('s1'), 'blog') is null
    and (select core_keyword_id from core_keyword_grounding(kl.id('S'), kl.id('kChild'))) = kl.id('kCore'));
  perform kl.ok('E2 an unlinked long tail is still refused by the gate (core_keyword_required)',
    core_keyword_eligibility(kl.id('S'), null, kl.id('kOff'), kl.id('s1')) like 'core_keyword_required:%');
  perform kl.ok('E3 the options show the current link, sound', exists (
    select 1 from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kChild') and is_current
       and parent_id = kl.id('kCore') and problem is null and list_version = 1));
end $$;

-- A link judged sound when made can stop meeting the rule (the parent is
-- retired); the gate still reads the column, the options say what changed.
update keywords set is_active = false where id = kl.id('kCore3');
do $$ begin
  perform kl.ok('E4 an existing link whose parent was retired shows its problem in the options',
    (select split_part(problem, ':', 1) from keyword_core_link_options(kl.id('S')) where keyword_id = kl.id('kTopeka') and is_current) = 'parent_inactive');
  perform kl.ok('E5 grounding needs an active parent, so the retired parent no longer grounds the child (gate unchanged)',
    not exists (select 1 from core_keyword_grounding(kl.id('S'), kl.id('kTopeka'))));
end $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
do $$ begin
  perform kl.ok('P1 link / unlink / rule / options: authenticated only',
    has_function_privilege('authenticated', 'keyword_link_core_parent(uuid, uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'keyword_unlink_core_parent(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'keyword_link_core_parent(uuid, uuid, text)', 'execute')
    and not has_function_privilege('service_role', 'keyword_link_core_parent(uuid, uuid, text)', 'execute')
    and not has_function_privilege('anon', 'keyword_core_link_options(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'keyword_core_link_caller()', 'execute'));
  perform kl.ok('P2 the link functions are security definer with a pinned search_path',
    (select bool_and(p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'])
       from pg_proc p where p.proname in ('keyword_link_core_parent', 'keyword_unlink_core_parent', 'keyword_core_link_caller')));
  perform kl.ok('P3 anon cannot read the history',
    not has_table_privilege('anon', 'keyword_core_link_events', 'select'));
end $$;

-- ── Rollback ────────────────────────────────────────────────────────────────
\ir ../../rollback/20261120190000_keyword_core_parent_link.down.sql
do $$ begin
  perform kl.ok('R1 the down script removes the door, the rule, the guard and the history; links made stay and still ground',
    to_regprocedure('keyword_link_core_parent(uuid, uuid, text)') is null and to_regprocedure('keyword_core_link_problem(uuid, uuid, boolean)') is null
    and to_regprocedure('keyword_core_link_places(uuid, boolean)') is null
    and to_regclass('keyword_core_link_events') is null
    and not exists (select 1 from pg_trigger where tgname = 'keywords_core_parent_guard')
    and (select core_parent_keyword_id from keywords where id = kl.id('kChild')) = kl.id('kCore')
    and core_keyword_eligibility(kl.id('S'), null, kl.id('kChild'), kl.id('s1')) is null);
end $$;

rollback;
