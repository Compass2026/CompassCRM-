-- 20261028170000: keyword owner page vs related service. Fictional clients
-- only; everything is rolled back. Rows and resolver cases come from
-- tests/fixtures/keyword-owner-cases.json (passed in as :owner_cases), the
-- same file the TypeScript resolver is tested against.
begin;
do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'sandbox_core_exempt_new_client') then
    execute 'alter table clients disable trigger sandbox_core_exempt_new_client';
  end if;
end $$;
create schema ko_test;
create function ko_test.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ko_test.msg(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ko_test.id(k text) returns uuid language sql immutable as $$ select md5(k)::uuid $$;
grant usage on schema ko_test to anon, authenticated, service_role;
grant execute on all functions in schema ko_test to anon, authenticated, service_role;
create table ko_test.fx as select :'owner_cases'::jsonb as j;

-- ── Load the fixture (setup only: triggers off, as a load script would) ────
set local session_replication_role = replica;
insert into clients (id, name, status, website_url)
select ko_test.id(x->>'key'), x->>'name', 'active', x->>'website_url' from ko_test.fx, jsonb_array_elements(j->'clients') x;
insert into brand_boards (client_id, status, approved_on)
select ko_test.id(x->>'key'), 'approved', now() from ko_test.fx, jsonb_array_elements(j->'clients') x;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), lower(replace(x->>'key', '.', '-')), x->>'name', x->>'website_url', '5555555555',
       array(select ko_test.id(s) from jsonb_array_elements_text(x->'services') s), 'draft'
from ko_test.fx, jsonb_array_elements(j->'workspaces') x;
insert into services (id, client_id, name, status, page_url, primary_keyword_id)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), x->>'name', (x->>'status')::taxonomy_status, x->>'page_url',
       case when x->>'primary' is not null then ko_test.id(x->>'primary') end
from ko_test.fx, jsonb_array_elements(j->'services') x;
insert into client_service_markets (id, client_id, brand_workspace_id, city, state, status, basis, source_ref, decided_on)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), case when x->>'workspace' is not null then ko_test.id(x->>'workspace') end,
       x->>'city', x->>'state', x->>'status', x->>'basis', 'test fixture', current_date
from ko_test.fx, jsonb_array_elements(j->'markets') x;
insert into keywords (id, client_id, keyword, intent, service_id, target_url, city, market_id, core_parent_keyword_id, is_active)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), x->>'keyword', x->>'intent',
       case when x->>'service' is not null then ko_test.id(x->>'service') end, x->>'target_url', x->>'city',
       case when x->>'market' is not null then ko_test.id(x->>'market') end,
       case when x->>'parent' is not null then ko_test.id(x->>'parent') end, coalesce((x->>'is_active')::boolean, true)
from ko_test.fx, jsonb_array_elements(j->'keywords') x;
insert into page_groups (id, client_id, name, page_type, target_url, primary_keyword_id, status, supporting_keyword_ids)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), x->>'key', (x->>'page_type')::page_group_type, x->>'target_url',
       case when x->>'primary' is not null then ko_test.id(x->>'primary') end, coalesce(x->>'status', 'approved')::taxonomy_status, '{}'
from ko_test.fx, jsonb_array_elements(j->'page_groups') x;
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref)
select ko_test.id(x->>'client'), x->>'url', core_norm_url(x->>'url'), x->>'url', case x->>'verdict' when 'missing' then 404 else 200 end,
       x->>'verdict', coalesce(x->>'method', 'http'), 'test fixture'
from ko_test.fx, jsonb_array_elements(j->'page_checks') x;
insert into content_posts (id, client_id, title, status, url)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), 'Fixture article', 'published', x->>'url'
from ko_test.fx, jsonb_array_elements(j->'published_posts') x;
insert into client_promotion_holds (id, client_id, offering, phrases, service_ids, source_ref, decided_on)
select ko_test.id(x->>'key'), ko_test.id(x->>'client'), x->>'offering',
       array(select core_norm_words(p) from jsonb_array_elements_text(x->'phrases') p),
       array(select ko_test.id(s) from jsonb_array_elements_text(x->'services') s), 'test fixture', current_date
from ko_test.fx, jsonb_array_elements(j->'holds') x;
set local session_replication_role = origin;

-- ── 1. Every shared case ────────────────────────────────────────────────────
do $$
declare c jsonb; o jsonb; bad text := ''; n int := 0;
begin
  for c in select x from ko_test.fx, jsonb_array_elements(j->'cases') x loop
    o := keyword_owner(
      (select ko_test.id(k->>'client') from ko_test.fx, jsonb_array_elements(j->'keywords') k where k->>'key' = c->>'keyword'),
      case when c->>'program' is not null then ko_test.id(c->>'program') end,
      ko_test.id(c->>'keyword'), c->>'purpose');
    n := n + 1;
    if (o->>'problem_code') is distinct from (c->'expect'->>'code')
       or (c->'expect' ? 'role' and (o->>'role') is distinct from (c->'expect'->>'role'))
       or (c->'expect' ? 'url' and (o->>'url') is distinct from (c->'expect'->>'url')) then
      bad := bad || format(E'\n  %s: got %s', c->>'name', o::text);
    end if;
  end loop;
  if bad <> '' then raise exception 'FAILED shared owner cases:%', bad; end if;
  raise notice 'ok O1 % shared owner cases match keyword_owner()', n;
end $$;

