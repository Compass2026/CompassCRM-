-- 20261030190000: authority_core_scope / authority_input_scoped, read-only.
-- Plain SQL, one transaction, rolled back: runs in scripts/test-portal-sandbox.sh
-- and in tests/authority-core-database.test.mjs (PGlite, which then feeds
-- authority_input_scoped() to the engine). Fictional clients and example.test
-- hosts only; the place reference is the generated seed (public place names).
--   A  single site (Lucas / Logic shaped): 60 active keywords; v2 approved
--      = k1..k50, v1 an older proposal, v3 a newer one. k3 retired, k51 a
--      supporting child of k1, k52 a child of off-list k58, k4 structured
--      market, k5 a place with no market, k6 a market named only in text,
--      k7 held, service 2's page checked 46 days ago, k8 a second market
--      (Overland Park-like) that must not credit the first
--   G  a 50-keyword proposal only (Ginger shaped)
--   N  no list at all
--   M  three brand sites with proposals of 49 / 46 / 28 (BHG shaped); M1
--      approved later in the suite. A phrase both sites want is one row
--      (M2's); M1's list names M2's keyword and a keyword whose page is on
--      M2's host
--   B3 BHG-shaped scale (BHG had 204 active keywords on Oct 30 2026): per
--      site 50 approved core + 10 children in scope + 8 off-list = 204
begin;
create schema acs;
grant usage on schema acs to anon, authenticated, service_role;
create function acs.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function acs.id(k text) returns uuid language sql immutable as $$ select md5('acs:' || k)::uuid $$;
create function acs.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create function acs.as_user(p_sub text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true), set_config('role', 'authenticated', true)
$$;
grant execute on all functions in schema acs to anon, authenticated, service_role;
create function acs.host(code text) returns text language sql immutable as $$ select 'https://' || lower(code) || '.acs.example.test' $$;

\ir ../../seeds/place-names-v1.sql

set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('acc00000-0000-4000-a000-000000000001', 'acs-member@compassmarketing.ai'),
  ('acc00000-0000-4000-a000-000000000002', 'acs-stranger@example.test');
insert into team_members (id, auth_user_id, name, email, role)
values (acs.id('team'), 'acc00000-0000-4000-a000-000000000001', 'Acs Member', 'acs-member@compassmarketing.ai', 'member');

-- A single-site client: five approved services with live, approved pages and
-- n active keywords over them (intents rotate).
create function acs.single(code text, st text, n int) returns void language plpgsql as $$
begin
  insert into clients (id, name, status, website_url, state)
  values (acs.id(code), 'ACS Sample ' || code || ' (fictional)', 'active', acs.host(code), st);
  insert into services (id, client_id, name, status, page_url)
  select acs.id(code || ':s' || i), acs.id(code), 'Zqx service ' || i, 'approved', acs.host(code) || '/services/zqx-' || i
  from generate_series(1, 5) i;
  insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
  select acs.id(code), 'Zqx service ' || i, 'service', acs.host(code) || '/services/zqx-' || i, 'approved', '{}'
  from generate_series(1, 5) i;
  insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
  select acs.id(code), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now() - interval '1 day'
  from (select acs.host(code) || '/services/zqx-' || i u from generate_series(1, 5) i) x;
  insert into keywords (id, client_id, keyword, intent, service_id, is_active)
  select acs.id(code || ':k' || i), acs.id(code), 'zqx plumbo ' || i,
         (array['informational', 'commercial', 'transactional', 'navigational'])[1 + i % 4], acs.id(code || ':s' || (1 + i % 5)), true
  from generate_series(1, n) i;
end $$;
create function acs.list(code text, v int, status text, ids uuid[], ws text default null) returns void language sql as $$
  insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
  values (acs.id(code || coalesce(ws, '') || ':l' || v), acs.id(code), case when ws is not null then acs.id(ws) end, v, status, ids,
          'core50 v' || v || ' (fictional). Proposed, not approved',
          case when status = 'approved' then acs.id('team') end, case when status = 'approved' then now() - interval '2 days' end)
$$;
create function acs.kws(code text, a int, b int) returns uuid[] language sql immutable as $$
  select array(select acs.id(code || ':k' || i) from generate_series(a, b) i order by i) $$;
create function acs.market(k text, code text, city text, st text, status text default 'approved', basis text default 'office') returns void language sql as $$
  insert into client_service_markets (id, client_id, city, state, status, basis, source_ref, decided_on)
  values (acs.id(k), acs.id(code), city, st, status, basis, 'test fixture', current_date)
$$;

-- A
select acs.single('A', 'MO', 60);
select acs.list('A', 1, 'superseded', acs.kws('A', 11, 60));
select acs.list('A', 2, 'approved', acs.kws('A', 1, 50));
select acs.list('A', 3, 'proposed', acs.kws('A', 2, 51));
update core_keyword_lists set status = 'proposed', approved_by = null, approved_at = null where id = acs.id('A:l1');
update keywords set is_active = false where id = acs.id('A:k3');
update keywords set core_parent_keyword_id = acs.id('A:k1'), service_id = acs.id('A:s2'), keyword = 'zqx plumbo one emergency' where id = acs.id('A:k51');
update keywords set core_parent_keyword_id = acs.id('A:k58') where id = acs.id('A:k52');
select acs.market('A:springfield', 'A', 'Springfield', 'MO');
select acs.market('A:joplin', 'A', 'Joplin', 'MO', basis => 'recorded_decision');
select acs.market('A:austin', 'A', 'Austin', 'TX', 'excluded', 'recorded_decision');
update keywords set keyword = 'zqx roofing springfield mo', market_id = acs.id('A:springfield') where id = acs.id('A:k4');
update keywords set keyword = 'zqx roofing troy mo' where id = acs.id('A:k5');
update keywords set keyword = 'zqx roofing springfield mo service' where id = acs.id('A:k6');
update keywords set keyword = 'zqx drain camera inspection' where id = acs.id('A:k7');
-- k8 names Joplin but is linked to Springfield: one market never credits another.
update keywords set keyword = 'zqx roofing joplin mo', market_id = acs.id('A:springfield') where id = acs.id('A:k8');
update keywords set keyword = 'zqx roofing austin tx' where id = acs.id('A:k9');
insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
values (acs.id('A'), 'Camera inspections', array['camera inspection'], 'test fixture: the owner''s words', current_date);
update owner_page_checks set checked_at = now() - interval '46 days'
 where client_id = acs.id('A') and url_norm = core_norm_url(acs.host('A') || '/services/zqx-2');

-- G, N
select acs.single('G', 'IL', 63);
select acs.list('G', 1, 'proposed', acs.kws('G', 1, 50));
select acs.single('N', 'MO', 12);

-- M: three brand sites, five services each, 60 keywords each.
insert into clients (id, name, status, website_url, state) values (acs.id('M'), 'ACS Sample M Group (fictional)', 'active', acs.host('M'), 'MO');
insert into services (id, client_id, name, status, page_url)
select acs.id('M' || b || ':s' || i), acs.id('M'), 'Zqx M' || b || ' service ' || i, 'approved', acs.host('M' || b) || '/services/zqx-' || i
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at)
select acs.id('M' || b), acs.id('M'), 'm' || b, 'ACS M' || b, acs.host('M' || b), '5555555555',
       array(select acs.id('M' || b || ':s' || i) from generate_series(1, 5) i), 'approved', acs.id('team'), now()
