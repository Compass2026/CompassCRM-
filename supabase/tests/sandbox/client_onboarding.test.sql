-- New Client Onboarding v1.0 (20261029170000_client_onboarding_checklist.sql).
-- Plain SQL, one transaction, rolled back: runs in scripts/test-portal-sandbox.sh
-- and in tests/client-onboarding-database.test.mjs (PGlite). Fictional clients
-- and example.test domains only; nothing is called.
begin;
create schema ob;
grant usage on schema ob to anon, authenticated, service_role;
create function ob.as_user(p_sub text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true), set_config('role', 'authenticated', true)
$$;
create function ob.as_owner() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true), set_config('role', 'postgres', true)
$$;
-- Runs p_sql and returns the SQLSTATE it failed with ('' when it succeeded).
create function ob.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
-- Same, with the message, for asserting which guard refused.
create function ob.msg(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function ob.today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
-- Sets one item's status as the signed-in member (ob.member), with a note.
create function ob.set(p_client uuid, p_key text, p_status text, p_site uuid default null, p_loc uuid default null, p_note text default 'Seen (sample)') returns text
language plpgsql as $$
begin
  return ob.msg(format($q$update client_onboarding_items set status = %L, evidence_note = %L
    where client_id = %L and item_key = %L and site_id is not distinct from %L and location_id is not distinct from %L$q$,
    p_status, p_note, p_client, p_key, p_site, p_loc));
end $$;
grant execute on all functions in schema ob to anon, authenticated, service_role;

-- ── L. Legacy tasks are NOT rewritten by the migration (replay hooks) ─────
do $$
begin
  if (select n from ob_replay.enrolled) <> 0 then raise exception 'L1 the migration enrolled an existing client'; end if;
  if not exists (select 1 from ob_replay.tasks where key = 'brightlocal_lrt' and status = 'open' and title like 'BrightLocal Local Rank Tracker%' and notes is null) then
    raise exception 'L2 an open BrightLocal task was rewritten by the migration'; end if;
  if not exists (select 1 from ob_replay.tasks where key = 'brightlocal_lsg' and status = 'done' and title like 'BrightLocal Local Search Grid%'
      and completed_at = '2026-09-21 15:00:00+00' and notes = 'LSG 123 (sample)') then raise exception 'L3 a completed BrightLocal task was changed'; end if;
  if not exists (select 1 from ob_replay.tasks where client_id = '0b000000-0000-4000-b000-00000000000a' and status = 'open' and title = 'Connect Metricool') then
    raise exception 'L4 an open Metricool task was rewritten by the migration'; end if;
  if not exists (select 1 from ob_replay.tasks where client_id = '0b000000-0000-4000-b000-00000000000b' and status = 'done' and title = 'Connect Metricool'
      and notes = 'Connected (sample)' and completed_at = '2026-09-20 15:00:00+00') then raise exception 'L5 a completed Metricool task was changed'; end if;
end $$;

-- ── T. Templates: what NEW enrollments get ────────────────────────────────
do $$
declare v_client uuid := '0b100000-0000-4000-b000-0000000000a1';
begin
  if exists (select 1 from task_templates where title ilike '%metricool%' or key in ('brightlocal_lrt','brightlocal_lsg')) then
    raise exception 'T1 a retired template is still issued'; end if;
  if (select count(*) from task_templates tt join stages s on s.id = tt.stage_id join pipelines p on p.id = s.pipeline_id
      where (p.key, tt.key) in (('social','zernio_connect'), ('seo','bing_webmaster'), ('seo','map_grid_profile'))) <> 3 then
    raise exception 'T2 replacement templates missing'; end if;
  if exists (select 1 from task_templates tt join stages s on s.id = tt.stage_id join pipelines p on p.id = s.pipeline_id
      where p.key = 'seo' and tt.key = 'citation_submit' and tt.title not like '%Tom''s written approval%') then raise exception 'T3 citation template'; end if;
  insert into clients (id, name) values (v_client, 'Onboarding Template Sample (fictional)');
  insert into client_pipelines (client_id, pipeline_id) select v_client, id from pipelines where key = 'social';
  if not exists (select 1 from tasks where client_id = v_client and key = 'zernio_connect' and status = 'open')
     or exists (select 1 from tasks where client_id = v_client and title ilike '%metricool%') then
    raise exception 'T4 a new social enrollment did not get the Zernio task'; end if;
  perform create_stage_tasks(cp.id) from client_pipelines cp join pipelines p on p.id = cp.pipeline_id where cp.client_id = v_client and p.key = 'social';
  if (select count(*) from tasks where client_id = v_client and key = 'zernio_connect') <> 1 then raise exception 'T5 duplicate pipeline task'; end if;
end $$;

-- ── Fixtures (as the owner) ───────────────────────────────────────────────
-- A: one site, a storefront and a service-area location, two GBP profiles (Wichita bound and verified,
--    Overland Park on record but not connected), two Facebook Pages and a brand that owns one of them.
-- B: another client. N: nothing yet. M: several sites and locations. C: map-tracking only.
insert into auth.users (id, email) values
  ('0b200000-0000-4000-a000-000000000002', 'ob-member@compassmarketing.ai'),
  ('0b200000-0000-4000-a000-000000000003', 'ob-stranger@example.test');
insert into team_members (auth_user_id, name, email, role) values ('0b200000-0000-4000-a000-000000000002', 'Ob Member', 'ob-member@compassmarketing.ai', 'member');
insert into clients (id, name) values
  ('0b300000-0000-4000-b000-00000000000a', 'Onboarding Sample A (fictional)'),
  ('0b300000-0000-4000-b000-00000000000b', 'Onboarding Sample B (fictional)'),
  ('0b300000-0000-4000-b000-00000000000e', 'Onboarding Sample N (fictional)'),
  ('0b300000-0000-4000-b000-00000000000f', 'Onboarding Sample M (fictional)');
insert into clients (id, name, status, service_scope) values ('0b300000-0000-4000-b000-00000000000c', 'Onboarding Map Only (fictional)', 'paused', 'map_tracking');
insert into sites (id, client_id, url, stack) values
  ('0b400000-0000-4000-c000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'https://www.sample-a.example.test/', 'other'),
  ('0b400000-0000-4000-c000-0000000000b1', '0b300000-0000-4000-b000-00000000000b', 'https://sample-b.example.test', 'other'),
  ('0b400000-0000-4000-c000-0000000000f1', '0b300000-0000-4000-b000-00000000000f', 'https://one.sample-m.example.test', 'other'),
  ('0b400000-0000-4000-c000-0000000000f2', '0b300000-0000-4000-b000-00000000000f', 'https://two.sample-m.example.test', 'other');
-- Bound rows as the publisher would leave them (its guard is lifted only for these fixture rows, rolled back).
alter table social_accounts disable trigger social_accounts_publish_guard;
insert into social_accounts (id, client_id, platform, external_account_id, display_name, publish_provider, publish_account_id, publish_page_id, publish_verified_at) values
  ('0b600000-0000-4000-e000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'google_business', 'locations/1111', 'Wichita (sample)', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaaa1', 'locations/1111', now()),
  ('0b600000-0000-4000-e000-0000000000a3', '0b300000-0000-4000-b000-00000000000a', 'facebook', '1000001', 'Sample A Page', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaaa3', '1000001', now()),
  ('0b600000-0000-4000-e000-0000000000a4', '0b300000-0000-4000-b000-00000000000a', 'facebook', '1000002', 'Sample A Other Page', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaaa4', '1000002', now());
alter table social_accounts enable trigger social_accounts_publish_guard;
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  ('0b600000-0000-4000-e000-0000000000a2', '0b300000-0000-4000-b000-00000000000a', 'google_business', 'locations/2222', 'Overland Park (sample, not connected)'),
  ('0b600000-0000-4000-e000-0000000000b1', '0b300000-0000-4000-b000-00000000000b', 'google_business', 'locations/3333', 'B profile (sample)');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, blog_site_id, facebook_account_id) values
  ('0b700000-0000-4000-f000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'sample-a', 'Sample A Brand', 'https://www.sample-a.example.test', '4175550100',
   '0b400000-0000-4000-c000-0000000000a1', '0b600000-0000-4000-e000-0000000000a3');
select ob.as_user('00000000-0000-4000-a000-000000000001');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone, website_url) values
  ('0b500000-0000-4000-d000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'Wichita (sample)', 'Sample A Roofing LLC', '1 Main St', 'Wichita', 'KS', '67202', '(316) 555-0100', 'https://www.sample-a.example.test'),
  ('0b500000-0000-4000-d000-0000000000b1', '0b300000-0000-4000-b000-00000000000b', 'B office (sample)', 'Sample B Electric', '2 Elm St', 'Columbia', 'MO', '65201', '(573) 555-0100', null),
  ('0b500000-0000-4000-d000-0000000000f1', '0b300000-0000-4000-b000-00000000000f', 'M north (sample)', 'Sample M Co', '3 Oak St', 'Joplin', 'MO', '64801', '(417) 555-0300', null),
  ('0b500000-0000-4000-d000-0000000000f2', '0b300000-0000-4000-b000-00000000000f', 'M south (sample)', 'Sample M Co', '4 Ash St', 'Branson', 'MO', '65616', '(417) 555-0301', null);
insert into citation_locations (id, client_id, label, business_name, city, region, hide_address, phone) values
  ('0b500000-0000-4000-d000-0000000000a2', '0b300000-0000-4000-b000-00000000000a', 'Overland Park (sample)', 'Sample A Roofing LLC', 'Overland Park', 'KS', true, '(913) 555-0101');
select ob.as_owner();

-- ── E. Enrollment: future clients, sites / locations added later, idempotent ──
do $$
declare
  a uuid := '0b300000-0000-4000-b000-00000000000a';
  m uuid := '0b300000-0000-4000-b000-00000000000f';
  n_client int := (select count(*) from onboarding_items where is_active and scope = 'client');
  n_site int := (select count(*) from onboarding_items where is_active and scope = 'site');
  n_loc int := (select count(*) from onboarding_items where is_active and scope = 'location');
begin
  if (select count(*) from onboarding_items) <> 26 or n_client <> 6 or n_site <> 10 or n_loc <> 10 then
    raise exception 'E0 registry shape % / % / %', n_client, n_site, n_loc; end if;
  -- Sites and locations recorded after the client was created got their rows at once.
  if (select count(*) from client_onboarding_items where client_id = a) <> n_client + n_site + 2 * n_loc then raise exception 'E1 A coverage %', (select count(*) from client_onboarding_items where client_id = a); end if;
  if (select count(*) from client_onboarding_items where client_id = m) <> n_client + 2 * n_site + 2 * n_loc then raise exception 'E1b M coverage'; end if;
  if exists (select 1 from client_onboarding_items where client_id = '0b300000-0000-4000-b000-00000000000c') then raise exception 'E2 map-tracking client enrolled'; end if;
  -- A client inserted by the service role (a data load) is enrolled the same way.
  perform set_config('role', 'service_role', true);
  insert into clients (id, name) values ('0b300000-0000-4000-b000-00000000000d', 'Onboarding Service Load (fictional)');
  perform ob.as_owner();
  if (select count(*) from client_onboarding_items where client_id = '0b300000-0000-4000-b000-00000000000d' and status = 'not_started') <> n_client then
    raise exception 'E2b service-role insert not enrolled'; end if;
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if enroll_client_onboarding(a) <> 0 then raise exception 'E3 re-run added rows'; end if;
  -- Re-run never overwrites progress.
  update client_onboarding_items set status = 'requested', next_action = 'Waiting on the owner (sample)' where client_id = a and item_key = 'access_requests';
  perform enroll_client_onboarding(a);
  if (select status from client_onboarding_items where client_id = a and item_key = 'access_requests') <> 'requested' then raise exception 'E4 re-run reset a status'; end if;
  if exists (select 1 from client_onboarding_items i left join sites s on s.id = i.site_id left join citation_locations l on l.id = i.location_id
      where i.client_id <> coalesce(s.client_id, l.client_id, i.client_id)) then raise exception 'E5 a row points at another client''s site or location'; end if;
  perform ob.as_owner();
end $$;

-- ── G. Gaps: nothing is complete by omission ──────────────────────────────
select ob.as_user('0b200000-0000-4000-a000-000000000002');
do $$
declare n uuid := '0b300000-0000-4000-b000-00000000000e'; a uuid := '0b300000-0000-4000-b000-00000000000a'; r text;
begin
  -- A client with no site and no location shows both gaps.
  if (select array_agg(kind order by kind) from client_onboarding_gaps where client_id = n) <> array['no_location','no_site'] then
    raise exception 'G1 gaps %', (select array_agg(kind) from client_onboarding_gaps where client_id = n); end if;
  if (select count(*) from client_onboarding_gaps where client_id = a) <> 0 then raise exception 'G2 A has gaps'; end if;
  perform ob.set(n, 'identity_business', 'verified');
  -- "Verified" is refused while nothing is recorded; "none" is a reasoned not-applicable decision.
  r := ob.set(n, 'scope_sites', 'verified');
  if r not like '23514%Record every website%' then raise exception 'G3 verified with no site: %', r; end if;
  if ob.set(n, 'scope_sites', 'not_applicable', null, null, 'Client has no website; GBP only (sample)') <> '' then raise exception 'G4'; end if;
  if ob.set(n, 'scope_locations', 'not_applicable', null, null, 'Online-only seller; no eligible location (sample)') <> '' then raise exception 'G5'; end if;
  if exists (select 1 from client_onboarding_gaps where client_id = n) then raise exception 'G6 decided gaps remain'; end if;
  -- Scope added later: rows arrive, and the "none" decision is reported for review.
  perform ob.as_owner();
  insert into sites (id, client_id, url, stack) values ('0b400000-0000-4000-c000-0000000000e1', n, 'https://later.sample-n.example.test', 'other');
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if (select count(*) from client_onboarding_items where site_id = '0b400000-0000-4000-c000-0000000000e1') <> (select count(*) from onboarding_items where is_active and scope = 'site') then
    raise exception 'G7 a later site got no rows'; end if;
  if (select array_agg(kind) from client_onboarding_gaps where client_id = n) <> array['site_after_none'] then raise exception 'G8 site after none not reported'; end if;
  -- With a site on record, "no website" cannot be decided again, and verified is now possible.
  update client_onboarding_items set status = 'in_progress' where client_id = n and item_key = 'scope_sites';
  if ob.set(n, 'scope_sites', 'not_applicable', null, null, 'x') not like '23514%does not apply%' then raise exception 'G9'; end if;
  if ob.set(n, 'scope_sites', 'verified', null, null, 'One site, recorded (sample)') <> '' then raise exception 'G10'; end if;
  -- A location archived and approved again keeps its rows; a standard item added later is a gap until enrollment.
  perform ob.as_owner();
  insert into onboarding_items (key, section, scope, sort_order, title) values ('later_site_item', 'website', 'site', 999, 'Item added to the standard later (sample)');
  if not exists (select 1 from client_onboarding_gaps where client_id = a and kind = 'site_missing_items') then raise exception 'G11 missing item not reported'; end if;
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if ob.set(a, 'identity_business', 'verified') <> '' then raise exception 'G12'; end if;
  if ob.set(a, 'scope_sites', 'verified') not like '23514%Record every website%' then raise exception 'G13 verified with a site missing items'; end if;
  perform enroll_client_onboarding(a);
  if exists (select 1 from client_onboarding_gaps where client_id = a) then raise exception 'G14 gap after enrollment'; end if;
  if ob.set(a, 'scope_sites', 'verified') <> '' or ob.set(a, 'scope_locations', 'verified') <> '' then raise exception 'G15'; end if;
  if ob.set(a, 'scope_locations', 'not_applicable', null, null, 'x') not like '23514%does not apply%' then raise exception 'G16'; end if;
end $$;
select ob.as_owner();
delete from client_onboarding_items where item_key = 'later_site_item';
delete from onboarding_items where key = 'later_site_item';

-- ── S. Client / site / location isolation ─────────────────────────────────
select ob.as_user('0b200000-0000-4000-a000-000000000002');
do $$
begin
  if ob.err($q$insert into client_onboarding_items (client_id, item_key, site_id) values ('0b300000-0000-4000-b000-00000000000a', 'gsc_ga4_link', '0b400000-0000-4000-c000-0000000000b1')$q$) <> '23514' then
    raise exception 'S1 another client''s site accepted'; end if;
  if ob.err($q$insert into client_onboarding_items (client_id, item_key, location_id) values ('0b300000-0000-4000-b000-00000000000a', 'citation_yelp', '0b500000-0000-4000-d000-0000000000b1')$q$) <> '23514' then
    raise exception 'S2 another client''s location accepted'; end if;
  if ob.err($q$insert into client_onboarding_items (client_id, item_key) values ('0b300000-0000-4000-b000-00000000000b', 'citation_yelp')$q$) <> '23514' then
    raise exception 'S3 a location item without a location'; end if;
  if ob.err($q$insert into client_onboarding_items (client_id, item_key, site_id, location_id) values ('0b300000-0000-4000-b000-00000000000a', 'identity_location', '0b400000-0000-4000-c000-0000000000a1', '0b500000-0000-4000-d000-0000000000a1')$q$) <> '23514' then
    raise exception 'S4 two scopes accepted'; end if;
  if ob.err($q$insert into client_onboarding_items (client_id, item_key, location_id) values ('0b300000-0000-4000-b000-00000000000a', 'citation_yelp', '0b500000-0000-4000-d000-0000000000a1')$q$) <> '23505' then
    raise exception 'S5 a duplicate item accepted'; end if;
  if ob.err($q$update client_onboarding_items set client_id = '0b300000-0000-4000-b000-00000000000b' where client_id = '0b300000-0000-4000-b000-00000000000a' and item_key = 'service_areas'$q$) <> '23514' then
    raise exception 'S6 an item moved client'; end if;
  if ob.err($q$update client_onboarding_items set site_id = '0b400000-0000-4000-c000-0000000000b1' where site_id = '0b400000-0000-4000-c000-0000000000a1' and item_key = 'website_owner'$q$) <> '23514' then
    raise exception 'S7 an item moved site'; end if;
end $$;

-- ── P. Prerequisites are enforced in the same scope ───────────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a'; m uuid := '0b300000-0000-4000-b000-00000000000f';
  wichita uuid := '0b500000-0000-4000-d000-0000000000a1'; op uuid := '0b500000-0000-4000-d000-0000000000a2'; r text;
begin
  -- identity_location (prerequisite of every listing) is not done here.
  r := ob.set(a, 'citation_mapquest', 'not_applicable', null, op, 'No hidden-address support confirmed (sample)');
  if r <> '' then raise exception 'P0 not applicable needs no prerequisite: %', r; end if;
  update client_onboarding_items set status = 'connected', evidence_note = 'Bound (sample)' where client_id = a and item_key = 'zernio_gbp' and location_id = wichita;
  r := ob.msg(format($q$update client_onboarding_items set status = 'verified', social_account_id = '0b600000-0000-4000-e000-0000000000a1' where client_id = %L and item_key = 'zernio_gbp' and location_id = %L$q$, a, wichita));
  if r not like '23514%Prerequisite not done: "Business Profile for this location%' then raise exception 'P1 verified before its prerequisite: %', r; end if;
  -- Another site's / location's done prerequisite never counts: M north done, M south not.
  perform ob.set(m, 'identity_business', 'verified');
  if ob.set(m, 'identity_location', 'verified', null, '0b500000-0000-4000-d000-0000000000f1') <> '' then raise exception 'P2'; end if;
  update client_onboarding_items set status = 'in_progress' where client_id = m and item_key = 'identity_location' and location_id = '0b500000-0000-4000-d000-0000000000f2';
  r := ob.set(m, 'gbp_ownership', 'verified', null, '0b500000-0000-4000-d000-0000000000f2');
  if r not like '23514%Prerequisite not done: "Location identity%' then raise exception 'P3 north''s identity credited south: %', r; end if;
  -- A missing prerequisite row is a missing prerequisite, never satisfied.
  perform ob.as_owner();
  delete from client_onboarding_items where client_id = m and item_key = 'website_owner' and site_id = '0b400000-0000-4000-c000-0000000000f2';
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  r := ob.set(m, 'website_path', 'verified', '0b400000-0000-4000-c000-0000000000f2');
  if r not like '23514%Prerequisite missing: "Approved website%' then raise exception 'P4 missing prerequisite treated as done: %', r; end if;
  if not exists (select 1 from client_onboarding_gaps where client_id = m and kind = 'site_missing_items' and target_id = '0b400000-0000-4000-c000-0000000000f2') then
    raise exception 'P5 the missing row is not a gap'; end if;
  perform enroll_client_onboarding(m);
end $$;

-- ── M. Exact matching: site data, named profiles and Pages ─────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a'; site uuid := '0b400000-0000-4000-c000-0000000000a1';
  wichita uuid := '0b500000-0000-4000-d000-0000000000a1'; op uuid := '0b500000-0000-4000-d000-0000000000a2'; r text; s jsonb;
begin
  perform ob.set(a, 'access_requests', 'verified', null, null, 'GSC, GA4, GBP granted (sample)');
  perform ob.set(a, 'website_owner', 'verified', site);
  -- Search Console: another site's property never verifies this site.
  perform ob.as_owner();
  insert into gsc_performance_imports (client_id, property, period, period_end, data) values (a, 'sc-domain:other.example.test', '2026-09-01', '2026-09-30', '{}');
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  r := ob.set(a, 'gsc_verified', 'verified', site);
  if r not like '23514%No Search Console import for sample-a.example.test%' then raise exception 'M1 another property verified the site: %', r; end if;
  if (select signal->>'data_through' from client_onboarding_overview where client_id = a and item_key = 'gsc_verified') is not null then raise exception 'M2 exact signal used another host'; end if;
  perform ob.as_owner();
  insert into gsc_performance_imports (client_id, property, period, period_end, data) values (a, 'sc-domain:sample-a.example.test', '2026-09-01', '2026-09-30', '{}');
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if ob.set(a, 'gsc_verified', 'verified', site) <> '' then raise exception 'M3'; end if;
  select signal into s from client_onboarding_overview where client_id = a and item_key = 'gsc_verified';
  if s->>'scope' <> 'exact' or s->>'property' <> 'sc-domain:sample-a.example.test' or s->>'data_through' <> '2026-09-30' then raise exception 'M4 signal %', s; end if;
  -- GA4: the tag needs this site's measurement id; data needs an import filtered to this host.
  if ob.set(a, 'ga4_stream', 'verified', site, null, 'Property set up (sample)') not like '23514%measurement id%' then raise exception 'M5'; end if;
  if ob.set(a, 'ga4_stream', 'verified', site, null, 'Stream G-SAMPLE123 collecting on the live host (sample)') <> '' then raise exception 'M6'; end if;
  perform ob.as_owner();
  insert into ga4_performance_imports (client_id, property, period, period_end, data) values (a, 'properties/1', '2026-09-01', '2026-09-30', '{"host": "other.example.test"}');
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if ob.set(a, 'ga4_reporting', 'verified', site) not like '23514%No GA4 import filtered to sample-a.example.test%' then raise exception 'M7'; end if;
  perform ob.as_owner();
  insert into ga4_performance_imports (client_id, property, period, period_end, data) values (a, 'properties/1', '2026-09-01', '2026-09-30', '{"host": "www.sample-a.example.test"}');
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  if ob.set(a, 'ga4_reporting', 'verified', site) <> '' then raise exception 'M8'; end if;

  -- Business Profile: Wichita's binding never credits Overland Park.
  perform ob.set(a, 'identity_location', 'verified', null, wichita);
  perform ob.set(a, 'identity_location', 'verified', null, op);
  if ob.set(a, 'gbp_ownership', 'verified', null, wichita) not like '23514%Name this location''s Business Profile%' then raise exception 'M9 ownership without a named profile'; end if;
  update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a1' where location_id = wichita and item_key in ('gbp_ownership','zernio_gbp');
  if ob.set(a, 'gbp_ownership', 'verified', null, wichita, 'Compass is manager (sample)') <> '' then raise exception 'M10'; end if;
  if ob.set(a, 'zernio_gbp', 'verified', null, wichita, 'Bound and verified (sample)') <> '' then raise exception 'M11'; end if;
  if ob.err(format($q$update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a1' where location_id = %L and item_key = 'zernio_gbp'$q$, op)) <> '23505' then
    raise exception 'M12 Wichita''s binding credited Overland Park'; end if;
  update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a2' where location_id = op and item_key in ('gbp_ownership','zernio_gbp');
  perform ob.set(a, 'gbp_ownership', 'verified', null, op, 'Owner confirmed manager access (sample)');
  r := ob.set(a, 'zernio_gbp', 'verified', null, op, 'Looks connected (sample)');
  if r not like '23514%own verified Zernio Business Profile binding%' then raise exception 'M13 an unconnected profile verified: %', r; end if;
  if ob.err(format($q$update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a1' where location_id = %L and item_key = 'gbp_ownership'$q$, op)) not in ('23514', '23505') then
    raise exception 'M14 a location''s GBP items name different profiles'; end if;
  if ob.err(format($q$update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000b1' where location_id = %L and item_key = 'zernio_gbp'$q$, op)) <> '23514' then
    raise exception 'M15 another client''s profile named'; end if;
  if ob.err(format($q$update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a3' where location_id = %L and item_key = 'zernio_gbp'$q$, op)) <> '23514' then
    raise exception 'M16 a Facebook Page named on a Business Profile item'; end if;
  select signal into s from client_onboarding_overview where location_id = op and item_key = 'zernio_gbp';
  if s->>'scope' <> 'exact' or s->>'account' <> 'locations/2222' or s->>'provider' <> '' then raise exception 'M17 signal %', s; end if;
  update client_onboarding_items set social_account_id = null where location_id = op and item_key = 'zernio_gbp';
  if (select signal->>'scope' from client_onboarding_overview where location_id = op and item_key = 'zernio_gbp') <> 'unlinked' then raise exception 'M18 unlinked signal not labelled'; end if;

  -- Facebook: a brand site's Page must be the brand's own.
  if ob.err(format($q$update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a4' where site_id = %L and item_key = 'zernio_facebook'$q$, site)) <> '23514' then
    raise exception 'M19 another Page credited a brand site'; end if;
  update client_onboarding_items set social_account_id = '0b600000-0000-4000-e000-0000000000a3' where site_id = site and item_key = 'zernio_facebook';
  if ob.set(a, 'zernio_facebook', 'verified', site, null, 'Page bound and verified (sample)') <> '' then raise exception 'M20'; end if;
end $$;

-- ── V. Evidence rules and sign-off ────────────────────────────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a'; who uuid; at timestamptz;
begin
  if ob.err(format($q$update client_onboarding_items set status = 'verified', evidence_note = '' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V1 verified without evidence'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'not_applicable', evidence_note = '' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V2 not applicable without a reason'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'blocked' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V3 blocked without a reason'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'connected', evidence_note = 'GA4 password: hunter2' where client_id = %L and item_key = 'other_social_channels'$q$, a)) <> '23514' then
    raise exception 'V4 a credential was stored'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'connected', evidence_note = '' where client_id = %L and item_key = 'other_social_channels'$q$, a)) <> '23514' then
    raise exception 'V5 connected without evidence'; end if;
  update client_onboarding_items set status = 'verified', evidence_note = 'Agreement lists Wichita, Overland Park (sample)', verified_by = '00000000-0000-4000-a000-000000000001'
  where client_id = a and item_key = 'service_areas';
  select verified_by, last_verified_at into who, at from client_onboarding_items where client_id = a and item_key = 'service_areas';
  if who <> '0b200000-0000-4000-a000-000000000002' or at is null then raise exception 'V6 sign-off not attributed to the signed-in teammate'; end if;
  update client_onboarding_items set next_action = 'Recheck at renewal (sample)', verified_by = '00000000-0000-4000-a000-000000000001', last_verified_at = '2020-01-01'
  where client_id = a and item_key = 'service_areas';
  if (select (verified_by, last_verified_at) from client_onboarding_items where client_id = a and item_key = 'service_areas') is distinct from (who, at) then
    raise exception 'V7 a sign-off was re-attributed'; end if;
  if (select count(*) from client_onboarding_events e join client_onboarding_items i on i.id = e.item_id where i.client_id = a and i.item_key = 'service_areas') <> 3 then
    raise exception 'V8 history'; end if;
  if ob.err($q$insert into client_onboarding_events (item_id, client_id, status, evidence_note, blocking_reason, next_action) select id, client_id, 'verified', 'x', '', '' from client_onboarding_items limit 1$q$) <> '42501'
     or ob.err($q$update client_onboarding_events set status = 'verified'$q$) <> '42501'
     or ob.err($q$delete from client_onboarding_items$q$) <> '42501' then raise exception 'V9 history or checklist editable'; end if;
end $$;
select ob.as_owner();
do $$
begin
  if ob.err($q$update client_onboarding_items set status = 'verified', evidence_note = 'Connected via Zernio (sample)' where client_id = '0b300000-0000-4000-b000-00000000000a' and item_key = 'other_social_channels'$q$) <> '42501' then
    raise exception 'V10 verified without a signed-in teammate'; end if;
  perform set_config('role', 'service_role', true);
  if ob.err($q$update client_onboarding_items set status = 'connected', evidence_note = 'x' where item_key = 'zernio_facebook'$q$) <> '42501' then
    raise exception 'V11 the service role can write the checklist'; end if;
  perform ob.as_owner();
end $$;

-- ── C. Citation items follow the Citation Tracker ─────────────────────────
select ob.as_user('0b200000-0000-4000-a000-000000000002');
do $$
declare loc uuid := '0b500000-0000-4000-d000-0000000000a1'; l uuid; s jsonb;
begin
  if ob.err(format($q$update client_onboarding_items set status = 'claimed', evidence_note = 'Owner says it is claimed' where location_id = %L and item_key = 'citation_yelp'$q$, loc)) <> '23514' then
    raise exception 'C1 claimed without a recorded listing'; end if;
  update client_onboarding_items set status = 'submitted', evidence_note = 'Submitted through Yelp for Business (sample)' where location_id = loc and item_key = 'citation_yelp';
  insert into citation_listings (client_id, location_id, directory_id, listing_url)
  select '0b300000-0000-4000-b000-00000000000a', loc, id, 'https://www.yelp.com/biz/sample-a-roofing' from citation_directories where key = 'yelp'
  returning id into l;
  update client_onboarding_items set status = 'claimed', evidence_url = 'https://www.yelp.com/biz/sample-a-roofing' where location_id = loc and item_key = 'citation_yelp';
  if ob.err(format($q$update client_onboarding_items set status = 'verified' where location_id = %L and item_key = 'citation_yelp'$q$, loc)) <> '23514' then
    raise exception 'C2 verified without a current accurate check'; end if;
  insert into citation_checks (listing_id, checked_on, method, result, observed_name, observed_phone, evidence)
  values (l, ob.today(), 'visited_url', 'accurate', 'Sample A Roofing LLC', '(316) 555-0100', 'Opened the listing (sample)');
  update client_onboarding_items set status = 'verified' where location_id = loc and item_key = 'citation_yelp';
  select signal into s from client_onboarding_overview where location_id = loc and item_key = 'citation_yelp';
  if (s->>'listings')::int <> 1 or (s->>'verified')::int <> 1 or s->>'listing_url' <> 'https://www.yelp.com/biz/sample-a-roofing' then raise exception 'C3 signal %', s; end if;
  if (select status from client_onboarding_items where location_id = '0b500000-0000-4000-d000-0000000000a2' and item_key = 'citation_yelp') <> 'not_started'
     or (select (signal->>'listings')::int from client_onboarding_overview where location_id = loc and item_key = 'citation_apple') <> 0 then
    raise exception 'C4 location isolation'; end if;
end $$;

-- ── O. Overview read model ───────────────────────────────────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a';
begin
  insert into tasks (client_id, title, owner, status, key) values ('0b300000-0000-4000-b000-00000000000b', 'Bing (sample B)', 'TOM', 'open', 'bing_webmaster');
  if (select pipeline_task_id from client_onboarding_overview where client_id = a and item_key = 'bing_webmaster') is not null then
    raise exception 'O1 another client''s task linked'; end if;
  if (select pipeline_task_status from client_onboarding_overview where client_id = '0b300000-0000-4000-b000-00000000000b' and item_key = 'bing_webmaster') <> 'open' then
    raise exception 'O2 own task not linked'; end if;
  if (select scope_label from client_onboarding_overview where client_id = a and item_key = 'website_owner') <> 'https://www.sample-a.example.test/'
     or (select location_hide_address from client_onboarding_overview where location_id = '0b500000-0000-4000-d000-0000000000a2' and item_key = 'identity_location') is not true then
    raise exception 'O3 scope labels'; end if;
  if (select signal->>'scope' from client_onboarding_overview where client_id = '0b300000-0000-4000-b000-00000000000b' and item_key = 'gsc_verified') <> 'exact'
     or (select signal->>'data_through' from client_onboarding_overview where client_id = '0b300000-0000-4000-b000-00000000000b' and item_key = 'gsc_verified') is not null then
    raise exception 'O4 B''s site shows A''s data'; end if;
  if (select client_service_scope from client_onboarding_overview where client_id = a limit 1) <> 'full' then raise exception 'O5'; end if;
end $$;

-- ── A. Access: team only ──────────────────────────────────────────────────
select ob.as_user('0b200000-0000-4000-a000-000000000003');
do $$
begin
  if exists (select 1 from client_onboarding_overview) or exists (select 1 from client_onboarding_items) or exists (select 1 from client_onboarding_events)
     or exists (select 1 from client_onboarding_gaps) then
    raise exception 'A1 a non-team sign-in reads the checklist'; end if;
  perform ob.err($q$select enroll_client_onboarding('0b300000-0000-4000-b000-00000000000b')$q$);
  if exists (select 1 from client_onboarding_items) then raise exception 'A2'; end if;
end $$;
select ob.as_owner();
do $$
begin
  if has_table_privilege('anon', 'public.client_onboarding_items', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.client_onboarding_overview', 'select')
     or has_table_privilege('anon', 'public.client_onboarding_gaps', 'select')
     or has_function_privilege('anon', 'public.enroll_client_onboarding(uuid)', 'execute') then raise exception 'A3 anon privilege'; end if;
  if has_table_privilege('authenticated', 'public.client_onboarding_items', 'delete')
     or has_table_privilege('authenticated', 'public.onboarding_items', 'insert, update, delete')
     or has_table_privilege('authenticated', 'public.client_onboarding_events', 'insert, update, delete') then raise exception 'A4 authenticated privilege'; end if;
  if exists (select 1 from pg_views v where v.schemaname = 'public' and v.viewname like 'portal\_%' and v.definition like '%onboarding%') then
    raise exception 'A5 a portal view reads the checklist'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename in ('onboarding_items','client_onboarding_items','client_onboarding_events')
      and qual like '%is_team()%' and with_check like '%is_team()%') <> 3 then raise exception 'A6 policies'; end if;
end $$;

rollback;
