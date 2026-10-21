-- Citations Phase 1 (20261021160410_citations_foundation.sql). Plain SQL, one
-- transaction, rolled back: runs in scripts/test-portal-sandbox.sh and in
-- tests/citations-database.test.mjs (PGlite). Fictional clients and
-- example.test domains only; no provider is called.
begin;
create schema ct;
grant usage on schema ct to anon, authenticated;
create function ct.as_team(p_sub text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_sub, true), set_config('role', 'authenticated', true)
$$;
-- Runs p_sql and returns the SQLSTATE it failed with ('' when it succeeded).
create function ct.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
-- Compass's day (America/Chicago), which the guards use; current_date is the server's (UTC in CI).
create function ct.today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
grant execute on all functions in schema ct to anon, authenticated;

-- Fixtures, as the worker.
insert into auth.users (id, email) values
  ('c1000000-0000-4000-a000-000000000002', 'cit-member@compassmarketing.ai'),
  ('c1000000-0000-4000-a000-000000000003', 'cit-stranger@example.test'),
  ('c1000000-0000-4000-a000-000000000004', 'cit-portal@example.test');
update team_members set role = 'admin' where auth_user_id = '00000000-0000-4000-a000-000000000001';
insert into team_members (auth_user_id, name, email, role) values ('c1000000-0000-4000-a000-000000000002', 'Cit Member', 'cit-member@compassmarketing.ai', 'member');
insert into clients (id, name) values ('c1000000-0000-4000-b000-00000000000a', 'Citations Sample A'), ('c1000000-0000-4000-b000-00000000000b', 'Citations Sample B');
insert into portal_users (client_id, email, name, is_active) values ('c1000000-0000-4000-b000-00000000000a', 'cit-portal@example.test', 'Sample Owner', true);
insert into locations (id, client_id, name) values ('c1000000-0000-4000-c000-00000000000b', 'c1000000-0000-4000-b000-00000000000b', 'B home');

do $$
declare t text;
begin
  foreach t in array array['citation_locations', 'citation_location_identities', 'citation_directories', 'citation_listings', 'citation_checks',
    'citation_tasks', 'citation_fulfillment_requests', 'citation_credit_entries', 'citation_imports', 'citation_import_rows'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'C1 RLS off on %', t; end if;
    if (select count(*) <> 1 or not bool_and(qual like '%is_team()%') from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'C1 policy on %', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete') then raise exception 'C2 anon privilege on %', t; end if;
    if has_table_privilege('authenticated', 'public.' || t, 'delete') then raise exception 'C3 delete granted on %', t; end if;
  end loop;
  if has_table_privilege('authenticated', 'public.citation_location_identities', 'insert, update')
    or has_table_privilege('authenticated', 'public.citation_checks', 'update') then raise exception 'C4 history writable'; end if;
  if exists (select 1 from pg_views v where v.schemaname = 'public' and v.viewname like 'portal\_%' and v.definition like '%citation%') then
    raise exception 'C5 a portal view reads citations';
  end if;
  if has_function_privilege('anon', 'public.citation_import(jsonb, jsonb, jsonb, boolean, jsonb)', 'execute') then raise exception 'C6 anon can import'; end if;
end $$;

-- ── The team ──────────────────────────────────────────────────────────────
select ct.as_team('00000000-0000-4000-a000-000000000001');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone, website_url) values
  ('c1000000-0000-4000-d000-0000000000a1', 'c1000000-0000-4000-b000-00000000000a', 'Main office (sample)', 'Sample Roofing LLC', '100 North Main Street', 'Springfield', 'MO', '65806', '(417) 555-0100', 'https://sample-roofing.example.test');
insert into citation_locations (id, client_id, label, business_name, city, region, hide_address, phone) values
  ('c1000000-0000-4000-d000-0000000000a2', 'c1000000-0000-4000-b000-00000000000a', 'Service area (sample)', 'Sample Roofing LLC', 'Nixa', 'MO', true, '(417) 555-0101');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, tracking_location_id) values
  ('c1000000-0000-4000-d000-0000000000b1', 'c1000000-0000-4000-b000-00000000000b', 'B office', 'Sample Electric', '1 Elm St', 'Columbia', 'c1000000-0000-4000-c000-00000000000b');