-- ── 2. Helpers ──────────────────────────────────────────────────────────────
select ko_test.ok('U1 URLs normalise: www, case, trailing slash, query and fragment dropped, paths resolved against the site',
  core_norm_url('HTTPS://WWW.Ridgeline.Example.Test/Service-Areas/Oakfield/?utm=1#x') = 'https://ridgeline.example.test/service-areas/oakfield'
  and core_norm_url('/osage-beach', 'https://www.lake.example.test/') = 'https://lake.example.test/osage-beach'
  and core_norm_url('https://a.example.test:8443/x') = 'https://a.example.test/x'
  and core_norm_url('a.example.test/x') is null and core_norm_url('/x') is null and core_norm_url('') is null
  and core_url_host('https://www.A.example.test/x') = 'a.example.test');
select ko_test.ok('U2 the role table: Home posts but no blogs; reviews pages take commercial and navigational posts; refresh never on an article',
  core_owner_allows('home', 'post', 'transactional') and not core_owner_allows('home', 'blog', 'informational')
  and core_owner_allows('brand', 'post', 'commercial') and core_owner_allows('brand', 'post', 'navigational')
  and not core_owner_allows('brand', 'post', 'informational') and core_owner_allows('city', 'blog', 'informational')
  and not core_owner_allows('city', 'blog', 'commercial') and not core_owner_allows('blog', 'refresh', 'informational')
  and core_owner_allows('service', 'refresh', 'commercial') and not core_owner_allows('nope', 'post', 'commercial'));
select ko_test.ok('U3 a bad purpose is refused, not ignored',
  ko_test.msg(format('select keyword_owner(%L, null, %L, %L)', ko_test.id('R'), ko_test.id('kRoof'), 'publish')) like '22023:%');
select ko_test.ok('U4 site of a keyword: by service, else the one site its own pages are on; never another site',
  core_site_of_keyword(ko_test.id('H'), ko_test.id('kHouston')) = ko_test.id('H.lift')
  and core_site_of_keyword(ko_test.id('H'), ko_test.id('kSafeCo')) = ko_test.id('H.safe')
  and core_site_of_keyword(ko_test.id('H'), ko_test.id('kSafeCoLift')) = ko_test.id('H.lift')
  and core_site_of_keyword(ko_test.id('H'), ko_test.id('kTwoHosts')) is null
  and core_site_of_keyword(ko_test.id('H'), ko_test.id('kNoProg')) is null
  and core_site_of_keyword(ko_test.id('R'), ko_test.id('kRoof')) is null);

-- ── 3. Guards ───────────────────────────────────────────────────────────────
select ko_test.ok('G1 an office market must be an active physical location',
  ko_test.msg(format($q$insert into client_service_markets (client_id, city, state, status, basis, source_ref, decided_on)
                       values (%L, 'Nowhere', 'MO', 'approved', 'office', 'x', current_date)$q$, ko_test.id('R'))) like '23514:%physical location%');
select ko_test.ok('G2 a teammate market needs a signed-in teammate (a script cannot claim one)',
  ko_test.msg(format($q$insert into client_service_markets (client_id, city, state, status, basis, source_ref, decided_on)
                       values (%L, 'Lakeview', 'MO', 'approved', 'teammate', 'x', current_date)$q$, ko_test.id('R'))) like '42501:%');
select ko_test.ok('G3 a recorded decision carries forward with its source and date; a market is kept, never deleted, its place never edited',
  ko_test.msg(format($q$insert into client_service_markets (client_id, city, state, status, basis, source_ref, decided_on)
                       values (%L, 'Lakeview', 'MO', 'held', 'recorded_decision', 'Decision log 2026-10-27', '2026-10-27')$q$, ko_test.id('R'))) = 'accepted'
  and ko_test.msg(format($q$delete from client_service_markets where id = %L$q$, ko_test.id('mOak'))) like '42501:%'
  and ko_test.msg(format($q$update client_service_markets set state = 'KS' where id = %L$q$, ko_test.id('mOak'))) like '42501:%'
  and ko_test.msg(format($q$update client_service_markets set status = 'held' where id = %L$q$, ko_test.id('mFair'))) = 'accepted');
select ko_test.ok('G4 a keyword''s market is its own client''s',
  ko_test.msg(format($q$update keywords set market_id = %L where id = %L$q$, ko_test.id('mHannibal'), ko_test.id('kRoof'))) like '23514:%another client%');
select ko_test.ok('G5a a page check is recorded with its normalised URL computed, not supplied',
  ko_test.msg(format($q$insert into owner_page_checks (client_id, requested_url, url_norm, verdict, method, source_ref)
                       values (%L, 'https://WWW.ridgeline.example.test/extra/', 'https://evil.example.test', 'live', 'http', 't')$q$, ko_test.id('R'))) = 'accepted');
select ko_test.ok('G5b a page check is a record: no update, no delete',
  (select url_norm from owner_page_checks where client_id = ko_test.id('R') and requested_url like '%/extra/') = 'https://ridgeline.example.test/extra'
  and ko_test.msg(format($q$update owner_page_checks set verdict = 'live' where client_id = %L$q$, ko_test.id('R'))) like '42501:%'
  and ko_test.msg(format($q$delete from owner_page_checks where client_id = %L$q$, ko_test.id('R'))) like '42501:%');
select ko_test.ok('G6a a hold is kept; only a signed-in teammate releases it',
  ko_test.msg(format($q$delete from client_promotion_holds where id = %L$q$, ko_test.id('hRepair'))) like '42501:%'
  and ko_test.msg(format($q$update client_promotion_holds set status = 'released', released_on = current_date where id = %L$q$, ko_test.id('hRepair'))) like '42501:%'
  and ko_test.msg(format($q$insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
                       values (%L, 'Monitoring', array['Solar-Monitoring!!'], 'x', current_date)$q$, ko_test.id('R'))) = 'accepted');
select ko_test.ok('G6b hold phrases are normalised to words',
  (select phrases from client_promotion_holds where client_id = ko_test.id('R') and offering = 'Monitoring') = array['solar monitoring']);
