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
create function ob.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create function ob.today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
grant execute on all functions in schema ob to anon, authenticated, service_role;

-- ── L. Legacy tasks (replay hooks around the migration) ───────────────────
do $$
begin
  if (select n from ob_replay.enrolled) <> 0 then raise exception 'L1 the migration enrolled an existing client'; end if;
  if not exists (select 1 from ob_replay.tasks where key = 'brightlocal_lrt' and status = 'open' and title like '[Legacy — do not buy] BrightLocal Local Rank Tracker%'
      and notes like '%not cancelled here%') then raise exception 'L2 open BrightLocal task not labelled'; end if;
  if not exists (select 1 from ob_replay.tasks where key = 'brightlocal_lsg' and status = 'done' and title like 'BrightLocal Local Search Grid%'
      and completed_at = '2026-09-21 15:00:00+00' and notes = 'LSG 123 (sample)') then raise exception 'L3 a completed BrightLocal task was changed'; end if;
  if not exists (select 1 from ob_replay.tasks where client_id = '0b000000-0000-4000-b000-00000000000a' and status = 'open' and title = '[Legacy] Connect Metricool') then
    raise exception 'L4 open Metricool task not labelled'; end if;
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
  -- Re-running stage task creation never duplicates (create_stage_tasks guard).
  perform create_stage_tasks(cp.id) from client_pipelines cp join pipelines p on p.id = cp.pipeline_id where cp.client_id = v_client and p.key = 'social';
  if (select count(*) from tasks where client_id = v_client and key = 'zernio_connect') <> 1 then raise exception 'T5 duplicate pipeline task'; end if;
end $$;

-- ── Fixtures (as the owner) ───────────────────────────────────────────────
insert into auth.users (id, email) values
  ('0b200000-0000-4000-a000-000000000002', 'ob-member@compassmarketing.ai'),
  ('0b200000-0000-4000-a000-000000000003', 'ob-stranger@example.test');
insert into team_members (auth_user_id, name, email, role) values ('0b200000-0000-4000-a000-000000000002', 'Ob Member', 'ob-member@compassmarketing.ai', 'member');
insert into clients (id, name) values
  ('0b300000-0000-4000-b000-00000000000a', 'Onboarding Sample A (fictional)'),
  ('0b300000-0000-4000-b000-00000000000b', 'Onboarding Sample B (fictional)');
insert into clients (id, name, status, service_scope) values ('0b300000-0000-4000-b000-00000000000c', 'Onboarding Map Only (fictional)', 'paused', 'map_tracking');
insert into sites (id, client_id, url, stack) values
  ('0b400000-0000-4000-c000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'https://sample-a.example.test', 'other'),
  ('0b400000-0000-4000-c000-0000000000b1', '0b300000-0000-4000-b000-00000000000b', 'https://sample-b.example.test', 'other');
select ob.as_user('00000000-0000-4000-a000-000000000001');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone, website_url) values
  ('0b500000-0000-4000-d000-0000000000a1', '0b300000-0000-4000-b000-00000000000a', 'Main office (sample)', 'Sample A Roofing LLC', '1 Main St', 'Springfield', 'MO', '65806', '(417) 555-0100', 'https://sample-a.example.test'),
  ('0b500000-0000-4000-d000-0000000000b1', '0b300000-0000-4000-b000-00000000000b', 'B office (sample)', 'Sample B Electric', '2 Elm St', 'Columbia', 'MO', '65201', '(573) 555-0100', null);
insert into citation_locations (id, client_id, label, business_name, city, region, hide_address, phone) values
  ('0b500000-0000-4000-d000-0000000000a2', '0b300000-0000-4000-b000-00000000000a', 'Service area (sample)', 'Sample A Roofing LLC', 'Nixa', 'MO', true, '(417) 555-0101');
select ob.as_owner();

-- ── E. Enrollment: future clients, idempotent re-runs, scope ──────────────
do $$
declare
  a uuid := '0b300000-0000-4000-b000-00000000000a';
  n_client int := (select count(*) from onboarding_items where is_active and scope = 'client');
  n_site int := (select count(*) from onboarding_items where is_active and scope = 'site');
  n_loc int := (select count(*) from onboarding_items where is_active and scope = 'location');
  r int;
