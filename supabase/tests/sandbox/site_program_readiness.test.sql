-- 20261029200000: site_program_readiness (Gate B / Gate C), read-only.
-- Plain SQL, one transaction, rolled back: runs in scripts/test-portal-sandbox.sh
-- and in tests/site-program-readiness-database.test.mjs (PGlite). Fictional
-- clients and example.test hosts only; the place reference is the generated
-- seed (public place names).
--   A  single site, everything in place (+ a structured market keyword, and
--      "christmas lights", which must not read as Christmas, FL)
--   L  as A, no own-work photos                      → C limited
--   S  as A, one owner page checked 46 days ago      → B not_verified
--   G  IL interiors: "troy il" (no market), "edwardsville il" (office
--      market, no market_id)                         → B blocked
--   T  as G with only the office-market text keyword → B not_verified
--   K  MO training: "atlanta" (major city, no market), "houston" with
--      city Dallas (mismatch), "austin tx" (market excluded), "st. louis"
--      structured                                    → B blocked
--   H  a held offering in one keyword                → B blocked
--   P  a 49-keyword proposal                         → B blocked
--   N  no website, list, board, claims or assets     → blocked, nulls not 0
--   M  three brand sites: M1 ready list, M2 a keyword on M1's host, M3 a
--      49-keyword proposal; claims and photos are client-wide
--   B3 BHG-shaped scale: 3 × 50 core + 300 supporting terms (timing)
begin;
create schema spr;
grant usage on schema spr to anon, authenticated, service_role;
create function spr.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function spr.id(k text) returns uuid language sql immutable as $$ select md5('spr:' || k)::uuid $$;
create function spr.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create function spr.as_user(p_sub text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true), set_config('role', 'authenticated', true)
$$;
create function spr.as_owner() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true), set_config('role', 'postgres', true)
$$;
grant execute on all functions in schema spr to anon, authenticated, service_role;
create function spr.host(code text) returns text language sql immutable as $$ select 'https://' || lower(code) || '.spr.example.test' $$;

set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('5b700000-0000-4000-a000-000000000001', 'spr-member@compassmarketing.ai'),
  ('5b700000-0000-4000-a000-000000000002', 'spr-stranger@example.test');
insert into team_members (id, auth_user_id, name, email, role)
values (spr.id('team'), '5b700000-0000-4000-a000-000000000001', 'Spr Member', 'spr-member@compassmarketing.ai', 'member');

-- A single-site client: five approved services with live, approved service
-- pages, n keywords spread over them, a list, three confirmed claims and six
-- reviewed own-work photos.
create function spr.single(code text, st text, n int default 50, list_status text default 'approved', photos int default 6)
returns void language plpgsql as $$
begin
  insert into clients (id, name, status, website_url, state)
  values (spr.id(code), 'SPR Sample ' || code || ' (fictional)', 'active', spr.host(code), st);
  insert into brand_boards (client_id, status, approved_on) values (spr.id(code), 'approved', now());
  insert into services (id, client_id, name, status, page_url)
  select spr.id(code || ':s' || i), spr.id(code), 'Zqx service ' || i, 'approved', spr.host(code) || '/services/zqx-' || i
  from generate_series(1, 5) i;
  insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
  select spr.id(code), 'Zqx service ' || i, 'service', spr.host(code) || '/services/zqx-' || i, 'approved', '{}'
  from generate_series(1, 5) i;
  insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
  select spr.id(code), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now() - interval '1 day'
  from (select spr.host(code) || '/services/zqx-' || i u from generate_series(1, 5) i) x;
  insert into keywords (id, client_id, keyword, intent, service_id, is_active)
  select spr.id(code || ':k' || i), spr.id(code), 'zqx plumbo ' || i,
         (array['informational', 'commercial', 'transactional', 'navigational'])[1 + i % 4], spr.id(code || ':s' || (1 + i % 5)), true
  from generate_series(1, n) i;
  insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
  values (spr.id(code || ':l1'), spr.id(code), 1, list_status,
          array(select spr.id(code || ':k' || i) from generate_series(1, n) i order by i),
          'core50 v1 (fictional). Proposed, not approved',
          case when list_status = 'approved' then spr.id('team') end, case when list_status = 'approved' then now() - interval '2 days' end);
  insert into claims (client_id, claim, status, source, confirmed_by, confirmed_on)
  select spr.id(code), 'Zqx claim ' || i, 'confirmed', 'fixture', 'Owner', now() - interval '3 days' from generate_series(1, 3) i;
  insert into brand_assets (client_id, kind, label, storage_path, content_hash, content_hashed_at, width, height, subjects, focal_x, focal_y, depicts_own_work, creative_use, creative_reviewed_at)
  select spr.id(code), 'photo', 'Zqx photo ' || i, 'spr/' || code || '/' || i || '.jpg', md5(code || i) || md5(i || code), now(), 1200, 800, array['roof'], 0.5, 0.5, true, 'approved', now()
  from generate_series(1, photos) i;