select ko_test.ok('G7 held phrases match whole words in any text, and the held service''s page',
  core_promotion_hold(ko_test.id('R'), null, 'We also do SOLAR monitoring.', null, null) like 'Monitoring%'
  and core_promotion_hold(ko_test.id('R'), null, 'solar monitoringfoo', null, null) is null
  and core_promotion_hold(ko_test.id('R'), null, null, null, 'https://www.ridgeline.example.test/services/other-repair/') like 'Repairs on systems%');
select ko_test.ok('G7b held phrases match their inflections: "third party roof repairs" is held',
  core_promotion_hold(ko_test.id('R'), null, 'third party roof repairs', null, null) like 'Repairs on systems%'
  and core_promotion_hold(ko_test.id('R'), null, 'roof repairs for other installers'' jobs', null, null) like 'Repairs on systems%'
  and core_promotion_hold(ko_test.id('R'), null, 'roof replacement for your home', null, null) is null);
do $$
declare c jsonb; got text; bad text := ''; n int := 0;
begin
  for c in select x from ko_test.fx, jsonb_array_elements(j->'hold_text_cases'->'cases') x loop
    got := core_hold_hit(array(select jsonb_array_elements_text(j->'hold_text_cases'->'phrases') from ko_test.fx), c->>'text');
    n := n + 1;
    if got is distinct from (c->>'hit') then bad := bad || format(E'\n  %s: got %s', c->>'name', coalesce(got, 'null')); end if;
  end loop;
  if bad <> '' or n < 15 then raise exception 'FAILED shared hold-phrase cases (%):%', n, bad; end if;
  raise notice 'ok G7c % shared hold-phrase cases match core_hold_hit()', n;
end $$;

-- ── 4. Eligibility, lists, grounding ────────────────────────────────────────
set local session_replication_role = replica;
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select ko_test.id('list.R'), ko_test.id('R'), 1, 'approved', array(select ko_test.id(x->>'key') from ko_test.fx, jsonb_array_elements(j->'keywords') x
                                                                    where x->>'client' = 'R' and x->>'key' <> 'kInactive'),
       'test fixture', (select id from team_members limit 1), now();
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at) values
  (ko_test.id('list.safe'), ko_test.id('H'), ko_test.id('H.safe'), 1, 'approved',
   array[ko_test.id('kSafeCo'), ko_test.id('kHoustonSafe'), ko_test.id('kSafeSvc')], 'test fixture', (select id from team_members limit 1), now()),
  (ko_test.id('list.lift'), ko_test.id('H'), ko_test.id('H.lift'), 1, 'approved',
   array[ko_test.id('kLiftCo'), ko_test.id('kSafeCoLift'), ko_test.id('kHannibal'), ko_test.id('kHouston')], 'test fixture', (select id from team_members limit 1), now());
set local session_replication_role = origin;

select ko_test.ok('E1 eligibility passes the owner rule through: city term with a service, Home term with none, both ready',
  core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kCity')) is null
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kHome'), null, 'post') is null
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kHome'), null, 'blog') like 'owner_role_not_allowed:%'
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kCityHeld')) like 'market_unverified:%Fairview, MO is held%'
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kNotChecked')) like 'page_not_verified:%'
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kHeldKw')) like 'promotion_held:%'
  and core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kGut')) = 'keyword_not_eligible: the keyword''s service is not approved.');
select ko_test.ok('E2 a serviceless brand-site keyword grounds in its own site''s list only',
  (select list_id from core_keyword_grounding(ko_test.id('H'), ko_test.id('kSafeCo'))) = ko_test.id('list.safe')
  and (select list_id from core_keyword_grounding(ko_test.id('H'), ko_test.id('kSafeCoLift'))) = ko_test.id('list.lift')
  and not exists (select 1 from core_keyword_grounding(ko_test.id('H'), ko_test.id('kNoProg'))));
select ko_test.ok('E3 per-site eligibility: the safety Home term on the lift program is another site''s; same text on lift is fine',
  core_keyword_eligibility(ko_test.id('H'), ko_test.id('H.lift'), ko_test.id('kSafeCo')) = 'keyword_not_eligible: the keyword belongs to another brand site.'
  and core_keyword_eligibility(ko_test.id('H'), ko_test.id('H.safe'), ko_test.id('kSafeCo')) is null
  and core_keyword_eligibility(ko_test.id('H'), ko_test.id('H.lift'), ko_test.id('kSafeCoLift')) is null
  and core_keyword_eligibility(ko_test.id('H'), ko_test.id('H.lift'), ko_test.id('kHouston')) like 'keyword_wrong_page:%');
select ko_test.ok('E4 a brand site''s proposal may hold its serviceless Home term, not another site''s',
  ko_test.msg(format($q$insert into core_keyword_lists (client_id, brand_workspace_id, version, keyword_ids, source_ref) values (%L, %L, 1, array[%L, %L]::uuid[], 'p')$q$,
    ko_test.id('H'), ko_test.id('H.safe'), ko_test.id('kSafeCo'), ko_test.id('kSafeSvc'))) = 'accepted'
  and ko_test.msg(format($q$insert into core_keyword_lists (client_id, brand_workspace_id, version, keyword_ids, source_ref) values (%L, %L, 1, array[%L]::uuid[], 'p')$q$,
    ko_test.id('H'), ko_test.id('H.safe'), ko_test.id('kSafeCoLift'))) like '23514:%for a service of that site%');

-- ── 5. Review gates ─────────────────────────────────────────────────────────
insert into social_accounts (id, client_id, platform, display_name, external_account_id) values
  (ko_test.id('fbR'), ko_test.id('R'), 'facebook', 'Ridgeline Page', '9001');
-- Only the core keyword gate and its evidence trigger run here (the post's
-- own submission rules are drafter.test.sql's): this suite tests the gate.
alter table social_posts disable trigger user;
alter table social_posts enable trigger social_posts_aa_core_keyword;
alter table social_posts enable trigger social_posts_core_keyword_record;
alter table social_posts enable trigger social_posts_ab_promotion_hold;
create function ko_test.post(k text, kw text, svc text, cta text default null, status text default 'in_review') returns text language plpgsql as $$
declare r text;
begin
  r := ko_test.msg(format($q$insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status,
                                 created_at, social_account_id, copy, cta_type, cta_url)
                               values (%L, %L, 'facebook', 'commercial', %L, %L, 'draft', 'not_scheduled', now(), %L,
                                       'Fixture copy.', %s, %L)$q$,
     ko_test.id(k), ko_test.id('R'), case when svc is not null then ko_test.id(svc) end, ko_test.id(kw), ko_test.id('fbR'),
     case when cta is null then 'null' else quote_literal('LEARN_MORE') end, cta));
  if r <> 'accepted' or status = 'draft' then return r; end if;
  return ko_test.msg(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, ko_test.id(k)));