do $$
declare r jsonb; yelp uuid := (select id from citation_directories where key = 'yelp'); rows jsonb;
  l uuid; c uuid; t uuid; q uuid;
begin
  -- Identity rules and history.
  if ct.err($q$insert into citation_locations (client_id, label, business_name) values ('c1000000-0000-4000-b000-00000000000a', 'No street', 'X')$q$) <> '23514' then
    raise exception 'I1 a storefront without a street was saved'; end if;
  if ct.err($q$insert into citation_locations (client_id, label, business_name, address_line1, city, tracking_location_id) values
    ('c1000000-0000-4000-b000-00000000000a', 'Wrong link', 'X', '1 A St', 'Y', 'c1000000-0000-4000-c000-00000000000b')$q$) <> '23514' then
    raise exception 'I2 another client''s tracking location was linked'; end if;
  if ct.err($q$update citation_locations set phone = '(417) 555-0199' where id = 'c1000000-0000-4000-d000-0000000000a1'$q$) <> '23514' then
    raise exception 'I3 identity changed without a reason'; end if;
  update citation_locations set phone = '(417) 555-0199', identity_note = 'Client confirmed new main line (sample)' where id = 'c1000000-0000-4000-d000-0000000000a1';
  if (select identity_version from citation_locations where id = 'c1000000-0000-4000-d000-0000000000a1') <> 2
    or (select count(*) from citation_location_identities where location_id = 'c1000000-0000-4000-d000-0000000000a1') <> 2 then
    raise exception 'I4 identity history not kept'; end if;
  update citation_locations set notes = 'internal note' where id = 'c1000000-0000-4000-d000-0000000000a1';
  if (select identity_version from citation_locations where id = 'c1000000-0000-4000-d000-0000000000a1') <> 2 then raise exception 'I5 a note bumped the identity'; end if;
  if ct.err($q$update citation_location_identities set phone = 'x'$q$) = '' then raise exception 'I6 identity history editable'; end if;

  -- Cross-client writes are refused.
  if ct.err(format($q$insert into citation_listings (client_id, location_id, directory_id) values ('c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000b1', %L)$q$, yelp)) <> '23514' then
    raise exception 'X1 a listing landed on another client''s location'; end if;

  -- Import: preview writes nothing; commit reconciles; repeat adds nothing.
  rows := jsonb_build_array(
    jsonb_build_object('row_number', 2, 'row_hash', 'h2', 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'Yelp', 'listing_url', 'https://www.yelp.com/biz/sample-roofing', 'fulfillment_status', 'provider_complete', 'observed_phone', '417-555-0100', 'source_observed_on', '2026-10-01'),
    jsonb_build_object('row_number', 3, 'row_hash', 'h3', 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'yelp.com', 'listing_url', 'https://yelp.com/biz/sample-roofing-2', 'fulfillment_status', null),
    jsonb_build_object('row_number', 4, 'row_hash', 'h4', 'location_id', 'c1000000-0000-4000-d000-0000000000a2', 'directory', 'Bing Places', 'external_id', 'BP-1', 'fulfillment_status', 'pending'),
    jsonb_build_object('row_number', 5, 'row_hash', 'h5', 'location_id', 'c1000000-0000-4000-d000-0000000000b1', 'directory', 'Yelp', 'listing_url', 'https://www.yelp.com/biz/b'),
    jsonb_build_object('row_number', 6, 'row_hash', 'h6', 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'Made Up Pages', 'listing_url', 'https://madeup.example.test/x'),
    jsonb_build_object('row_number', 7, 'row_hash', 'h7', 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'Yelp', 'listing_url', 'https://yelp.com/biz/sample-roofing/'));
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000001', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'sample.csv', 'file_sha256', repeat('a', 64)), rows, '[{"row_number": 8, "reason": "Listing URL must be a complete http or https address."}]', false);
  if (r->>'added')::int <> 3 or (r->>'rejected')::int <> 4 or (r->>'committed')::boolean then raise exception 'M1 preview counts %', r; end if;
  if exists (select 1 from citation_listings where client_id = 'c1000000-0000-4000-b000-00000000000a') or exists (select 1 from citation_imports) then
    raise exception 'M2 the preview wrote'; end if;
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000001', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'sample.csv', 'file_sha256', repeat('a', 64)), rows, '[{"row_number": 8, "reason": "Listing URL must be a complete http or https address."}]', true);
  if (r->>'added')::int <> 3 or (r->>'rejected')::int <> 4 or (r->>'rows_total')::int <> 7 then raise exception 'M3 commit counts %', r; end if;
  if (select string_agg(outcome || ':' || message, ' | ' order by row_number) from citation_import_rows where import_id = 'c1000000-0000-4000-e000-000000000001')
    !~ 'rejected:Location is not an active business location.*Unknown directory "Made Up Pages".*Same listing as row 2.*Listing URL must be' then
    raise exception 'M4 row reasons %', (select jsonb_agg(m) from citation_import_rows m); end if;
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000001', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'sample.csv', 'file_sha256', repeat('a', 64)), rows, '[]', true);
  if not (r->>'already_committed')::boolean or (r->>'added')::int <> 3 then raise exception 'M5 a retried commit was not idempotent %', r; end if;
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000002', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'sample.csv', 'file_sha256', repeat('a', 64)), rows, '[]', true);
  if (r->>'added')::int <> 0 or (r->>'skipped')::int <> 3 then raise exception 'M6 a repeat import duplicated %', r; end if;
  if (select count(*) from citation_listings where client_id = 'c1000000-0000-4000-b000-00000000000a') <> 3 then raise exception 'M7 listing count'; end if;
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000003', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'fix.csv', 'file_sha256', repeat('b', 64)), jsonb_build_array(
      jsonb_build_object('row_number', 2, 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'Yelp', 'listing_url', 'https://www.yelp.com/biz/sample-roofing', 'observed_name', 'Sample Roofing', 'source_observed_on', '2026-10-05'),
      jsonb_build_object('row_number', 3, 'location_id', 'c1000000-0000-4000-d000-0000000000a2', 'directory', 'Bing Places', 'external_id', 'BP-1', 'fulfillment_status', 'failed', 'source_observed_on', '2020-01-01')),
    '[]', true);
  if (r->>'updated')::int <> 2 or (r->>'skipped')::int <> 0 or (r->>'added')::int <> 0 then raise exception 'M8 update counts %', r; end if;
  r := citation_import(jsonb_build_object('id', 'c1000000-0000-4000-e000-000000000004', 'client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'sample_csv',
    'file_name', 'old.csv', 'file_sha256', repeat('c', 64)), jsonb_build_array(
      jsonb_build_object('row_number', 2, 'location_id', 'c1000000-0000-4000-d000-0000000000a1', 'directory', 'Yelp', 'listing_url', 'https://www.yelp.com/biz/sample-roofing', 'fulfillment_status', 'failed', 'source_observed_on', '2026-09-01')),
    '[]', true);
  if (r->'rows'->0->>'message') <> 'Older than the observation already recorded.' then raise exception 'M9 an older observation overwrote a newer one %', r; end if;
  if ct.err($q$select citation_import('{"id": "c1000000-0000-4000-e000-000000000001", "client_id": "c1000000-0000-4000-b000-00000000000b", "provider": "x_csv", "file_sha256": "aaaa"}', '[]', '[]', true)$q$) <> '42501' then
    raise exception 'M10 an import id moved to another client'; end if;

  -- Provider complete stays unverified; only a check verifies, and verification is never stored on the listing.
  select id into l from citation_listings where listing_url = 'https://www.yelp.com/biz/sample-roofing';
  if (select (fulfillment_status, verification_status) <> ('provider_complete', 'unverified') from citation_listing_overview where id = l) then
    raise exception 'V1 provider complete changed verification'; end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.citation_listings'::regclass and attname in ('verification_status', 'last_checked_on', 'last_check_id') and not attisdropped) then
    raise exception 'V2 verification can be stored (and so edited) on the listing'; end if;
  if ct.err(format($q$insert into citation_checks (listing_id, checked_on, method, result, evidence) values (%L, ct.today(), 'publisher_search', 'confirmed_absent', 'searched')$q$, l)) <> '23514' then
    raise exception 'V3 a search confirmed absence'; end if;
  insert into citation_checks (listing_id, checked_on, method, result, evidence) values (l, ct.today(), 'publisher_search', 'not_found', 'Searched Yelp for the name and phone (sample)');
  if (select verification_status from citation_listing_overview where id = l) <> 'unverified' then raise exception 'V4 not found counted as absent'; end if;
  insert into citation_checks (id, listing_id, checked_on, method, result, observed_phone, evidence) values
    ('c1000000-0000-4000-f000-000000000001', l, ct.today(), 'visited_url', 'discrepancy', '417-555-0100', 'Listing shows the old phone (sample screenshot ref S-1)');
  insert into citation_checks (id, listing_id, checked_on, method, result, observed_name, evidence) values
    ('c1000000-0000-4000-f000-000000000003', l, ct.today() - 10, 'visited_url', 'accurate', 'Sample Roofing', 'Backdated entry (sample)');
  if (select (verification_status, last_checked_on, current_phone) <> ('discrepancy', ct.today(), '417-555-0100') from citation_listing_overview where id = l) then
    raise exception 'V5 a backdated check overrode a newer one'; end if;
  if (select identity_version from citation_checks where id = 'c1000000-0000-4000-f000-000000000001') <> 2
    or (select identity_version from citation_checks where id = 'c1000000-0000-4000-f000-000000000003') <> 0 then
    raise exception 'V6 checks not pinned to the identity in effect on their date'; end if;
  if ct.err(format($q$insert into citation_checks (listing_id, checked_on, method, result, evidence) values (%L, ct.today(), 'visited_url', 'accurate', 'looked fine')$q$, l)) <> '23514' then
    raise exception 'V7 an accurate verdict recorded nothing it saw'; end if;
  if ct.err($q$update citation_checks set evidence = 'x'$q$) = '' or ct.err(format($q$insert into citation_checks (listing_id, checked_on, method, result, observed_name, evidence) values (%L, ct.today() + 5, 'visited_url', 'accurate', 'x', 'x')$q$, l)) <> '23514' then
    raise exception 'V8 checks editable or future-dated'; end if;