end $$;
-- Rewrites keyword i of a client (text, and optionally city / market).
create function spr.kw(code text, i int, txt text, p_city text default null, p_market text default null) returns void language sql as $$
  update keywords set keyword = txt, city = p_city, market_id = case when p_market is not null then spr.id(p_market) end
   where id = spr.id(code || ':k' || i)
$$;
create function spr.market(k text, code text, city text, st text, status text default 'approved', basis text default 'office') returns void language sql as $$
  insert into client_service_markets (id, client_id, city, state, status, basis, source_ref, decided_on)
  values (spr.id(k), spr.id(code), city, st, status, basis, 'test fixture', current_date)
$$;

select spr.single('A', 'MO');
select spr.market('A:springfield', 'A', 'Springfield', 'MO');
select spr.kw('A', 1, 'zqx roofing springfield mo', null, 'A:springfield');
select spr.kw('A', 2, 'zqx christmas lights');
select spr.single('L', 'MO', photos => 0);
select spr.single('S', 'MO');
update owner_page_checks set checked_at = now() - interval '46 days'
 where client_id = spr.id('S') and url_norm = core_norm_url(spr.host('S') || '/services/zqx-2');
select spr.single('G', 'IL');
select spr.market('G:edw', 'G', 'Edwardsville', 'IL');
select spr.kw('G', 1, 'zqx interior designer troy il');
select spr.kw('G', 2, 'zqx interior designer edwardsville il');
select spr.single('T', 'IL');
select spr.market('T:edw', 'T', 'Edwardsville', 'IL');
select spr.kw('T', 2, 'zqx interior designer edwardsville il');
select spr.single('K', 'MO');
select spr.market('K:stl', 'K', 'St. Louis', 'MO');
select spr.market('K:dal', 'K', 'Dallas', 'TX', basis => 'recorded_decision');
select spr.market('K:aus', 'K', 'Austin', 'TX', 'excluded', 'recorded_decision');
select spr.kw('K', 1, 'zqx forklift training atlanta');
select spr.kw('K', 2, 'zqx forklift training houston', 'Dallas');
select spr.kw('K', 3, 'zqx forklift austin tx');
select spr.kw('K', 4, 'zqx forklift training st. louis', 'St. Louis');
select spr.single('H', 'MO');
select spr.kw('H', 3, 'zqx drain camera inspection');
insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
values (spr.id('H'), 'Camera inspections', array['camera inspection'], 'test fixture: the owner''s words', current_date);
select spr.single('P', 'MO', 49, 'proposed');
insert into clients (id, name, status, website_url) values (spr.id('N'), 'SPR Sample N (fictional)', 'active', null);

-- M: three brand sites (approved), five services each, client-wide claims and photos.
insert into clients (id, name, status, website_url, state) values (spr.id('M'), 'SPR Sample M Group (fictional)', 'active', spr.host('M'), 'MO');
insert into brand_boards (client_id, status) values (spr.id('M'), 'draft');
insert into sites (id, client_id, url) select spr.id('M:site' || b), spr.id('M'), spr.host('M' || b) from generate_series(1, 3) b;
insert into services (id, client_id, name, status, page_url)
select spr.id('M' || b || ':s' || i), spr.id('M'), 'Zqx M' || b || ' service ' || i, 'approved', spr.host('M' || b) || '/services/zqx-' || i
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at, blog_site_id)
select spr.id('M' || b), spr.id('M'), 'm' || b, 'SPR M' || b, spr.host('M' || b), '5555555555',
       array(select spr.id('M' || b || ':s' || i) from generate_series(1, 5) i), 'approved', spr.id('team'), now(), spr.id('M:site' || b)