end $$;
select ko_test.ok('R1 a city-owned post in review needs no service-page button, and its button may only be the owner page',
  ko_test.post('p.city', 'kCity', 'sRoof') = 'accepted'
  and ko_test.post('p.city.cta', 'kCity', 'sRoof', 'https://ridgeline.example.test/services/roof-replacement') like '23514: cta_not_owner:%'
  and ko_test.post('p.city.cta2', 'kCity', 'sRoof', 'https://www.ridgeline.example.test/service-areas/oakfield/') = 'accepted');
select ko_test.ok('R2 a Home post with no service enters review; a held keyword, an unverified page and a held market do not',
  ko_test.post('p.home', 'kHome', null) = 'accepted'
  and ko_test.post('p.held', 'kHeldKw', 'sRoof') like '23514: promotion_held:%'
  and ko_test.post('p.unchecked', 'kNotChecked', 'sRoof') like '23514: page_not_verified:%'
  and ko_test.post('p.market', 'kCityHeld', 'sRoof') like '23514: market_unverified:%');
select ko_test.ok('R3 a post kept as a draft is not judged (existing drafts are untouched until they enter review)',
  ko_test.post('p.draft', 'kNotChecked', 'sRoof', null, 'draft') = 'accepted');

insert into sites (id, client_id, url) values (ko_test.id('site.R'), ko_test.id('R'), 'https://ridgeline.example.test');
create function ko_test.change(k text, kw text, typ text, url text) returns text language sql as $$
  select ko_test.msg(format($q$insert into change_log (id, client_id, change_type, object_type, object_id, after, status)
                               values (%L, %L, %L, 'site', %L, %L::jsonb, 'proposed')$q$,
     ko_test.id(k), ko_test.id('R'), typ, ko_test.id('site.R'), jsonb_build_object('keyword_id', ko_test.id(kw), 'url', url))) $$;
select ko_test.ok('C1 a refresh rewrites the keyword''s owner page, never its related service''s page',
  ko_test.change('c.ok', 'kCity', 'page_rewrite', 'https://ridgeline.example.test/service-areas/oakfield') = 'accepted'
  and ko_test.change('c.svc', 'kCity', 'page_rewrite', 'https://ridgeline.example.test/services/roof-replacement') like '23514: refresh_not_owner:%');
select ko_test.ok('C2 recording a newly built owner page needs its approved group, not a live check yet; another page is refused',
  ko_test.change('c.add', 'kNotChecked', 'page_added', 'https://ridgeline.example.test/flat-roofs') = 'accepted'
  and ko_test.change('c.add2', 'kNotChecked', 'page_added', 'https://ridgeline.example.test/elsewhere') like '23514: refresh_not_owner:%'
  and ko_test.change('c.rw', 'kNotChecked', 'page_rewrite', 'https://ridgeline.example.test/flat-roofs') like '23514: page_not_verified:%');
select ko_test.ok('C3 a refresh of a held page or of an article is refused',
  ko_test.change('c.held', 'kHeldPage', 'page_rewrite', 'https://ridgeline.example.test/services/other-repair') like '23514: promotion_held:%'
  and ko_test.change('c.blog', 'kBlogOwned', 'page_rewrite', 'https://ridgeline.example.test/blog/how-long-roofs-last') like '23514: owner_role_not_allowed:%');

create function ko_test.draft(k text, kw text, svc text, owner text) returns text language sql as $$
  select ko_test.msg(format($q$insert into content_drafts (id, client_id, deliverable, topic, keyword_id, search_intent, service_id, status, title, body_markdown, brief)
                               values (%L, %L, 'blog', 'Fixture', %L, 'informational', %L, 'in_review', 'T', 'Body', %L::jsonb)$q$,
     ko_test.id(k), ko_test.id('R'), ko_test.id(kw), case when svc is not null then ko_test.id(svc) end,
     jsonb_build_object('target', jsonb_build_object('owner_page', jsonb_build_object('url', owner))))) $$;
select ko_test.ok('B1 a blog in review: its brief''s owner page must be the keyword''s; Home and owned keywords anchor no new article',
  ko_test.draft('d.ok', 'kInfoService', 'sRoof', 'https://ridgeline.example.test/services/roof-replacement/') = 'accepted'
  and ko_test.draft('d.mismatch', 'kInfoService', 'sRoof', 'https://ridgeline.example.test/') like '23514: owner_page_mismatch:%'
  and ko_test.draft('d.owned', 'kBlogOwned', 'sRoof', 'https://ridgeline.example.test/blog/how-long-roofs-last') like '23514: keyword_already_owned:%');