end $$;

-- ── Provider-format imports: registry aliases, reviewed directory creation, held rows ─
do $$
declare r jsonb; rows jsonb; v_held jsonb; imp jsonb;
begin
  imp := jsonb_build_object('client_id', 'c1000000-0000-4000-b000-00000000000a', 'provider', 'brightlocal', 'file_name', 'synthetic-campaign.csv', 'file_sha256', repeat('d', 64));
  rows := jsonb_build_array(
    jsonb_build_object('row_number', 11, 'location_id', 'c1000000-0000-4000-d000-0000000000a2', 'directory', 'maps.apple.com', 'fulfillment_status', 'submitted', 'notes', 'BrightLocal; source row 10; CSV status Submitted'),
    jsonb_build_object('row_number', 2, 'location_id', 'c1000000-0000-4000-d000-0000000000a2', 'directory', 'merchantcircle.com', 'listing_url', 'https://www.merchantcircle.com/sample-solar-synthetic', 'fulfillment_status', 'provider_complete'));
  v_held := '[{"row_number": 13, "reason": "Held for review: BrightLocal row 12 (manta.com), CSV status Unavailable. Not a listing and not proof of absence."}]';
  -- Without creation: the alias resolves Apple; the unknown directory is named, not guessed.
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000010", "create_directories": false}', rows, '[]', false, v_held);
  if (r->>'added')::int <> 1 or (r->>'rejected')::int <> 1 or (r->>'held')::int <> 1 or (r->>'rows_total')::int <> 3 then raise exception 'P1 preview %', r; end if;
  if not exists (select 1 from jsonb_array_elements(r->'rows') e where e->>'message' like 'Unknown directory "merchantcircle.com"%') then raise exception 'P2 unknown directory not named'; end if;
  -- With creation: the preview lists what it would add and adds nothing.
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000010", "create_directories": true}', rows, '[]', false, v_held);
  if (r->>'added')::int <> 2 or r->'new_directories' <> '["merchantcircle.com"]'::jsonb then raise exception 'P3 creation preview %', r; end if;
  if exists (select 1 from citation_directories where domain = 'merchantcircle.com') then raise exception 'P4 the preview created a directory'; end if;
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000010", "create_directories": true}', rows, '[]', true, v_held);
  if (r->>'added')::int <> 2 or (r->>'held')::int <> 1 or r->'new_directories' <> '["merchantcircle.com"]'::jsonb then raise exception 'P5 commit %', r; end if;
  if (select (held, rows_total) <> (1, 3) from citation_imports where id = 'c1000000-0000-4000-e000-000000000010')
    or (select outcome from citation_import_rows where import_id = 'c1000000-0000-4000-e000-000000000010' and row_number = 13) <> 'held' then
    raise exception 'P6 held row not kept'; end if;
  if (select d.key from citation_listings x join citation_directories d on d.id = x.directory_id where x.location_id = 'c1000000-0000-4000-d000-0000000000a2' and x.listing_key = 'none' and d.key like 'apple%') <> 'apple_business_connect'
    or (select count(*) from citation_directories where key like '%apple%') <> 1 then
    raise exception 'P7 maps.apple.com did not resolve to the existing Apple directory'; end if;
  if (select count(*) from citation_listing_overview where location_id = 'c1000000-0000-4000-d000-0000000000a2' and directory_key in ('apple_business_connect', 'merchantcircle_com')
      and verification_status = 'unverified' and last_checked_on is null and source_observed_on is null) <> 2 then
    raise exception 'P8 imported rows must stay unverified with no dates'; end if;
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000011", "create_directories": true}', rows, '[]', true, v_held);
  if (r->>'added')::int <> 0 or (r->>'skipped')::int <> 2 or (r->>'held')::int <> 1 or r->'new_directories' <> '[]'::jsonb then raise exception 'P9 repeat %', r; end if;
  -- A file of only historical attempts is saved as history: no listings, held rows kept, idempotent.
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000012"}', '[]', '[]', true, v_held);
  if (r->>'rows_total')::int <> 1 or (r->>'held')::int <> 1 or (r->>'added')::int <> 0 then raise exception 'P10 held-only commit %', r; end if;
  r := citation_import(imp || '{"id": "c1000000-0000-4000-e000-000000000012"}', '[]', '[]', true, v_held);
  if not (r->>'already_committed')::boolean or (r->>'held')::int <> 1 then raise exception 'P11 held-only retry %', r; end if;