from generate_series(1, 3) b;
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
select spr.id('M'), 'Zqx M' || b || ' service ' || i, 'service', spr.host('M' || b) || '/services/zqx-' || i, 'approved', '{}'
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
select spr.id('M'), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now() - interval '1 day'
from (select spr.host('M' || b) || '/services/zqx-' || i u from generate_series(1, 3) b, generate_series(1, 5) i) x;
insert into keywords (id, client_id, keyword, intent, service_id, is_active)
select spr.id('M' || b || ':k' || i), spr.id('M'), 'zqx m' || b || ' plumbo ' || i,
       (array['informational', 'commercial', 'transactional', 'navigational'])[1 + i % 4], spr.id('M' || b || ':s' || (1 + i % 5)), true
from generate_series(1, 3) b, generate_series(1, 50) i;
-- M2's keyword 7 claims a page on M1's host.
update keywords set target_url = spr.host('M1') || '/services/zqx-1' where id = spr.id('M2:k7');
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select spr.id('M' || b || ':l1'), spr.id('M'), spr.id('M' || b), 1, case when b = 3 then 'proposed' else 'approved' end,
       array(select spr.id('M' || b || ':k' || i) from generate_series(1, case when b = 3 then 49 else 50 end) i order by i),
       'test fixture', case when b < 3 then spr.id('team') end, case when b < 3 then now() - interval '2 days' end
from generate_series(1, 3) b;
insert into claims (client_id, claim, status, source, confirmed_by, confirmed_on)
select spr.id('M'), 'Zqx group claim ' || i, 'confirmed', 'fixture', 'Owner', now() from generate_series(1, 4) i;
insert into brand_assets (client_id, kind, label, storage_path, content_hash, content_hashed_at, width, height, subjects, focal_x, focal_y, depicts_own_work, creative_use, creative_reviewed_at)
select spr.id('M'), 'photo', 'Zqx group photo ' || i, 'spr/M/' || i || '.jpg', md5('M' || i) || md5(i || 'M'), now(), 1200, 800, array['roof'], 0.5, 0.5, true, 'approved', now()
from generate_series(1, 8) i;
insert into authority_runs (client_id, mode, requested_via, status, engine_version, finished_at, report, input_hash, judged_at)
values (spr.id('A'), 'full', 'team', 'completed', 'authority-v1.4', now() - interval '1 day', '{}', 'sha256:' || repeat('a', 64), now() - interval '1 day'),
       (spr.id('M'), 'full', 'team', 'completed', 'authority-v1.4', now() - interval '30 minutes', '{}', 'sha256:' || repeat('a', 64), now() - interval '30 minutes');
set local session_replication_role = origin;

create function spr.r(code text) returns jsonb language sql stable as $$ select site_program_readiness(spr.id(code)) $$;
create function spr.p(code text, name text default null) returns jsonb language sql stable as $$
  select e from jsonb_array_elements(site_program_readiness(spr.id(code))->'programs') e
   where name is null or e->>'name' = name limit 1 $$;
create function spr.codes(g jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(e->>'code' order by e->>'code'), '{}') from jsonb_array_elements(g->'reasons') e $$;
create function spr.reason(g jsonb, code text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(g->'reasons') e where e->>'code' = code limit 1 $$;
create function spr.warn(p jsonb, code text) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_array_elements(p->'warnings') e where e->>'code' = code) $$;

-- ── Without a place reference: nothing is green ──────────────────────────────
select spr.ok('U1 no place reference: geography unassessed, Gate B not verified, every keyword counted',
  (spr.r('A')->'geography'->>'assessed')::boolean = false
  and spr.p('A')->'gate_b'->>'status' = 'not_verified'
  and spr.codes(spr.p('A')->'gate_b') = array['geography_unassessed']
  and (spr.reason(spr.p('A')->'gate_b', 'geography_unassessed')->>'count')::int = 50
  and spr.p('A')->'gate_c'->>'status' = 'not_verified');