-- ── 5b. Holds on the copy ───────────────────────────────────────────────────
create function ko_test.post_copy(k text, kw text, svc text, copy text) returns text language plpgsql as $$
declare r text;
begin
  r := ko_test.msg(format($q$insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status,
                                 created_at, social_account_id, copy)
                               values (%L, %L, 'facebook', 'commercial', %L, %L, 'draft', 'not_scheduled', now(), %L, %L)$q$,
     ko_test.id(k), ko_test.id('R'), case when svc is not null then ko_test.id(svc) end, ko_test.id(kw), ko_test.id('fbR'), copy));
  if r <> 'accepted' then return r; end if;
  return ko_test.msg(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, ko_test.id(k)));
end $$;
create function ko_test.draft_body(k text, kw text, svc text, owner text, body text) returns text language sql as $$
  select ko_test.msg(format($q$insert into content_drafts (id, client_id, deliverable, topic, keyword_id, search_intent, service_id, status, title, body_markdown, brief)
                               values (%L, %L, 'blog', 'Fixture', %L, 'informational', %L, 'in_review', 'T', %L, %L::jsonb)$q$,
     ko_test.id(k), ko_test.id('R'), ko_test.id(kw), case when svc is not null then ko_test.id(svc) end, body,
     jsonb_build_object('target', jsonb_build_object('owner_page', jsonb_build_object('url', owner))))) $$;

select ko_test.ok('H1 an allowed keyword (a city page, the generic roofing service) cannot carry copy that advertises a held offering',
  ko_test.post_copy('h.city', 'kCity', 'sRoof', 'Oakfield roofs: we also take on third-party roof repairs.') like '23514: held_offering: "third party roof repair"%'
  and ko_test.post_copy('h.parent', 'kRoof', 'sRoof', 'New roofs, and roof repairs for other installers'' jobs too.') like '23514: held_offering:%'
  and ko_test.post_copy('h.clean', 'kRoof', 'sRoof', 'A new roof, installed by our crew.') = 'accepted');
select ko_test.ok('H2 editing a post in review into held copy is refused; the edit back is accepted',
  ko_test.msg(format($q$update social_posts set copy = 'Now booking third party roof repair.' where id = %L$q$, ko_test.id('h.clean'))) like '23514: held_offering:%'
  and ko_test.msg(format($q$update social_posts set copy = 'A new roof for spring.' where id = %L$q$, ko_test.id('h.clean'))) = 'accepted');
select ko_test.ok('H3 a blog draft: held copy in the body is refused on entering review, and on an edit in review',
  ko_test.draft_body('hd.held', 'kInfoService', 'sRoof', 'https://ridgeline.example.test/services/roof-replacement/',
                     'How roofs age. We also do third-party roof repairs.') like '23514: held_offering:%'
  and ko_test.msg(format($q$update content_drafts set meta_description = 'Third party roof repairs explained' where id = %L$q$, ko_test.id('d.ok'))) like '23514: held_offering:%');
select ko_test.ok('H4 a page change recording held copy is refused',
  ko_test.msg(format($q$insert into change_log (id, client_id, change_type, object_type, object_id, after, status)
                         values (%L, %L, 'page_rewrite', 'site', %L, %L::jsonb, 'proposed')$q$,
     ko_test.id('c.heldcopy'), ko_test.id('R'), ko_test.id('site.R'),
     jsonb_build_object('keyword_id', ko_test.id('kCity'), 'url', 'https://ridgeline.example.test/service-areas/oakfield',
                        'summary', 'Adds a section on third party roof repair'))) like '23514: held_offering:%');

-- Content made BEFORE a hold is recorded: kept, and stopped at its next step.
do $$
declare r text[];
begin
  r := array[
    ko_test.post_copy('h.pre', 'kCity', 'sRoof', 'Gutter guard installs this week in Oakfield.'),
    ko_test.msg(format($q$update social_posts set review_status = 'approved', publish_status = 'scheduled', scheduled_at = now(), reviewed_by = (select id from team_members limit 1), reviewed_at = now(), approved_snapshot = '{}', approved_hash = 'sha256:' || repeat('c', 64) where id = %L$q$, ko_test.id('h.pre'))),
    ko_test.post_copy('h.pre2', 'kCity', 'sRoof', 'Gutter guard season is here.'),
    ko_test.msg(format($q$update social_posts set review_status = 'approved', publish_status = 'publishing', scheduled_at = now(), reviewed_by = (select id from team_members limit 1), reviewed_at = now(), approved_snapshot = '{}', approved_hash = 'sha256:' || repeat('c', 64) where id = %L$q$, ko_test.id('h.pre2'))),
    ko_test.draft_body('hd.pre', 'kInfoService', 'sRoof', 'https://ridgeline.example.test/services/roof-replacement/', 'Why a gutter guard helps a new roof.')];
  if exists (select 1 from unnest(r) x where x <> 'accepted') then raise exception 'FAILED H5 setup: %', r; end if;
  raise notice 'ok H5 setup: a scheduled post, a post mid-send and a draft, all before the hold';