end $$;

-- ── Correction task: assigned, dated, resolved only with evidence ─────────
do $$
declare l uuid := (select id from citation_listings where listing_url = 'https://www.yelp.com/biz/sample-roofing');
  member uuid := (select id from team_members where email = 'cit-member@compassmarketing.ai');
  t uuid := 'c1000000-0000-4000-f000-0000000000a1';
begin
  insert into citation_tasks (id, client_id, location_id, listing_id, kind, reason, assignee_id, due_on) values
    (t, 'c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a1', l, 'correct', 'Phone mismatch on Yelp (sample)', member, ct.today() + 7);
  if ct.err(format($q$insert into citation_tasks (client_id, location_id, listing_id, kind, reason) values ('c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a1', %L, 'correct', 'again')$q$, l)) <> '23505' then
    raise exception 'T1 a second open task for the same correction'; end if;
  if ct.err(format($q$insert into citation_tasks (client_id, location_id, listing_id, kind, reason) values ('c1000000-0000-4000-b000-00000000000b', 'c1000000-0000-4000-d000-0000000000b1', %L, 'verify', 'cross')$q$, l)) <> '23514' then
    raise exception 'T2 a task joined another client''s listing'; end if;
  if ct.err(format($q$update citation_tasks set status = 'resolved', resolution = 'Fixed' where id = %L$q$, t)) <> '23514' then
    raise exception 'T3 resolved without a date or evidence'; end if;
  if ct.err(format($q$update citation_tasks set status = 'resolved', resolution = 'Fixed', resolved_on = ct.today() - 30, evidence_ref = 'S-2' where id = %L$q$, t)) <> '23514' then
    raise exception 'T4 resolved before it opened'; end if;
  insert into citation_checks (id, listing_id, checked_on, method, result, observed_phone, evidence) values
    ('c1000000-0000-4000-f000-000000000002', l, ct.today(), 'visited_url', 'accurate', '(417) 555-0199', 'Phone corrected on Yelp (sample screenshot ref S-2)');
  update citation_tasks set status = 'resolved', resolution = 'Yelp phone corrected by the owner (sample)', resolved_on = ct.today(),
    check_id = 'c1000000-0000-4000-f000-000000000002' where id = t;
  if (select resolved_by is distinct from '00000000-0000-4000-a000-000000000001'::uuid or resolved_at is null from citation_tasks where id = t) then
    raise exception 'T5 resolution not stamped'; end if;
  if (select verification_status from citation_listing_overview where id = l) <> 'verified_accurate' then raise exception 'T6 the evidence check did not verify'; end if;
  update citation_tasks set status = 'open' where id = t;
  if (select resolved_on is not null or resolution <> '' from citation_tasks where id = t) then raise exception 'T7 reopen kept the resolution'; end if;
  update citation_tasks set status = 'cancelled', resolution = 'Duplicate of an existing task (sample)' where id = t;