-- ── Load the place reference (the data step, as the owner) ───────────────────
\ir ../../seeds/place-names-v1.sql
select spr.ok('U2 the seed loads once and is idempotent',
  (select count(*) from place_name_sources) = 1 and (select count(*) from place_names) > 20000);
\ir ../../seeds/place-names-v1.sql
select spr.ok('U3 a second load is a no-op', (select count(*) from place_name_sources) = 1);

-- ── The place matcher ───────────────────────────────────────────────────────
select spr.ok('P1 a state-named small town is a place',
  (select array_agg(place || '/' || state || '/' || basis) from core_places_in('interior designer troy il', '{MO}', '{}')) = array['Troy/IL/state_named']);
select spr.ok('P2 a major city anywhere is a place; a small out-of-state town is not',
  (select array_agg(place || '/' || basis) from core_places_in('forklift training atlanta', '{MO}', '{}')) = array['Atlanta/major_city']
  and not exists (select 1 from core_places_in('christmas lights', '{MO}', '{}'))
  and not exists (select 1 from core_places_in('drain camera inspection', '{MO}', '{}')));
select spr.ok('P3 the longest span wins and st. is saint',
  (select array_agg(place) from core_places_in('roof repair lake st. louis', '{MO}', '{}')) = array['Lake Saint Louis']);
select spr.ok('P4 the client''s own name is never a place',
  not exists (select 1 from core_places_in('lucas roofing', '{MO,KS,TX}', '{lucas}'))
  and exists (select 1 from core_places_in('lucas roofing', '{TX}', '{}')));

-- ── Gate B / Gate C ─────────────────────────────────────────────────────────
select spr.ok('B1 single site, everything in place: B ready, C ready, figures exact',
  spr.p('A')->'gate_b'->>'status' = 'ready' and spr.p('A')->'gate_c'->>'status' = 'ready'
  and spr.p('A')->'list'->>'approved' = 'true' and (spr.p('A')->'list'->>'size')::int = 50
  and (spr.p('A')->'owners'->'post'->>'ok')::int = 50
  and (spr.p('A')->'owner_pages'->>'live')::int = 5 and (spr.p('A')->'owner_pages'->>'unchecked')::int = 0
  and (spr.p('A')->'geography'->>'structured')::int = 1 and (spr.p('A')->'geography'->>'none')::int = 49
  and (spr.p('A')->'claims'->>'site_usable')::int = 3 and (spr.p('A')->'proof'->>'site_own_work_approved')::int = 6
  and spr.p('A')->'authority'->>'predates_list_approval' = 'false');
select spr.ok('B2 approval comes from status / approved_at, never from source_ref text',
  spr.p('A')->'list'->>'status' = 'approved'
  and (select source_ref from core_keyword_lists where id = spr.id('A:l1')) like '%Proposed, not approved%');
select spr.ok('B3 an owner page last checked 46 days ago: B not verified, the page counted stale',
  spr.p('S')->'gate_b'->>'status' = 'not_verified'
  and spr.codes(spr.p('S')->'gate_b') = array['owner:page_not_verified']
  and (spr.reason(spr.p('S')->'gate_b', 'owner:page_not_verified')->>'count')::int = 10
  and (spr.p('S')->'owner_pages'->>'stale')::int = 1 and (spr.p('S')->'owner_pages'->>'live')::int = 4
  and spr.p('S')->'gate_c'->>'status' = 'not_verified'
  and spr.codes(spr.p('S')->'gate_c') = array['strategy_not_ready']);
select spr.ok('B4 a place only in the text: unrecorded → blocked, recorded but unstructured → not verified',
  spr.p('G')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('G')->'gate_b') = array['place_text_only', 'place_without_market']
  and (spr.p('G')->'owners'->'post'->>'ok')::int = 50
  and (select count(*) from jsonb_array_elements(spr.p('G')->'problems') e where e->>'geography' = 'without_market'
         and e->>'keyword' = 'zqx interior designer troy il') = 1
  and spr.p('T')->'gate_b'->>'status' = 'not_verified'
  and spr.codes(spr.p('T')->'gate_b') = array['place_text_only']);