from generate_series(1, 3) b;
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
select acs.id('M'), 'Zqx M' || b || ' service ' || i, 'service', acs.host('M' || b) || '/services/zqx-' || i, 'approved', '{}'
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
select acs.id('M'), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now() - interval '1 day'
from (select acs.host('M' || b) || '/services/zqx-' || i u from generate_series(1, 3) b, generate_series(1, 5) i) x;
insert into keywords (id, client_id, keyword, intent, service_id, is_active)
select acs.id('M' || b || ':k' || i), acs.id('M'), 'zqx m' || b || ' plumbo ' || i,
       (array['informational', 'commercial', 'transactional', 'navigational'])[1 + i % 4], acs.id('M' || b || ':s' || (1 + i % 5)), true
from generate_series(1, 3) b, generate_series(1, 60) i;
-- Keyword text is unique per client, so a phrase both sites want is one row
-- that belongs to one site (M2's, by its service).
update keywords set keyword = 'zqx forklift training' where id = acs.id('M2:k10');
-- M1:k12 has no service and claims a page on M2's host (wrong host).
update keywords set service_id = null, target_url = acs.host('M2') || '/services/zqx-1' where id = acs.id('M1:k12');
select acs.list('M', 1, 'proposed', acs.kws('M1', 1, 49), 'M1');
select acs.list('M', 1, 'proposed', acs.kws('M2', 1, 46), 'M2');
select acs.list('M', 1, 'proposed', acs.kws('M3', 1, 28), 'M3');
-- M1's v2 proposal adds M2's keyword 11 (a cross-site row).
select acs.list('M', 2, 'proposed', acs.kws('M1', 1, 49) || acs.id('M2:k11'), 'M1');
insert into authority_runs (id, client_id, mode, requested_via, status, engine_version, finished_at, report, input_hash, judged_at, section_hashes)
values (acs.id('A:run'), acs.id('A'), 'full', 'team', 'completed', 'authority-v1.4', now() - interval '1 day',
        '{"opportunities": []}', 'sha256:' || repeat('a', 64), now() - interval '1 day', '{}');
set local session_replication_role = origin;

create function acs.s(code text) returns jsonb language sql stable as $$ select authority_core_scope(acs.id(code)) $$;
create function acs.prog(code text, ws text default null) returns jsonb language sql stable as $$
  select e from jsonb_array_elements(acs.s(code)->'programs') e
   where (ws is null and e->'program_id' = 'null'::jsonb) or e->>'program_id' = acs.id(ws)::text limit 1 $$;
create function acs.k(code text, key text) returns jsonb language sql stable as $$
  select e from jsonb_array_elements(acs.s(code)->'keywords') e where e->>'keyword_id' = acs.id(key)::text $$;
create function acs.ids(code text) returns uuid[] language sql stable as $$
  select coalesce(array_agg((e->>'keyword_id')::uuid order by e->>'keyword_id'), '{}') from jsonb_array_elements(acs.s(code)->'keywords') e $$;

-- Every check below runs as a signed-in teammate.
select acs.as_user('acc00000-0000-4000-a000-000000000001');

-- ── Single site: the approved list and nothing else ────────────────────────
select acs.ok('S1 A: v2 is the list (sorted, 50 ids); v3 is the newer proposal; v1 never shows',
  acs.prog('A')->>'status' = 'approved'
  and (acs.prog('A')->'list'->>'version')::int = 2 and acs.prog('A')->'list'->>'id' = acs.id('A:l2')::text
  and (select array_agg(x::uuid) from jsonb_array_elements_text(acs.prog('A')->'list'->'keyword_ids') x)
      = (select array_agg(x order by x) from unnest(acs.kws('A', 1, 50)) x)
  and (acs.prog('A')->'proposal'->>'version')::int = 3 and (acs.prog('A')->'proposal'->>'count')::int = 50);
select acs.ok('S2 A: scope = the 49 active list members + 1 supporting child; off-list 10 (of 59 active)',
  jsonb_array_length(acs.s('A')->'keywords') = 50
  and (select count(*) from jsonb_array_elements(acs.s('A')->'keywords') e where e->>'relation' = 'core') = 49
  and acs.k('A', 'A:k3') is null
  and acs.k('A', 'A:k51')->>'relation' = 'child' and acs.k('A', 'A:k51')->>'core_keyword_id' = acs.id('A:k1')::text
  and acs.k('A', 'A:k52') is null and acs.k('A', 'A:k55') is null and acs.k('A', 'A:k58') is null
  and (acs.s('A')->>'active_keywords')::int = 59 and (acs.s('A')->>'off_list')::int = 9 + 0
  and (select bool_and(e->>'list_id' = acs.id('A:l2')::text and (e->>'list_version')::int = 2) from jsonb_array_elements(acs.s('A')->'keywords') e));
select acs.ok('S3 A: the scope is exactly core_keyword_grounding() over the approved list',
  acs.ids('A') = (select array_agg(k.id order by k.id) from keywords k cross join lateral core_keyword_grounding(k.client_id, k.id) g
                   where k.client_id = acs.id('A') and k.is_active));
select acs.ok('S4 A: every post / blog verdict is core_keyword_eligibility() for that purpose',
  (select bool_and((e->'purposes'->>'post' is null) = (core_keyword_eligibility(acs.id('A'), null, (e->>'keyword_id')::uuid, (e->>'service_id')::uuid, 'post') is null)
               and (e->'purposes'->>'blog' is null) = (core_keyword_eligibility(acs.id('A'), null, (e->>'keyword_id')::uuid, (e->>'service_id')::uuid, 'blog') is null)
               and (e->'purposes'->>'refresh' is null) = (core_keyword_eligibility(acs.id('A'), null, (e->>'keyword_id')::uuid, (e->>'service_id')::uuid, 'refresh') is null)
               and coalesce(split_part(core_keyword_eligibility(acs.id('A'), null, (e->>'keyword_id')::uuid, (e->>'service_id')::uuid, 'post'), ':', 1), '')
                   in ('', e->'purposes'->>'post', 'keyword_not_eligible'))
     from jsonb_array_elements(acs.s('A')->'keywords') e));
select acs.ok('S5 A: hold, stale page, markets: held, not verified, structured / mismatch',
  acs.k('A', 'A:k7')->'purposes'->>'post' = 'promotion_held'
  and acs.k('A', 'A:k1')->'purposes'->>'post' = 'page_not_verified'   -- k1's service is s2 (46 days)
  and acs.k('A', 'A:k4')->>'geography' = 'structured' and acs.k('A', 'A:k4')->'purposes'->>'post' is null
  and acs.k('A', 'A:k8')->>'geography' = 'mismatch');
select acs.ok('S6 A: a place with no market, a market only in text, an excluded market',
  acs.k('A', 'A:k5')->>'geography' = 'without_market'
  and acs.k('A', 'A:k6')->>'geography' = 'text_only'
  and acs.k('A', 'A:k9')->>'geography' = 'without_market'
  and acs.k('A', 'A:k10')->>'geography' = 'none');

-- ── Proposal only, nothing at all ──────────────────────────────────────────
select acs.ok('G1 proposed only: no list, the proposal shown, nothing in scope (never all 63)',
  acs.prog('G')->>'status' = 'proposed_only' and acs.prog('G')->'list' = 'null'::jsonb
  and (acs.prog('G')->'proposal'->>'count')::int = 50 and jsonb_array_length(acs.s('G')->'keywords') = 0
  and (acs.s('G')->>'off_list')::int = 63);
select acs.ok('N1 no list: missing, nothing in scope',
  acs.prog('N')->>'status' = 'missing' and acs.prog('N')->'proposal' = 'null'::jsonb and jsonb_array_length(acs.s('N')->'keywords') = 0);

-- ── Three brand sites ──────────────────────────────────────────────────────
select acs.ok('M1 three programs, 49 / 46 / 28 proposals (newest per site), none in scope',
  jsonb_array_length(acs.s('M')->'programs') = 3 and (acs.s('M')->>'multi')::boolean
  and (acs.prog('M', 'M1')->'proposal'->>'version')::int = 2 and (acs.prog('M', 'M1')->'proposal'->>'count')::int = 50
  and (acs.prog('M', 'M2')->'proposal'->>'count')::int = 46 and (acs.prog('M', 'M3')->'proposal'->>'count')::int = 28
  and (select bool_and(e->>'status' = 'proposed_only') from jsonb_array_elements(acs.s('M')->'programs') e)
  and jsonb_array_length(acs.s('M')->'keywords') = 0
  and (select array_agg(x::uuid order by x) from jsonb_array_elements_text(acs.prog('M', 'M2')->'service_ids') x)
      = (select array_agg(s order by s) from unnest(array(select acs.id('M2:s' || i) from generate_series(1, 5) i)) s));
reset role;
set local session_replication_role = replica;
update core_keyword_lists set status = 'approved', approved_by = acs.id('team'), approved_at = now()
 where id = acs.id('MM1:l2');
set local session_replication_role = origin;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select acs.ok('M2 M1 approved: only M1''s own keywords; M2''s row in M1''s list and M1''s wrong-host keyword are not',
  acs.prog('M', 'M1')->>'status' = 'approved' and acs.prog('M', 'M1')->'proposal' = 'null'::jsonb
  and acs.prog('M', 'M2')->>'status' = 'proposed_only' and acs.prog('M', 'M3')->>'status' = 'proposed_only'
  and (select bool_and(e->>'program_id' = acs.id('M1')::text) from jsonb_array_elements(acs.s('M')->'keywords') e)
  and jsonb_array_length(acs.s('M')->'keywords') = 48
  and acs.k('M', 'M2:k11') is null and acs.k('M', 'M1:k12') is null
  and acs.k('M', 'M1:k10') is not null and acs.k('M', 'M2:k10') is null);
select acs.ok('M3 M2''s "zqx forklift training" is refused for M1 by the resolver (wrong site) and is not M1''s to use',
  keyword_owner(acs.id('M'), acs.id('M1'), acs.id('M2:k10'), 'post')->>'problem_code' = 'keyword_wrong_site'
  and core_keyword_eligibility(acs.id('M'), acs.id('M1'), acs.id('M2:k10'), null, 'post') like 'core_keyword_required:%'
  and core_keyword_eligibility(acs.id('M'), acs.id('M1'), acs.id('M1:k10'), null, 'post') is null
  and acs.k('M', 'M1:k10')->'purposes'->>'post' is null);

-- ── The scoped input ───────────────────────────────────────────────────────
select acs.ok('I1 authority_input_scoped = authority_input + authority.core; authority_input unchanged',
  authority_input_scoped(acs.id('A')) #- '{authority,core}' = authority_input(acs.id('A'))
  and authority_input_scoped(acs.id('A'))->'authority'->'core' = acs.s('A')
  and not (authority_input(acs.id('A'))->'authority' ? 'core')
  and md5(pg_get_functiondef('public.authority_input(uuid)'::regprocedure)) = '22629a4e4cd3dbb1b8447c67bbb18a20');
select acs.ok('I2 an unknown client: null, not an empty scope', authority_core_scope(acs.id('nobody')) is null);

-- ── Fingerprint and staleness ──────────────────────────────────────────────
create temp table acs_fp as select authority_fingerprint(acs.id('A')) fp;
select acs.ok('F1 the fingerprint has a core section; the latest run predating it reads stale on core',
  (select fp ? 'core' from acs_fp)
  and (select 'core' = any(stale_sections) from authority_latest where client_id = acs.id('A')));
reset role;
set local session_replication_role = replica;
update core_keyword_lists set status = 'superseded', approved_by = null, approved_at = null where id = acs.id('A:l2');
update core_keyword_lists set status = 'approved', approved_by = acs.id('team'), approved_at = now() where id = acs.id('A:l3');
set local session_replication_role = origin;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select acs.ok('F2 approving the newer proposal changes the core section only, and the scope follows it',
  (select (fp->>'core') <> (authority_fingerprint(acs.id('A'))->>'core') from acs_fp)
  and (select fp - 'core' = authority_fingerprint(acs.id('A')) - 'core' from acs_fp)
  and (acs.prog('A')->'list'->>'version')::int = 3 and acs.prog('A')->'proposal' = 'null'::jsonb
  and acs.k('A', 'A:k1') is null and acs.k('A', 'A:k51')->>'relation' = 'core');
reset role;
set local session_replication_role = replica;
update core_keyword_lists set status = 'proposed', approved_by = null, approved_at = null where id = acs.id('A:l3');
update core_keyword_lists set status = 'approved', approved_by = acs.id('team'), approved_at = now() - interval '2 days' where id = acs.id('A:l2');
set local session_replication_role = origin;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select acs.ok('F3 back to v2: the same scope and fingerprint as before (idempotent)',
  (select fp->>'core' = authority_fingerprint(acs.id('A'))->>'core' from acs_fp)
  and (acs.prog('A')->'list'->>'version')::int = 2 and jsonb_array_length(acs.s('A')->'keywords') = 50);

-- ── Exemption ──────────────────────────────────────────────────────────────
reset role;
set local session_replication_role = replica;
insert into core_keyword_exemptions (client_id, reason, granted_by, granted_at) values (acs.id('N'), 'test fixture', acs.id('team'), now());
set local session_replication_role = origin;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select acs.ok('E1 an exemption is reported, never a silent scope', (acs.s('N')->>'exempt')::boolean
  and jsonb_array_length(acs.s('N')->'keywords') = 0 and acs.prog('N')->>'status' = 'missing');

-- ── Access ─────────────────────────────────────────────────────────────────
reset role;
select acs.ok('X1 anon cannot execute either function',
  not has_function_privilege('anon', 'public.authority_core_scope(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.authority_input_scoped(uuid)', 'execute'));
select acs.as_user('acc00000-0000-4000-a000-000000000002');
select acs.ok('X2 a signed-in non-team user is refused (42501)',
  acs.err(format('select authority_core_scope(%L)', acs.id('A'))) = '42501'
  and acs.err(format('select authority_input_scoped(%L)', acs.id('A'))) = '42501');
reset role;

-- ── Nothing written ────────────────────────────────────────────────────────
create temp table acs_before as
select (select md5(coalesce(jsonb_agg(to_jsonb(k) order by k.id), '[]')::text) from keywords k) kw,
       (select md5(coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]')::text) from core_keyword_lists l) lists,
       (select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]')::text) from authority_runs r) runs,
       (select count(*) from authority_opportunities) opps, (select count(*) from social_posts) posts,
       (select count(*) from content_drafts) drafts, (select count(*) from content_plan_items) slots, (select count(*) from tasks) tasks;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select count(*) from (select authority_input_scoped(id) from clients where id in (acs.id('A'), acs.id('G'), acs.id('N'), acs.id('M'))) x;
reset role;
select acs.ok('W1 reading every scope wrote nothing (keywords, lists, runs, opportunities, posts, drafts, slots, tasks)',
  (select kw = (select md5(coalesce(jsonb_agg(to_jsonb(k) order by k.id), '[]')::text) from keywords k)
      and lists = (select md5(coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]')::text) from core_keyword_lists l)
      and runs = (select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]')::text) from authority_runs r)
      and opps = (select count(*) from authority_opportunities) and posts = (select count(*) from social_posts)
      and drafts = (select count(*) from content_drafts) and slots = (select count(*) from content_plan_items)
      and tasks = (select count(*) from tasks)
   from acs_before));

-- ── Scale: BHG shaped, 204 active keywords: 3 × (50 core + 10 children + 8 off-list)
-- keyword_owner() compares each keyword with the client's whole inventory
-- (equivalent rows), so the cost is in-scope × inventory; on production BHG
-- (204 keywords) the resolver took 619 ms for all 204 (read-only timing).
set local session_replication_role = replica;
insert into clients (id, name, status, website_url, state) values (acs.id('B3'), 'ACS Sample B3 Group (fictional)', 'active', acs.host('B3'), 'MO');
insert into services (id, client_id, name, status, page_url)
select acs.id('B3' || b || ':s' || i), acs.id('B3'), 'Zqx B3' || b || ' service ' || i, 'approved', acs.host('B3' || b) || '/services/zqx-' || i
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at)
select acs.id('B3' || b), acs.id('B3'), 'b' || b, 'ACS B3' || b, acs.host('B3' || b), '5555555555',
       array(select acs.id('B3' || b || ':s' || i) from generate_series(1, 5) i), 'approved', acs.id('team'), now()
from generate_series(1, 3) b;
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
select acs.id('B3'), 'Zqx B3' || b || ' service ' || i, 'service', acs.host('B3' || b) || '/services/zqx-' || i, 'approved', '{}'
from generate_series(1, 3) b, generate_series(1, 5) i;
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref, checked_at)
select acs.id('B3'), u, core_norm_url(u), u, 200, 'live', 'http', 'test fixture', now() - interval '1 day'
from (select acs.host('B3' || b) || '/services/zqx-' || i u from generate_series(1, 3) b, generate_series(1, 5) i) x;
insert into keywords (id, client_id, keyword, intent, service_id, is_active)
select acs.id('B3' || b || ':k' || i), acs.id('B3'), 'zqx b' || b || ' training ' || i,
       (array['informational', 'commercial', 'transactional'])[1 + i % 3], acs.id('B3' || b || ':s' || (1 + i % 5)), true
from generate_series(1, 3) b, generate_series(1, 50) i;
insert into keywords (id, client_id, keyword, intent, service_id, is_active, core_parent_keyword_id)
select acs.id('B3' || b || ':c' || i), acs.id('B3'), 'zqx b' || b || ' training ' || (1 + i % 50) || ' course ' || i,
       'informational', acs.id('B3' || b || ':s' || (1 + (1 + i % 50) % 5)), true, acs.id('B3' || b || ':k' || (1 + i % 50))
from generate_series(1, 3) b, generate_series(1, 10) i;
insert into keywords (id, client_id, keyword, intent, service_id, is_active)
select acs.id('B3' || b || ':o' || i), acs.id('B3'), 'zqx b' || b || ' other ' || i, 'commercial', acs.id('B3' || b || ':s1'), true
from generate_series(1, 3) b, generate_series(1, 8) i;
select acs.list('B3', 1, 'approved', acs.kws('B3' || b, 1, 50), 'B3' || b) from generate_series(1, 3) b;
set local session_replication_role = origin;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
create temp table acs_t as select clock_timestamp() t0;
create temp table acs_s3 as select authority_core_scope(acs.id('B3')) s;
select acs.ok(format('T1 BHG-shaped scope (204 active: 150 core + 30 children in scope, 24 off-list) in %s ms (limit 10000)',
                     round(extract(epoch from clock_timestamp() - (select t0 from acs_t)) * 1000)),
  extract(epoch from clock_timestamp() - (select t0 from acs_t)) < 10
  and (select jsonb_array_length(s->'keywords') from acs_s3) = 180
  and (select count(*) from acs_s3, jsonb_array_elements(s->'keywords') e where e->>'relation' = 'child') = 30
  and (select (s->>'off_list')::int from acs_s3) = 24
  and (select (s->>'active_keywords')::int from acs_s3) = 204
  and (select count(distinct e->>'program_id') from acs_s3, jsonb_array_elements(s->'keywords') e) = 3);
reset role;

-- ── Rollback and re-apply: run history untouched ───────────────────────────
create temp table acs_hist as
select md5(coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from authority_runs r), '[]')::text) runs,
       md5(coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from authority_opportunities o), '[]')::text) opps;
\ir ../../rollback/20261030190000_authority_core_scope.down.sql
select acs.ok('R1 the down script restores the 0048 fingerprint and drops the two functions; history untouched',
  md5(pg_get_functiondef('public.authority_fingerprint(uuid)'::regprocedure)) = '308d62000db95bcab28f778c82447b9e'
  and to_regprocedure('public.authority_core_scope(uuid)') is null and to_regprocedure('public.authority_input_scoped(uuid)') is null
  and (select runs = md5(coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from authority_runs r), '[]')::text)
          and opps = md5(coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from authority_opportunities o), '[]')::text) from acs_hist));
\ir ../../migrations/20261030190000_authority_core_scope.sql
create temp table acs_r2 as select (select runs = md5(coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from authority_runs r), '[]')::text) from acs_hist) same;
grant select on acs_r2 to authenticated;
select acs.as_user('acc00000-0000-4000-a000-000000000001');
select acs.ok('R2 re-applied: the same scope; history untouched',
  jsonb_array_length(acs.s('A')->'keywords') = 50 and (acs.prog('A')->'list'->>'version')::int = 2
  and (select same from acs_r2));
reset role;

rollback;