end $$;

-- ── One current-evidence projection (detail, overview, CSV read the same) ─
-- The Yelp listing was imported with phone 417-555-0100 (2026-10-01, then a
-- 2026-10-05 name). The latest check (T: accurate, (417) 555-0199) is current;
-- the import stays as source_*, with its own date, never relabelled.
do $$
declare l uuid := (select id from citation_listings where listing_url = 'https://www.yelp.com/biz/sample-roofing');
begin
  if (select (current_phone, current_name, last_checked_on, source_phone, source_name, source_observed_on, source_provider)
      <> ('(417) 555-0199', '', ct.today(), '417-555-0100', 'Sample Roofing', '2026-10-05'::date, 'sample_csv') from citation_listing_overview where id = l) then
    raise exception 'E1 current vs imported %', (select to_jsonb(o) from citation_listing_overview o where id = l); end if;
  -- An inaccessible check observes nothing: no current values, the import untouched.
  insert into citation_checks (listing_id, checked_on, method, result, evidence) values (l, ct.today(), 'visited_url', 'inaccessible', 'Page returned an error (sample)');
  if (select (verification_status, current_phone, current_name, source_phone) <> ('inaccessible', '', '', '417-555-0100') from citation_listing_overview where id = l) then
    raise exception 'E2 an inaccessible check kept old values as current'; end if;
  insert into citation_checks (listing_id, checked_on, method, result, observed_phone, observed_name, evidence) values
    (l, ct.today(), 'visited_url', 'accurate', '(417) 555-0199', 'Sample Roofing', 'Back online and matching (sample)');