begin
  if (select count(*) from onboarding_items) <> 24 or n_client <> 5 or n_site <> 9 or n_loc <> 10 then
    raise exception 'E0 registry shape % / % / %', n_client, n_site, n_loc; end if;
  -- A new full-service client starts with the client-scoped rows; a map-tracking client gets none.
  if (select count(*) from client_onboarding_items where client_id = a) <> n_client then raise exception 'E1 new client not enrolled'; end if;
  if exists (select 1 from client_onboarding_items where client_id = '0b300000-0000-4000-b000-00000000000c') then raise exception 'E2 map-tracking client enrolled'; end if;
  -- A client inserted by the service role (a data load) is enrolled the same way.
  perform set_config('role', 'service_role', true);
  insert into clients (id, name) values ('0b300000-0000-4000-b000-00000000000d', 'Onboarding Service Load (fictional)');
  perform ob.as_owner();
  if (select count(*) from client_onboarding_items where client_id = '0b300000-0000-4000-b000-00000000000d' and status = 'not_started') <> n_client then
    raise exception 'E2b service-role insert not enrolled'; end if;
  perform ob.as_user('0b200000-0000-4000-a000-000000000002');
  r := enroll_client_onboarding(a);
  if r <> n_site * 1 + n_loc * 2 then raise exception 'E3 enrollment added % rows', r; end if;
  if enroll_client_onboarding(a) <> 0 then raise exception 'E4 re-run added rows'; end if;
  if (select count(*) from client_onboarding_items where client_id = a) <> n_client + n_site + 2 * n_loc then raise exception 'E5 count'; end if;
  -- Re-run never overwrites progress.
  update client_onboarding_items set status = 'requested', evidence_note = '', next_action = 'Waiting on the owner (sample)'
  where client_id = a and item_key = 'access_requests';
  perform enroll_client_onboarding(a);
  if (select status from client_onboarding_items where client_id = a and item_key = 'access_requests') <> 'requested' then raise exception 'E6 re-run reset a status'; end if;
  -- Client B: its own rows only.
  perform enroll_client_onboarding('0b300000-0000-4000-b000-00000000000b');
  if exists (select 1 from client_onboarding_items i left join sites s on s.id = i.site_id left join citation_locations l on l.id = i.location_id
      where i.client_id <> coalesce(s.client_id, l.client_id, i.client_id)) then raise exception 'E7 a row points at another client''s site or location'; end if;
  perform ob.as_owner();
end $$;

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

-- ── V. Evidence rules and sign-off ────────────────────────────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a'; who uuid; at timestamptz;
begin
  if ob.err(format($q$update client_onboarding_items set status = 'verified' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V1 verified without evidence'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'not_applicable' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V2 not applicable without a reason'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'blocked' where client_id = %L and item_key = 'service_areas'$q$, a)) <> '23514' then
    raise exception 'V3 blocked without a reason'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'connected', evidence_note = 'GA4 password: hunter2' where client_id = %L and item_key = 'access_requests'$q$, a)) <> '23514' then
    raise exception 'V4 a credential was stored'; end if;
  if ob.err(format($q$update client_onboarding_items set status = 'connected' where client_id = %L and item_key = 'access_requests'$q$, a)) <> '23514' then
    raise exception 'V5 connected without evidence'; end if;
  update client_onboarding_items set status = 'verified', evidence_note = 'Agreement lists Springfield, Nixa, Ozark (sample)', verified_by = '00000000-0000-4000-a000-000000000001'
  where client_id = a and item_key = 'service_areas';
  select verified_by, last_verified_at into who, at from client_onboarding_items where client_id = a and item_key = 'service_areas';
  if who <> '0b200000-0000-4000-a000-000000000002' or at is null then raise exception 'V6 sign-off not attributed to the signed-in teammate'; end if;
  update client_onboarding_items set next_action = 'Recheck at renewal (sample)', verified_by = '00000000-0000-4000-a000-000000000001', last_verified_at = '2020-01-01'
  where client_id = a and item_key = 'service_areas';
  if (select (verified_by, last_verified_at) from client_onboarding_items where client_id = a and item_key = 'service_areas') is distinct from (who, at) then
    raise exception 'V7 a sign-off was re-attributed'; end if;
  if (select count(*) from client_onboarding_events e join client_onboarding_items i on i.id = e.item_id where i.client_id = a and i.item_key = 'service_areas') <> 3 then
    raise exception 'V8 history: %', (select count(*) from client_onboarding_events e join client_onboarding_items i on i.id = e.item_id where i.client_id = a and i.item_key = 'service_areas'); end if;
  if ob.err($q$insert into client_onboarding_events (item_id, client_id, status, evidence_note, blocking_reason, next_action) select id, client_id, 'verified', 'x', '', '' from client_onboarding_items limit 1$q$) <> '42501'
     or ob.err($q$update client_onboarding_events set status = 'verified'$q$) <> '42501'
     or ob.err($q$delete from client_onboarding_items$q$) <> '42501' then raise exception 'V9 history or checklist editable'; end if;