select spr.ok('B5 major city with no market → blocked; city-vs-text mismatch and an excluded market are caught; structured St. Louis passes',
  spr.p('K')->'gate_b'->>'status' = 'blocked'
  and (spr.p('K')->'geography'->>'without_market')::int = 2
  and (spr.p('K')->'geography'->>'mismatch')::int = 1
  and (spr.p('K')->'geography'->>'structured')::int = 1
  and (select count(*) from jsonb_array_elements(spr.p('K')->'problems') e
        where e->>'keyword' = 'zqx forklift training st. louis') = 0);
select spr.ok('B6 a held offering in a keyword blocks Gate B through the resolver',
  spr.p('H')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('H')->'gate_b') = array['owner:promotion_held']
  and (spr.p('H')->'holds'->>'active')::int = 1
  and (spr.p('H')->'geography'->>'without_market')::int = 0);
select spr.ok('B7 a 49-keyword proposal is shown and never green',
  spr.p('P')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('P')->'gate_b') = array['list_not_approved', 'list_size']
  and (spr.p('P')->'list'->>'size')::int = 49
  and spr.p('P')->'gate_c'->>'status' = 'blocked');
select spr.ok('B8 missing rows: blocked with reasons, unknown figures null (never 0)',
  spr.p('N')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('N')->'gate_b') = array['list_missing', 'program_site_missing']
  and spr.p('N')->'list' = 'null'::jsonb and spr.p('N')->'intents' = 'null'::jsonb
  and spr.p('N')->'owners' = 'null'::jsonb and spr.p('N')->'owner_pages' = 'null'::jsonb
  and spr.p('N')->'gate_c'->>'status' = 'blocked'
  and spr.codes(spr.p('N')->'gate_c') = array['brand_not_approved', 'claims_missing', 'proof_own_work_missing', 'services_missing', 'strategy_not_ready']
  and spr.warn(spr.p('N'), 'authority_never_run'));
select spr.ok('C1 no own-work proof is limited, not blocked',
  spr.p('L')->'gate_b'->>'status' = 'ready' and spr.p('L')->'gate_c'->>'status' = 'limited'
  and spr.codes(spr.p('L')->'gate_c') = array['proof_own_work_missing']
  and (spr.p('L')->'proof'->>'site_own_work_approved')::int = 0);

-- ── Multi-brand isolation ───────────────────────────────────────────────────
select spr.ok('M1 three programs, each judged on its own list and host',
  jsonb_array_length(spr.r('M')->'programs') = 3
  and spr.p('M', 'SPR M1')->'gate_b'->>'status' = 'ready'
  and spr.p('M', 'SPR M2')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('M', 'SPR M2')->'gate_b') = array['owner:keyword_wrong_page']
  and (spr.reason(spr.p('M', 'SPR M2')->'gate_b', 'owner:keyword_wrong_page')->>'count')::int = 1
  and spr.p('M', 'SPR M3')->'gate_b'->>'status' = 'blocked'
  and spr.codes(spr.p('M', 'SPR M3')->'gate_b') = array['list_not_approved', 'list_size']);
select spr.ok('M2 client-wide claims and photos are never site evidence',
  spr.p('M', 'SPR M1')->'gate_c'->>'status' = 'not_verified'
  and spr.codes(spr.p('M', 'SPR M1')->'gate_c') = array['claims_client_scope', 'proof_client_scope']
  and spr.p('M', 'SPR M1')->'claims'->>'scope' = 'client' and spr.p('M', 'SPR M1')->'claims'->'site_usable' = 'null'::jsonb
  and (spr.p('M', 'SPR M1')->'claims'->>'usable')::int = 4
  and spr.p('M', 'SPR M1')->'proof'->'site_own_work_approved' = 'null'::jsonb
  and (spr.p('M', 'SPR M1')->'proof'->>'own_work_approved')::int = 8
  and spr.p('M', 'SPR M1')->'brand'->>'source' = 'brand_site');
create temp table spr_before as
  select e->>'name' n, e->'gate_b' b, e->'gate_c' c from jsonb_array_elements(spr.r('M')->'programs') e;
set local session_replication_role = replica;
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
values (spr.id('M3:l2'), spr.id('M'), spr.id('M3'), 2, 'approved',
        array(select spr.id('M3:k' || i) from generate_series(1, 50) i order by i), 'test fixture', spr.id('team'), now());