end $$;

-- ── Identity changes: earlier evidence is history, not current verification ─
-- Back-date the existing versions (append-only guard lifted inside this
-- rolled-back transaction only) so v1 was approved 10 days ago, v2 5 days ago.
reset role;
alter table citation_location_identities disable trigger citation_identities_append_only;
update citation_location_identities set recorded_at = now() - interval '10 days' where location_id = 'c1000000-0000-4000-d000-0000000000a1' and version = 1;
update citation_location_identities set recorded_at = now() - interval '5 days' where location_id = 'c1000000-0000-4000-d000-0000000000a1' and version = 2;
alter table citation_location_identities enable trigger citation_identities_append_only;
select ct.as_team('00000000-0000-4000-a000-000000000001');
do $$
declare l uuid := (select id from citation_listings where listing_url = 'https://www.yelp.com/biz/sample-roofing');
  y uuid := (select id from citation_listings where listing_url = 'https://yelp.com/biz/sample-roofing-2');
  c1 uuid := 'c1000000-0000-4000-f000-0000000000c1'; c2 uuid := 'c1000000-0000-4000-f000-0000000000c2'; c3 uuid := 'c1000000-0000-4000-f000-0000000000c3';
begin
  if (select verification_status from citation_listing_overview where id = l) <> 'verified_accurate' then raise exception 'R0 setup %', (select to_jsonb(o) from citation_listing_overview o where id = l); end if;
  -- The version in effect on the check's date, not the one in force when it was typed in.
  insert into citation_checks (id, listing_id, checked_on, method, result, observed_name, evidence) values
    (c1, y, ct.today() - 7, 'visited_url', 'accurate', 'Sample Roofing', 'Seen a week ago (sample)'),
    (c2, y, ct.today() - 3, 'visited_url', 'accurate', 'Sample Roofing', 'Seen three days ago (sample)');
  if (select identity_version from citation_checks where id = c1) <> 1 or (select identity_version from citation_checks where id = c2) <> 2 then
    raise exception 'R1 effective identity version'; end if;
  if (select verification_status from citation_listing_overview where id = y) <> 'verified_accurate' then raise exception 'R2 a check against the current identity verifies'; end if;
  -- A notes-only edit changes nothing.
  update citation_locations set notes = 'Office hours confirmed (sample)' where id = 'c1000000-0000-4000-d000-0000000000a1';
  if (select verification_status from citation_listing_overview where id = l) <> 'verified_accurate' then raise exception 'R3 a notes-only edit invalidated verification'; end if;
  -- A phone change: version 3; earlier checks become history and need reverification.
  update citation_locations set phone = '(417) 555-0123', identity_note = 'Client moved to a new main line (sample)' where id = 'c1000000-0000-4000-d000-0000000000a1';
  if (select (identity_version, check_identity_version, verification_status) <> (3, 2, 'needs_reverification') from citation_listing_overview where id = l)
    or (select verification_status from citation_listing_overview where id = y) <> 'needs_reverification' then
    raise exception 'R4 an identity change left old verification current %', (select to_jsonb(o) from citation_listing_overview o where id = l); end if;
  if (select count(*) from citation_checks where listing_id = l) < 5 then raise exception 'R5 history was dropped'; end if;
  -- A check dated before the change cannot claim to have evaluated the new identity.
  insert into citation_checks (id, listing_id, checked_on, method, result, observed_phone, evidence) values
    (c3, y, ct.today() - 1, 'visited_url', 'accurate', '(417) 555-0123', 'Backdated after the change (sample)');
  if (select identity_version from citation_checks where id = c3) <> 2 or (select verification_status from citation_listing_overview where id = y) <> 'needs_reverification' then
    raise exception 'R6 a backdated check was counted against the new identity'; end if;
  -- A new check today, against v3, restores current verification.
  insert into citation_checks (listing_id, checked_on, method, result, observed_phone, evidence) values
    (l, ct.today(), 'visited_url', 'accurate', '(417) 555-0123', 'New line shown on Yelp (sample)');
  if (select (verification_status, check_identity_version, current_phone) <> ('verified_accurate', 3, '(417) 555-0123') from citation_listing_overview where id = l) then
    raise exception 'R7 a current-identity check did not restore verification'; end if;