end $$;
set local session_replication_role = replica;
insert into blog_publications (id, client_id, draft_id, draft_version, release_hash, snapshot, released_by, scheduled_at)
values (ko_test.id('bp.pre'), ko_test.id('R'), ko_test.id('hd.pre'), 1, 'sha256:' || repeat('a', 64), '{}', (select id from team_members limit 1), now());
set local session_replication_role = origin;
insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
values (ko_test.id('R'), 'Gutter guards', array['gutter guard'], 'Fixture decision', current_date);
alter table blog_publications disable trigger blog_publications_guard;
select ko_test.ok('H6 after the hold: the scheduled post''s claim is refused, the send already under way is recorded',
  ko_test.msg(format($q$update social_posts set publish_status = 'publishing' where id = %L$q$, ko_test.id('h.pre'))) like '23514: held_offering: "gutter guard"%'
  and (select publish_status from social_posts where id = ko_test.id('h.pre')) = 'scheduled'
  and ko_test.msg(format($q$update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://facebook.example.test/1' where id = %L$q$, ko_test.id('h.pre2'))) = 'accepted');
do $$
declare a text; b text; row blog_publications;
begin
  a := ko_test.msg(format($q$update blog_publications set status = 'publishing', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes' where id = %L$q$, ko_test.id('bp.pre')));
  select * into row from blog_publications where id = ko_test.id('bp.pre');
  b := ko_test.msg(format($q$insert into blog_publications (client_id, draft_id, draft_version, release_hash, snapshot, released_by, scheduled_at)
                            values (%L, %L, 2, %L, '{}', %L, now())$q$, ko_test.id('R'), ko_test.id('hd.pre'), 'sha256:' || repeat('b', 64),
                            (select id from team_members limit 1)));
  if a <> 'accepted' or row.status <> 'blocked' or row.last_error not like 'held_offering: "gutter guard"%' or row.lease_token is not null
     or b not like '23514: held_offering:%' then
    raise exception 'FAILED H7: claim %, row % / %, new release %', a, row.status, row.last_error, b;
  end if;
  raise notice 'ok H7 after the hold: the released article''s claim is recorded blocked with the reason; a new release is refused';
end $$;
alter table blog_publications enable trigger blog_publications_guard;
do $$
declare a text; i content_plan_items;
begin
  a := ko_test.msg(format($q$insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic)
                            values (%L, %L, date_trunc('week', current_date)::date, 'blog', 'educational', 'Gutter guards for new roofs')$q$,
                          ko_test.id('pi.held'), ko_test.id('R')));
  select * into i from content_plan_items where id = ko_test.id('pi.held');
  if a <> 'accepted' or i.hold is distinct from 'blocked' or i.hold_reason not like 'held_offering: "gutter guard"%' then
    raise exception 'FAILED H8: insert %, hold % / %', a, i.hold, i.hold_reason;
  end if;
  raise notice 'ok H8 a planner slot for a held offering is kept and marked blocked with the reason';
end $$;
select ko_test.ok('H9 promotion_hold_conflicts lists what already matches, and changes none of it',
  (select count(*) from promotion_hold_conflicts(ko_test.id('R')) x where x.id in (ko_test.id('h.pre'), ko_test.id('h.pre2'), ko_test.id('hd.pre'))) = 3
  and (select step from promotion_hold_conflicts(ko_test.id('R')) x where x.id = ko_test.id('h.pre2')) like 'published:%'
  and (select copy from social_posts where id = ko_test.id('h.pre')) = 'Gutter guard installs this week in Oakfield.');

-- ── 6. Evidence and the loader ──────────────────────────────────────────────
select ko_test.ok('V1 the evidence row records the owner page, its role and the market',
  exists (select 1 from core_keyword_links l where l.social_post_id = ko_test.id('p.city')
           and l.owner_url = 'https://ridgeline.example.test/service-areas/oakfield' and l.owner_role = 'city' and l.market_id = ko_test.id('mOak')));
select ko_test.ok('V2 the loader carries the owner context, and a multi-brand draft with no service finds its site by keyword',
  client_intelligence_for_content(ko_test.id('R'), null) ? 'owner_context'
  and jsonb_array_length(client_intelligence_for_content(ko_test.id('R'), null)->'owner_context'->'page_checks') = 11
  and (client_intelligence_for_content(ko_test.id('H'), null, ko_test.id('kSafeCo'))->'workspace'->>'id')::uuid = ko_test.id('H.safe')
  and not exists (select 1 from jsonb_array_elements(client_intelligence_for_content(ko_test.id('H'), null, ko_test.id('kSafeCo'))->'keywords') x
                   where x->>'id' = ko_test.id('kSafeCoLift')::text)
  and not exists (select 1 from jsonb_array_elements(client_intelligence_for_content(ko_test.id('H'), null, ko_test.id('kSafeCo'))->'pageGroups') x
                   where x->>'target_url' like '%lift.example.test%')
  and ko_test.msg(format('select client_intelligence_for_content(%L, null, %L)', ko_test.id('H'), ko_test.id('kNoProg'))) like '23514:%');
select ko_test.ok('V3 anon reaches nothing; the team reads markets, checks and holds',
  not has_function_privilege('anon', 'keyword_owner(uuid,uuid,uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'keyword_owner(uuid,uuid,uuid,text)', 'execute')
  and not has_table_privilege('anon', 'client_service_markets', 'select')
  and has_table_privilege('authenticated', 'owner_page_checks', 'insert')
  and not has_table_privilege('authenticated', 'owner_page_checks', 'update'));

-- ── 7. What owner-page-check checks (20261028235000) ────────────────────────
-- keyword_owner() runs once per keyword in the lists (and their named
-- children), not once per place the query reads its result; the rows are
-- the ones §15's definition returned. Calls are counted by
-- pg_stat_xact_user_functions.
set local track_functions = 'pl';
create function ko_test.owner_calls() returns bigint language sql as $$
  select coalesce((select calls from pg_stat_xact_user_functions
                    where funcid = 'keyword_owner(uuid,uuid,uuid,text)'::regprocedure), 0) $$;
create function ko_test.list_keywords(c uuid, ws uuid) returns bigint language sql as $$
  select count(distinct k.id) from core_keyword_lists l cross join lateral unnest(l.keyword_ids) kid
  join keywords k on k.client_id = l.client_id and (k.id = kid or k.core_parent_keyword_id = kid) and k.is_active
  where l.client_id = c and l.status in ('proposed', 'approved') and (ws is null or l.brand_workspace_id = ws) $$;
create table ko_test.opc (run text, client uuid, ws uuid, url text, site_url text, keyword_count integer, calls bigint);
create function ko_test.opc_run(run text) returns void language plpgsql as $$
declare a record; before bigint;
begin
  for a in select * from (values (ko_test.id('R'), null::uuid), (ko_test.id('H'), null), (ko_test.id('H'), ko_test.id('H.safe')),
                                 (ko_test.id('H'), ko_test.id('H.lift'))) v(c, ws) loop
    before := ko_test.owner_calls();
    insert into ko_test.opc (run, client, ws, url, site_url, keyword_count)
    select run, a.c, a.ws, t.url, t.site_url, t.keyword_count from owner_page_check_targets(a.c, a.ws) t;
    insert into ko_test.opc (run, client, ws, calls) values (run, a.c, a.ws, ko_test.owner_calls() - before);
  end loop;
end $$;
select ko_test.opc_run('materialized');
select ko_test.ok('P1 owner_page_check_targets resolves each listed keyword once (all sites and per site)',
  (select count(*) from ko_test.opc where run = 'materialized' and calls is not null) = 4
  and not exists (select 1 from ko_test.opc where run = 'materialized' and calls is not null
                   and calls <> ko_test.list_keywords(client, ws))
  and (select sum(calls) from ko_test.opc where run = 'materialized') > 0
  and (select count(*) from ko_test.opc where run = 'materialized' and url is not null and client = ko_test.id('R')) > 1);
-- §15's definition, run and undone: the same rows, more calls.
savepoint before_opc_down;
\ir ../../rollback/20261028235000_owner_page_check_targets_materialized.down.sql
select ko_test.opc_run('inline');
select ko_test.ok('P2 the rows are §15''s, and §15''s plan resolved keywords more than once',
  not exists ((select client, ws, url, site_url, keyword_count from ko_test.opc where run = 'materialized' and url is not null)
              except all
              (select client, ws, url, site_url, keyword_count from ko_test.opc where run = 'inline' and url is not null))
  and not exists ((select client, ws, url, site_url, keyword_count from ko_test.opc where run = 'inline' and url is not null)
                  except all
                  (select client, ws, url, site_url, keyword_count from ko_test.opc where run = 'materialized' and url is not null))
  and (select sum(calls) from ko_test.opc where run = 'inline') > (select sum(calls) from ko_test.opc where run = 'materialized'));
rollback to savepoint before_opc_down;
select ko_test.ok('P3 the migration''s definition is back after the down script is undone, service_role only',
  strpos(pg_get_functiondef('owner_page_check_targets(uuid,uuid)'::regprocedure), 'o as materialized') > 0
  and not has_function_privilege('authenticated', 'owner_page_check_targets(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'owner_page_check_targets(uuid,uuid)', 'execute'));

-- ── 8. Held phrases match within one field or link (20261029010000) ─────────
-- An installation article shaped like the release's false positive, on
-- fictional data: its topic ends "design consultation" and the keyword field follows;
-- its body links the service page just before the word "consultation".
-- Neither promotes the held offering, and neither may match. A held phrase
-- inside any one field, link address or schema value still does.
insert into client_promotion_holds (id, client_id, offering, phrases, source_ref, decided_on)
values (ko_test.id('h.consult'), ko_test.id('R'), 'Standalone roof consulting; roof monitoring',
        array['roof consultation oakfield mo', 'roof consulting service', 'proposal you have received', 'roof monitoring'],
        'Fixture decision', current_date);
-- The fixture writes the whole article in one insert, TL;DR included (the
-- TL;DR's own write rules are blog_tldr.test.sql's).
alter table content_drafts disable trigger content_drafts_tldr_guard;
create function ko_test.fb_draft(k text, over jsonb default '{}') returns text language sql as $$
  select ko_test.msg(format($q$insert into content_drafts (id, client_id, deliverable, topic, primary_keyword, keyword_id, search_intent,
                                 service_id, status, title, meta_title, meta_description, h1, tldr, slug, body_markdown, cta, structured_data, brief)
                               values (%L, %L, 'blog', %L, %L, %L, 'informational', %L, 'in_review', %L, %L, %L, %L, %L, %L, %L, %L::jsonb, %L::jsonb, %L::jsonb)$q$,
     ko_test.id(k), ko_test.id('R'),
     coalesce(over->>'topic', 'Roof replacement in Oakfield: what to gather before a design consultation'),
     coalesce(over->>'primary_keyword', 'roof replacement oakfield mo'), ko_test.id('kInfoService'), ko_test.id('sRoof'),
     coalesce(over->>'title', 'What to gather before your roof replacement design consultation'),
     coalesce(over->>'meta_title', 'Before your roof design consultation'),
     coalesce(over->>'meta_description', 'A short list of papers to bring along.'),
     coalesce(over->>'h1', 'What to gather before your design consultation'),
     coalesce(over->>'tldr', 'Bring your roof''s age, photos and questions.'),
     coalesce(over->>'slug', 'roof-replacement-oakfield-design-consultation'),
     coalesce(over->>'body_markdown', 'Bringing these to a [roof replacement](https://ridgeline.example.test/services/roof-replacement) consultation helps the design start from facts.'),
     coalesce(over->'cta', '{"text": "Get your free quote", "url": "https://ridgeline.example.test/services/roof-replacement"}'),
     coalesce(over->'structured_data', '{"@type": "Article", "about": {"@type": "Service", "name": "Roof replacement"}}'),
     jsonb_build_object('target', jsonb_build_object('owner_page', jsonb_build_object('url', 'https://ridgeline.example.test/services/roof-replacement/'))))) $$;
do $$
declare a text; b text; c text;
begin
  a := ko_test.fb_draft('fb.install');
  b := ko_test.msg(format($q$update content_drafts set meta_description = 'A short list of papers to bring to the design consultation.' where id = %L$q$,
                          ko_test.id('fb.install')));
  select string_agg(x.problem, '; ') into c from promotion_hold_conflicts(ko_test.id('R')) x where x.id = ko_test.id('fb.install');
  -- The edit is the review guard's to refuse (in review); the hold passes it.
  if a <> 'accepted' or b like '%held_offering%' or c is not null then
    raise exception 'FAILED F1: enter review %, edit %, conflict %', a, b, c;
  end if;
  raise notice 'ok F1 (a) the installation article enters review, the hold passes its edit, and it is not listed as a conflict';
end $$;
set local session_replication_role = replica;
insert into keywords (id, client_id, keyword, intent, service_id, core_parent_keyword_id, is_active) values
  (ko_test.id('kConsultHeld'), ko_test.id('R'), 'roof consultation oakfield mo', 'commercial', ko_test.id('sRoof'), null, true),
  (ko_test.id('kConsultChild'), ko_test.id('R'), 'roof consultation oakfield mo cost', 'commercial', ko_test.id('sRoof'), ko_test.id('kRoof'), true);
set local session_replication_role = origin;
do $$
declare a text := core_promotion_hold(ko_test.id('R'), null, 'roof consultation oakfield mo', null, null);
        b text := keyword_owner(ko_test.id('R'), null, ko_test.id('kConsultHeld'), 'add')->>'problem_code';
        c text := keyword_owner(ko_test.id('R'), null, ko_test.id('kConsultChild'), 'add')->>'problem_code';
        d text := core_keyword_eligibility(ko_test.id('R'), null, ko_test.id('kConsultChild'));
begin
  if a not like 'Standalone roof consulting%' or b is distinct from 'promotion_held' or c is distinct from 'promotion_held'
     or d not like 'promotion_held:%' then
    raise exception 'FAILED F2: text %, keyword %, supporting %, eligibility %', a, b, c, d;
  end if;
  raise notice 'ok F2 (b) the exact held keyword still holds, as a keyword and as a supporting term';
end $$;
do $$
declare f record; r text; bad text := '';
begin
  for f in select * from (values
    ('topic', '{"topic": "Book a roof consultation in Oakfield, MO"}'),
    ('primary_keyword', '{"primary_keyword": "roof consultation oakfield mo"}'),
    ('title', '{"title": "Roof consultation in Oakfield, MO"}'),
    ('meta_title', '{"meta_title": "Our roof consulting service"}'),
    ('meta_description', '{"meta_description": "Book our roof consulting service today."}'),
    ('h1', '{"h1": "Roof consulting services"}'),
    ('tldr', '{"tldr": "We offer roof monitoring."}'),
    ('slug', '{"slug": "roof-consultation-oakfield-mo"}'),
    ('body', '{"body_markdown": "Ask about our [roof consulting service](https://ridgeline.example.test/x)."}'),
    ('body link address', '{"body_markdown": "Read [more](https://ridgeline.example.test/roof-consulting-service)."}'),
    ('cta text', '{"cta": {"text": "Book roof monitoring", "url": "https://ridgeline.example.test/services/roof-replacement"}}'),
    ('cta url', '{"cta": {"text": "Learn more", "url": "https://ridgeline.example.test/roof-monitoring"}}'),
    ('schema value', '{"structured_data": {"@type": "Service", "name": "Roof consulting service"}}')) v(field, over) loop
    r := ko_test.fb_draft('fb.held.' || f.field, f.over::jsonb);
    if r not like '23514: held_offering:%' then bad := bad || format(' %s: %s;', f.field, r); end if;
  end loop;
  if bad <> '' then raise exception 'FAILED F3 a held phrase in one field was not refused:%', bad; end if;
  raise notice 'ok F3 (c) a held phrase inside any one field, link address, CTA or schema value is refused';
end $$;
set local session_replication_role = replica;
insert into content_posts (id, client_id, title, status, url) values
  (ko_test.id('fb.monitoring'), ko_test.id('R'), 'Roof Monitoring: How It Works & Why It Matters', 'draft', null);
set local session_replication_role = origin;
select ko_test.ok('F4 (d) the proposal-review closing line and the monitoring article are still flagged',
  ko_test.fb_draft('fb.proposal', '{"body_markdown": "You are welcome to bring any proposal you have received to Ridgeline for a plain-language conversation about it."}')
    like '23514: held_offering: "proposal you have received"%'
  and exists (select 1 from promotion_hold_conflicts(ko_test.id('R')) x where x.id = ko_test.id('fb.monitoring') and x.problem like '%"roof monitoring"%'));
select ko_test.ok('F5 (e) an ordinary design consultation and comparison advice are allowed',
  ko_test.fb_draft('fb.ordinary', '{"body_markdown": "Request a roof replacement design consultation for your home in Oakfield, MO. Bring the proposals you have collected and ask each roofer to walk through the differences."}')
    = 'accepted');
-- The released matcher, run and undone: the same article matched across fields.
savepoint before_fb_down;
\ir ../../rollback/20261029010000_promotion_hold_field_boundaries.down.sql
select ko_test.ok('F6 under the released matcher the article was a conflict and its edit was refused (what this fixes)',
  exists (select 1 from promotion_hold_conflicts(ko_test.id('R')) x where x.id = ko_test.id('fb.install'))
  and ko_test.msg(format($q$update content_drafts set meta_description = 'Papers to bring along.' where id = %L$q$, ko_test.id('fb.install')))
      like '23514: held_offering:%'
  and to_regprocedure('core_hold_segments(text)') is null);
rollback to savepoint before_fb_down;
select ko_test.ok('F7 the field-aware matcher is back after the down script is undone',
  to_regprocedure('core_hold_segments(text)') is not null
  and core_hold_hit(array['roof consultation oakfield mo'], concat_ws(E'\x1f', 'before a design consultation', 'roof replacement oakfield mo')) is null);

rollback;