set local session_replication_role = origin;
select spr.ok('M3 approving one site''s list changes only that site',
  (select bool_and(b.b = e->'gate_b' and b.c = e->'gate_c') from jsonb_array_elements(spr.r('M')->'programs') e join spr_before b on b.n = e->>'name'
    where e->>'name' in ('SPR M1', 'SPR M2'))
  and spr.p('M', 'SPR M3')->'gate_b'->>'status' = 'ready'
  and (spr.p('M', 'SPR M3')->'list'->>'version')::int = 2
  and spr.warn(spr.p('M', 'SPR M3'), 'authority_predates_list'));

-- ── The purpose tail equals direct keyword_owner calls ──────────────────────
select spr.ok('E1 post / blog / refresh verdicts equal keyword_owner(…, purpose) for every list keyword',
  (select bool_and(
            coalesce((select jsonb_object_agg(x.code, x.n) from (
                        select d.code, count(*) n
                          from (select keyword_owner(c.id, l.brand_workspace_id, k, pp)->>'problem_code' code
                                  from unnest(l.keyword_ids) k
                                 where exists (select 1 from keywords kk where kk.id = k and kk.is_active)) d
                         where d.code is not null group by d.code) x), '{}')
          = (select e->'owners'->pp->'problems' from jsonb_array_elements(site_program_readiness(c.id)->'programs') e
              where (e->>'program_id')::uuid is not distinct from l.brand_workspace_id))
     from clients c
     join core_keyword_lists l on l.client_id = c.id
      and l.version = (select max(version) from core_keyword_lists x where x.client_id = c.id and x.brand_workspace_id is not distinct from l.brand_workspace_id)
     cross join unnest(array['post', 'blog', 'refresh']) pp
    where c.name like 'SPR Sample %'));

-- ── Access ──────────────────────────────────────────────────────────────────
select spr.ok('X1 anon cannot run it or read places; the team cannot write places',
  not has_function_privilege('anon', 'public.site_program_readiness(uuid)', 'execute')
  and not has_table_privilege('anon', 'public.place_names', 'select')
  and not has_table_privilege('authenticated', 'public.place_names', 'insert')
  and not has_table_privilege('authenticated', 'public.place_names', 'update')
  and not has_table_privilege('authenticated', 'public.place_name_sources', 'delete'));
select spr.as_user('5b700000-0000-4000-a000-000000000002');
select spr.ok('X2 a signed-in non-team user is refused (42501)', spr.err('select site_program_readiness(spr.id(''A''))') = '42501');
select spr.as_owner();
create temp table spr_owner as select spr.r('A') r;
grant select on spr_owner to authenticated;
select spr.as_user('5b700000-0000-4000-a000-000000000001');
-- Same figures and gates; the one difference is promotion_hold_conflicts(),
-- which a teammate cannot run: unknown (null + a warning), never 0.
select spr.ok('X3 a teammate gets the owner''s gates and figures; unreadable hold conflicts are null, not 0',
  (select (e - 'holds' - 'warnings') = (o - 'holds' - 'warnings')
          and e->'holds'->'open_conflicts_client' = 'null'::jsonb
          and (o->'holds'->>'open_conflicts_client')::int = 0
          and spr.warn(e, 'hold_conflicts_unreadable')
     from jsonb_array_elements(site_program_readiness(spr.id('A'))->'programs') e,
          jsonb_array_elements((select r->'programs' from spr_owner)) o));
select spr.as_owner();
select spr.ok('X4 stable and security invoker; no policy reads all rows to everyone',
  (select provolatile = 's' and not prosecdef from pg_proc where oid = 'public.site_program_readiness(uuid)'::regprocedure)
  and (select count(*) from pg_policies where schemaname = 'public' and tablename in ('place_names', 'place_name_sources')
         and qual like '%is_team()%' and with_check like '%is_team()%') = 2);

-- ── Writes nothing ──────────────────────────────────────────────────────────
create temp table spr_writes as
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) n from pg_stat_xact_user_tables where schemaname not like 'pg\_temp%';
select count(*) from (select site_program_readiness(id) from clients where name like 'SPR Sample %') x;
select spr.ok('W1 reports for every fixture change no row',
  (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_stat_xact_user_tables where schemaname not like 'pg\_temp%')
  = (select n from spr_writes));