end $$;

-- ── Fulfillment requests: recorded, approved by an admin, never ordered ──
do $$
declare l uuid := (select id from citation_listings where external_id = 'BP-1');
  bing uuid := (select id from citation_directories where key = 'bing_places');
  q uuid := 'c1000000-0000-4000-f000-0000000000b1';
begin
  if ct.err(format($q$insert into citation_fulfillment_requests (client_id, location_id, directory_id, action, provider, status) values ('c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a2', %L, 'update', 'sample_provider', 'approved')$q$, bing)) <> '23514' then
    raise exception 'F1 a request was created already approved'; end if;
  insert into citation_fulfillment_requests (id, client_id, location_id, directory_id, listing_id, action, provider, status, approved_budget) values
    (q, 'c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a2', bing, l, 'update', 'sample_provider', 'pending_approval', 3.20);
  perform ct.as_team('c1000000-0000-4000-a000-000000000002');
  if ct.err(format($q$update citation_fulfillment_requests set status = 'approved' where id = %L$q$, q)) <> '42501' then
    raise exception 'F2 a member approved spend'; end if;
  if ct.err(format($q$update citation_fulfillment_requests set status = 'submitted' where id = %L$q$, q)) <> '23514' then
    raise exception 'F3 submitted without approval'; end if;
  perform ct.as_team('00000000-0000-4000-a000-000000000001');
  update citation_fulfillment_requests set status = 'approved' where id = q;
  perform ct.as_team('c1000000-0000-4000-a000-000000000002');
  if ct.err(format($q$update citation_fulfillment_requests set approved_budget = 100 where id = %L$q$, q)) <> '42501' then
    raise exception 'F4 a member raised an approved budget'; end if;
  update citation_fulfillment_requests set status = 'provider_complete', provider_reference = 'SAMPLE-REF-1', actual_amount = 0, credits_used = 1 where id = q;
  if (select (fulfillment_status, verification_status) <> ('provider_complete', 'unverified') from citation_listing_overview where id = l) then
    raise exception 'F5 provider complete must mirror fulfillment only'; end if;
  insert into citation_credit_entries (provider, kind, credits, occurred_on, note) values ('sample_provider', 'opening_balance', 10, ct.today(), 'Sample opening balance');
  insert into citation_credit_entries (provider, kind, credits, cash_amount, occurred_on) values ('sample_provider', 'purchase', 5, 12.00, ct.today());
  if ct.err($q$insert into citation_credit_entries (provider, kind, credits, cash_amount, occurred_on) values ('sample_provider', 'adjustment', -1, 5, ct.today())$q$) <> '23514' then
    raise exception 'F6 cash on a non-purchase credit entry'; end if;
  if (select (credits_recorded, credits_used, credit_purchase_cash) <> (15, 1, 12.00) from citation_credit_balances where provider = 'sample_provider') then
    raise exception 'F7 credit balance %', (select to_jsonb(b) from citation_credit_balances b where provider = 'sample_provider'); end if;
  if ct.err($q$update citation_credit_entries set credits = 99$q$) = '' then raise exception 'F8 credit ledger editable'; end if;