end $$;
select ob.as_owner();
-- The worker / service role / a connected account cannot sign anything off.
do $$
begin
  if ob.err($q$update client_onboarding_items set status = 'verified', evidence_note = 'Connected via Zernio (sample)' where client_id = '0b300000-0000-4000-b000-00000000000a' and item_key = 'zernio_facebook'$q$) <> '42501' then
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
  values (l, ob.today(), 'visited_url', 'accurate', 'Sample A Roofing LLC', '(417) 555-0100', 'Opened the listing (sample)');
  update client_onboarding_items set status = 'verified' where location_id = loc and item_key = 'citation_yelp';
  select signal into s from client_onboarding_overview where location_id = loc and item_key = 'citation_yelp';
  if (s->>'listings')::int <> 1 or (s->>'verified')::int <> 1 or s->>'listing_url' <> 'https://www.yelp.com/biz/sample-a-roofing' then raise exception 'C3 signal %', s; end if;
  -- The other location's Yelp row is untouched, and directories without a listing say so.
  if (select status from client_onboarding_items where location_id = '0b500000-0000-4000-d000-0000000000a2' and item_key = 'citation_yelp') <> 'not_started'
     or (select (signal->>'listings')::int from client_onboarding_overview where location_id = loc and item_key = 'citation_apple') <> 0 then
    raise exception 'C4 location isolation'; end if;
  -- Not applicable with a reason (e.g. hidden-address eligibility) is allowed.
  update client_onboarding_items set status = 'not_applicable', evidence_note = 'Service-area location; hidden-address support not confirmed (sample)'
  where location_id = '0b500000-0000-4000-d000-0000000000a2' and item_key = 'citation_mapquest';
end $$;

-- ── O. Overview read model ───────────────────────────────────────────────
do $$
declare a uuid := '0b300000-0000-4000-b000-00000000000a';
begin
  -- Linked pipeline task: the client's own task with the item's key (none for client A here).
  insert into tasks (client_id, title, owner, status, key) values ('0b300000-0000-4000-b000-00000000000b', 'Bing (sample B)', 'TOM', 'open', 'bing_webmaster');
  if (select pipeline_task_id from client_onboarding_overview where client_id = a and item_key = 'bing_webmaster') is not null then
    raise exception 'O1 another client''s task linked'; end if;
  if (select pipeline_task_status from client_onboarding_overview where client_id = '0b300000-0000-4000-b000-00000000000b' and item_key = 'bing_webmaster') <> 'open' then
    raise exception 'O2 own task not linked'; end if;
  if (select scope_label from client_onboarding_overview where client_id = a and item_key = 'website_owner') <> 'https://sample-a.example.test'
     or (select location_hide_address from client_onboarding_overview where location_id = '0b500000-0000-4000-d000-0000000000a2' and item_key = 'identity_location') is not true then
    raise exception 'O3 scope labels'; end if;
  if (select signal->>'property' from client_onboarding_overview where client_id = a and item_key = 'gsc_verified') <> ''
     or (select signal->'data_through' from client_onboarding_overview where client_id = a and item_key = 'gsc_verified') <> 'null'::jsonb then
    raise exception 'O4 GSC signal without data'; end if;
end $$;

-- ── A. Access: team only ──────────────────────────────────────────────────
select ob.as_user('0b200000-0000-4000-a000-000000000003');
do $$
begin
  if exists (select 1 from client_onboarding_overview) or exists (select 1 from client_onboarding_items) or exists (select 1 from client_onboarding_events) then
    raise exception 'A1 a non-team sign-in reads the checklist'; end if;
  if ob.err($q$select enroll_client_onboarding('0b300000-0000-4000-b000-00000000000b')$q$) <> '' then null; end if;
  if exists (select 1 from client_onboarding_items) then raise exception 'A2'; end if;
end $$;
select ob.as_owner();
do $$
begin
  if has_table_privilege('anon', 'public.client_onboarding_items', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.client_onboarding_overview', 'select')
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