-- ── Scale: BHG-shaped (3 × 50 core + 300 supporting terms) ──────────────────
reset role;
set local session_replication_role = replica;
insert into clients (id, name, status, website_url, state) values (spr.id('B3'), 'SPR Sample B3 Scale (fictional)', 'active', spr.host('B3'), 'MO');
insert into sites (id, client_id, url) select spr.id('B3:site' || b), spr.id('B3'), spr.host('B3' || b) from generate_series(1, 3) b;
insert into services (id, client_id, name, status, page_url)
select spr.id('B3' || b || ':s' || i), spr.id('B3'), 'Zqx B3' || b || ' service ' || i, 'approved', spr.host('B3' || b) || '/services/zqx-' || i
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at, blog_site_id)
select spr.id('B3' || b), spr.id('B3'), 'b3' || b, 'SPR B3' || b, spr.host('B3' || b), '5555555555',
       array(select spr.id('B3' || b || ':s' || i) from generate_series(1, 5) i), 'approved', spr.id('team'), now(), spr.id('B3:site' || b)
from generate_series(1, 3) b;
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
select spr.id('B3'), 'Zqx B3' || b || ' service ' || i, 'service', spr.host('B3' || b) || '/services/zqx-' || i, 'approved', '{}'
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
select spr.id('B3'), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now()
from (select spr.host('B3' || b) || '/services/zqx-' || i u from generate_series(1, 3) b, generate_series(1, 5) i) x;
insert into keywords (id, client_id, keyword, intent, service_id, is_active)
select spr.id('B3' || b || ':k' || i), spr.id('B3'), 'zqx b3' || b || ' plumbo ' || i, 'commercial', spr.id('B3' || b || ':s' || (1 + i % 5)), true
from generate_series(1, 3) b, generate_series(1, 50) i;
insert into keywords (client_id, keyword, intent, service_id, core_parent_keyword_id, is_active)
select spr.id('B3'), 'zqx b3' || b || ' plumbo ' || i || ' cost ' || j, 'commercial', spr.id('B3' || b || ':s' || (1 + i % 5)), spr.id('B3' || b || ':k' || i), true
from generate_series(1, 3) b, generate_series(1, 50) i, generate_series(1, 2) j;
insert into core_keyword_lists (client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select spr.id('B3'), spr.id('B3' || b), 1, 'approved', array(select spr.id('B3' || b || ':k' || i) from generate_series(1, 50) i order by i),
       'test fixture', spr.id('team'), now()
from generate_series(1, 3) b;
set local session_replication_role = origin;
create temp table spr_t as select clock_timestamp() t0, site_program_readiness(spr.id('B3')) r, clock_timestamp() t1;
select spr.ok('S1 BHG scale: three programs of 50, each owned and ready (B)',
  (select jsonb_array_length(r->'programs') from spr_t) = 3
  and (select bool_and(e->'gate_b'->>'status' = 'ready' and (e->'owners'->'post'->>'ok')::int = 50)
         from spr_t, jsonb_array_elements(r->'programs') e));
do $$ declare ms numeric := (select round(extract(epoch from t1 - t0) * 1000) from spr_t);
begin
  raise notice 'timing site_program_readiness BHG-shaped (150 core, 300 supporting): % ms', ms;
  if ms > 10000 then raise exception 'FAILED S2 BHG-shaped report took % ms (limit 10000)', ms; end if;
end $$;

-- ── Rollback and re-apply ───────────────────────────────────────────────────
\ir ../../rollback/20261029200000_site_program_readiness.down.sql
select spr.ok('R1 the down script removes every object',
  to_regprocedure('public.site_program_readiness(uuid)') is null and to_regclass('public.place_names') is null
  and to_regclass('public.place_name_sources') is null and to_regprocedure('public.core_place_norm(text)') is null
  and to_regprocedure('public.core_places_in(text,text[],text[])') is null);
\ir ../../migrations/20261029200000_site_program_readiness.sql
select spr.ok('R2 the migration re-applies cleanly; without the seed nothing is green',
  to_regprocedure('public.site_program_readiness(uuid)') is not null
  and spr.p('A')->'gate_b'->>'status' = 'not_verified');

rollback;