end $$;

-- ── Read models ──────────────────────────────────────────────────────────
do $$
begin
  insert into citation_listings (client_id, location_id, directory_id, listing_url) values
    ('c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a1', (select id from citation_directories where key = 'facebook'), 'https://facebook.com/sample.one'),
    ('c1000000-0000-4000-b000-00000000000a', 'c1000000-0000-4000-d000-0000000000a1', (select id from citation_directories where key = 'facebook'), 'https://facebook.com/sample.two');
  if (select count(*) from citation_listing_overview where directory_key = 'facebook' and suspected_duplicate) <> 2
    or (select count(*) from citation_listing_overview where directory_key = 'yelp' and suspected_duplicate) <> 2 then
    raise exception 'R1 suspected duplicates'; end if;
  if (select open_tasks from citation_listing_overview where external_id = 'BP-1') <> 0 then raise exception 'R2 open task count'; end if;
end $$;

-- ── Everyone else sees and writes nothing ────────────────────────────────
select ct.as_team('c1000000-0000-4000-a000-000000000003');
do $$
begin
  if exists (select 1 from citation_locations) or exists (select 1 from citation_listings) or exists (select 1 from citation_listing_overview)
    or exists (select 1 from citation_checks) or exists (select 1 from citation_tasks) or exists (select 1 from citation_imports)
    or exists (select 1 from citation_fulfillment_requests) or exists (select 1 from citation_credit_balances) or exists (select 1 from citation_directories) then
    raise exception 'N1 a non-team sign-in read citations'; end if;
  if ct.err($q$insert into citation_locations (client_id, label, business_name, hide_address) values ('c1000000-0000-4000-b000-00000000000a', 'Stranger', 'X', true)$q$) <> '42501' then
    raise exception 'N2 a non-team sign-in wrote'; end if;
  if ct.err($q$select citation_import('{"id": "c1000000-0000-4000-e000-0000000000ff", "client_id": "c1000000-0000-4000-b000-00000000000a", "provider": "x_csv", "file_sha256": "aaaa"}', '[]', '[]', true)$q$) <> '42501' then
    raise exception 'N3 a non-team sign-in imported'; end if;
end $$;
-- The client's own portal contact: still nothing (no portal view of citations in Phase 1).
select ct.as_team('c1000000-0000-4000-a000-000000000004');
do $$
begin
  if exists (select 1 from citation_locations) or exists (select 1 from citation_location_identities) or exists (select 1 from citation_listing_overview) then
    raise exception 'P1 the portal contact read citations (hidden addresses included)'; end if;
  if ct.err($q$update citation_listings set notes = 'x'$q$) not in ('', '42501') or exists (select 1 from citation_listings) then
    raise exception 'P2 the portal contact reached listings'; end if;
end $$;
reset role;
select set_config('role', 'anon', true);
do $$
begin
  if ct.err('select 1 from citation_locations') <> '42501' or ct.err('select 1 from citation_listing_overview') <> '42501' then raise exception 'A1 anon read citations'; end if;
end $$;
reset role;
rollback;
