-- 20261104200000: Controlled Claims Verification, PR2a (owner authority,
-- SHA-256 evidence, the decision ledger, the projection guard, registry v2).
-- Plain SQL, one transaction, rolled back: runs in scripts/test-portal-sandbox.sh
-- and in tests/claim-verification-database.test.mjs (PGlite). Fictional
-- clients and example.test hosts only (the repo is public).
--   L  one site: a warranty, an unverified warranty, a service, a rating, a
--      licence, a phone, an offer, a claim with no history; four locations
--   M  two brand sites (S, F): claims on S, one shared, a phone on S
--   X  another client (wrong-client evidence and locations)
--   Z  a client deleted at the end (cascade)
-- Callers, as they reach production:
--   owner    authenticator, role authenticated, the verification owner's JWT
--   admin2   the same, a second admin with no authority
--   member   the same, a member
--   function authenticator, role service_role (any service-role holder; the
--            claim-evidence function is the one that registers evidence)
--   worker   postgres (the worker's own SQL)
--   stranger a sign-in on no team row; anon
begin;
create schema cvt;
grant usage on schema cvt to anon, authenticated, service_role, authenticator, postgres;
create table cvt.saved (k text primary key, v text);
grant select, insert, update on cvt.saved to anon, authenticated, service_role, authenticator, postgres;
create function cvt.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function cvt.id(k text) returns uuid language sql immutable as $$ select md5('cvt:' || k)::uuid $$;
create function cvt.sha(k text) returns text language sql immutable as $$ select encode(sha256(convert_to('cvt-bytes:' || k, 'UTF8')), 'hex') $$;
create function cvt.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create function cvt.msg(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlerrm; end $$;
create function cvt.today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
create function cvt.jwt(who text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub',
    case who when 'owner' then 'c5700000-0000-4000-a000-000000000001' when 'admin2' then 'c5700000-0000-4000-a000-000000000002'
             when 'member' then 'c5700000-0000-4000-a000-000000000003' else 'c5700000-0000-4000-a000-000000000004' end)::text, true) $$;
-- Readers are VOLATILE plpgsql (never inlined) so a check sees writes made
-- earlier in the same statement.
create function cvt.reg(k text) returns jsonb language plpgsql volatile as $$ begin return claim_registry(cvt.id(k)); end $$;
create function cvt.claim(r jsonb, k text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(r->'claims') x where x->>'id' = cvt.id(k)::text $$;
create function cvt.c(ck text, k text) returns jsonb language plpgsql volatile as $$ begin return cvt.claim(cvt.reg(ck), k); end $$;
create function cvt.prog(r jsonb, slug text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(r->'programs') x where x->>'slug' = slug $$;
create function cvt.fp(k text) returns text language plpgsql volatile as $$
begin return (select claim_fingerprint(client_id, claim, source, kind) from claims where id = cvt.id(k)); end $$;
create function cvt.rid(k text) returns uuid language plpgsql volatile as $$ begin return (select review_id from claims where id = cvt.id(k)); end $$;
create function cvt.classify(k text, p_kind text) returns jsonb language sql as $$
  select claim_classify(cvt.id(k), p_kind, cvt.fp(k), cvt.rid(k)) $$;
create function cvt.verify(k text, p_method text, p_evidence text default null, p_location text default null,
                           p_action text default 'verify', p_excerpt text default 'The page says exactly this.',
                           p_observed date default null, p_expires date default null, p_contact text default null) returns jsonb
language sql as $$
  select claim_verify(cvt.id(k), p_action, p_method, p_excerpt, coalesce(p_observed, cvt.today()), cvt.fp(k), cvt.rid(k),
                      case when p_evidence is not null then cvt.id(p_evidence) end,
                      case when p_location is not null then cvt.id(p_location) end, p_expires, p_contact) $$;
create function cvt.revoke(k text, p_reason text) returns jsonb language sql as $$
  select claim_revoke(cvt.id(k), p_reason, cvt.fp(k), cvt.rid(k)) $$;
create function cvt.save(k text, v text) returns void language sql as $$
  insert into cvt.saved values (k, v) on conflict (k) do update set v = excluded.v $$;
create function cvt.get(p_k text) returns text language plpgsql volatile as $$ begin return (select v from cvt.saved where k = p_k); end $$;
create function cvt.reviews(k text) returns bigint language plpgsql volatile as $$ begin return (select count(*) from claim_reviews where claim_id = cvt.id(k)); end $$;
grant execute on all functions in schema cvt to anon, authenticated, service_role, authenticator, postgres;

-- Supabase's storage.objects carries a version (a new one on overwrite), and
-- hosted Storage (read Nov 5 2026) can version objects and expire them: the
-- columns it has, so the hardening is tested against them.
alter table storage.objects add column if not exists version text;
alter table storage.objects add column if not exists is_versioned boolean not null default false;
alter table storage.objects add column if not exists is_delete_marker boolean not null default false;
alter table storage.objects add column if not exists archived_at timestamptz;
alter table storage.buckets add column if not exists type text not null default 'STANDARD';
alter table storage.buckets add column if not exists versioning_status text not null default 'DISABLED';
alter table storage.buckets add column if not exists lifecycle_configuration jsonb;
alter table storage.buckets add column if not exists lifecycle_configuration_generation uuid;

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c5700000-0000-4000-a000-000000000001', 'cvt-owner@compassmarketing.ai'),
  ('c5700000-0000-4000-a000-000000000002', 'cvt-admin2@compassmarketing.ai'),
  ('c5700000-0000-4000-a000-000000000003', 'cvt-member@compassmarketing.ai'),
  ('c5700000-0000-4000-a000-000000000004', 'cvt-stranger@example.test');
insert into team_members (id, auth_user_id, name, email, role) values
  (cvt.id('owner'), 'c5700000-0000-4000-a000-000000000001', 'Cvt Owner', 'cvt-owner@compassmarketing.ai', 'admin'),
  (cvt.id('admin2'), 'c5700000-0000-4000-a000-000000000002', 'Cvt Admin Two', 'cvt-admin2@compassmarketing.ai', 'admin'),
  (cvt.id('member'), 'c5700000-0000-4000-a000-000000000003', 'Cvt Member', 'cvt-member@compassmarketing.ai', 'member');

set local session_replication_role = replica;
insert into clients (id, name, status, website_url, phone, state) values
  (cvt.id('L'), 'CVT Single Roofing (fictional)', 'active', 'https://cvt-l.example.test', '(555) 020-0001', 'MO'),
  (cvt.id('M'), 'CVT Multi Training (fictional)', 'active', 'https://cvt-m.example.test', '555-020-0002', 'MO'),
  (cvt.id('X'), 'CVT Other Client (fictional)', 'active', 'https://cvt-x.example.test', null, 'KS'),
  (cvt.id('Z'), 'CVT Deleted Client (fictional)', 'active', 'https://cvt-z.example.test', null, 'KS');
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on, created_at) values
  (cvt.id('L1'), cvt.id('L'), 'Cvt 3-Year Workmanship Warranty', 'confirmed', 'Contract excerpt supplied by the owner',
   'owner@cvt-l.example.test', now() - interval '10 days', now() - interval '40 days'),
  (cvt.id('L2'), cvt.id('L'), 'Cvt Lifetime Workmanship Warranty', 'unverified', 'https://cvt-l.example.test/warranty', null, null, now() - interval '60 days'),
  (cvt.id('L3'), cvt.id('L'), 'Cvt installs architectural shingles', 'sourced', 'https://cvt-l.example.test/services', null, null, now() - interval '50 days'),
  (cvt.id('L4'), cvt.id('L'), 'Cvt is rated 4.9 from 120 reviews', 'sourced', 'https://www.google.com/maps?cid=1', null, null, now() - interval '50 days'),
  (cvt.id('L5'), cvt.id('L'), 'Cvt holds state roofing licence R-12345', 'sourced', 'https://licensing.example.gov/r-12345', null, null, now() - interval '50 days'),
  (cvt.id('L6'), cvt.id('L'), 'Cvt north office line (555) 020-0777', 'sourced', 'https://www.google.com/maps?cid=2', null, null, now() - interval '50 days'),
  (cvt.id('L7'), cvt.id('L'), 'Cvt free roof inspections', 'confirmed', 'Confirmed by the owner on a call',
   'owner@cvt-l.example.test', now() - interval '20 days', now() - interval '30 days'),
  (cvt.id('L8'), cvt.id('L'), 'Cvt claim with no history', 'sourced', 'https://cvt-l.example.test/x', null, null, now() - interval '5 days'),
  (cvt.id('L9'), cvt.id('L'), 'Cvt west office line (555) 020-0888', 'sourced', 'https://www.google.com/maps?cid=3', null, null, now() - interval '5 days'),
  (cvt.id('M1'), cvt.id('M'), 'Cvt safety audits for every size of company', 'sourced', 'https://s.cvt-m.example.test/audits', null, null, now() - interval '20 days'),
  (cvt.id('M2'), cvt.id('M'), 'Cvt founded 2014', 'sourced', 'https://s.cvt-m.example.test/about', null, null, now() - interval '20 days'),
  (cvt.id('M3'), cvt.id('M'), 'Cvt safety line (555) 020-0002', 'sourced', 'https://s.cvt-m.example.test/contact', null, null, now() - interval '20 days'),
  (cvt.id('X1'), cvt.id('X'), 'Cvt other client fact', 'confirmed', 'Confirmed', 'x@example.test', now() - interval '5 days', now() - interval '5 days'),
  (cvt.id('Z1'), cvt.id('Z'), 'Cvt deleted client fact', 'confirmed', 'Confirmed', 'z@example.test', now() - interval '5 days', now() - interval '5 days');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, positioning, voice_tone, standing_cta,
                                     hard_rules, service_ids, claim_ids, asset_ids, status, approved_by, approved_at, created_at) values
  (cvt.id('ws-s'), cvt.id('M'), 'safety', 'Cvt Safety', 'https://s.cvt-m.example.test', '555-020-0002', 'Safety', 'Clear', 'Call',
   array['Sourced claims only'], '{}', array[cvt.id('M1'), cvt.id('M2'), cvt.id('M3')], '{}', 'approved', cvt.id('member'), now(), now() - interval '3 days'),
  (cvt.id('ws-f'), cvt.id('M'), 'forklift', 'Cvt Forklift', 'https://f.cvt-m.example.test', '555-020-0003', 'Forklift', 'Clear', 'Call',
   array['Sourced claims only'], '{}', array[cvt.id('M2')], '{}', 'approved', cvt.id('member'), now(), now() - interval '2 days');
-- An approved post standing on the rating claim, and a draft on the licence
-- claim: their approval and review hashes must survive every decision.
insert into social_posts (id, client_id, platform, search_intent, copy, review_status, publish_status, reviewed_by, reviewed_at,
                          review_note, approved_snapshot, approved_hash, created_at) values
  (cvt.id('P1'), cvt.id('L'), 'google_business', 'commercial', 'Cvt is rated 4.9 from 120 reviews.', 'approved', 'not_scheduled',
   cvt.id('member'), now() - interval '1 day', null, '{}', 'x', now() - interval '2 days');
insert into post_claims (post_id, client_id, claim_id) values (cvt.id('P1'), cvt.id('L'), cvt.id('L4'));
update social_posts set approved_snapshot = social_post_snapshot(social_posts) where id = cvt.id('P1');
update social_posts set approved_hash = social_post_hash(approved_snapshot) where id = cvt.id('P1');
insert into content_drafts (id, client_id, deliverable, topic, status, title, body_markdown, created_at)
values (cvt.id('D1'), cvt.id('L'), 'blog', 'Cvt licence', 'in_review', 'Why a licensed roofer matters', 'Cvt holds a state licence.', now() - interval '3 days');
insert into content_draft_claims (draft_id, client_id, claim_id) values (cvt.id('D1'), cvt.id('L'), cvt.id('L5'));
set local session_replication_role = origin;

-- Locations, through their own trigger (identity history, approver from the
-- session). North and west approved by the owner; south has no approver (no
-- session); east is archived; the Safety and Forklift ones are on their brand
-- sites; X's is another client's.
select cvt.jwt('owner');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone) values
  (cvt.id('loc-north'), cvt.id('L'), 'North office', 'CVT Single Roofing', '1 Cvt Way', 'Northtown', 'MO', '63000', '555.020.0777'),
  (cvt.id('loc-west'), cvt.id('L'), 'West office', 'CVT Single Roofing', '4 Cvt Way', 'Westtown', 'MO', '63003', '555.020.0999'),
  (cvt.id('loc-east'), cvt.id('L'), 'East office', 'CVT Single Roofing', '3 Cvt Way', 'Easttown', 'MO', '63002', '555.020.0888'),
  (cvt.id('loc-x'), cvt.id('X'), 'X office', 'CVT Other', '9 Cvt Way', 'Xtown', 'KS', '66000', '555.020.0777');
insert into citation_locations (id, client_id, brand_workspace_id, label, business_name, address_line1, city, region, postal_code, phone) values
  (cvt.id('loc-s'), cvt.id('M'), cvt.id('ws-s'), 'Safety office', 'CVT Safety', '5 Cvt Way', 'Safetown', 'MO', '63004', '555-020-0002'),
  (cvt.id('loc-f'), cvt.id('M'), cvt.id('ws-f'), 'Forklift office', 'CVT Forklift', '6 Cvt Way', 'Forktown', 'MO', '63005', '555-020-0002');
update citation_locations set status = 'archived' where id = cvt.id('loc-east');
select set_config('request.jwt.claims', '', true);
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone)
values (cvt.id('loc-south'), cvt.id('L'), 'South office', 'CVT Single Roofing', '2 Cvt Way', 'Southtown', 'MO', '63001', '555.020.0888');

-- ── B. Down and up while nothing is recorded ───────────────────────────────
select cvt.save('claims_before', (select md5(string_agg((to_jsonb(c) - 'review_id')::text, '|' order by c.id)) from claims c));
-- Migrations run as postgres, as apply_migration runs them.
set session authorization postgres;
\ir ../../rollback/20261104200000_claim_verification.down.sql
select cvt.ok('B1 down with nothing recorded: back to v1 (the lock, no ledger, no review_id)',
  to_regclass('public.claim_reviews') is null and to_regclass('public.claim_evidence') is null
  and to_regclass('public.claim_evidence_uploads') is null and to_regclass('public.claim_verification_authorities') is null
  and not exists (select 1 from information_schema.columns where table_name = 'claims' and column_name = 'review_id')
  and strpos(pg_get_functiondef('public.claims_registry_guard()'::regprocedure), 'locked until the verification workflow') > 0
  and strpos(pg_get_functiondef('public.claim_registry(uuid,date)'::regprocedure), 'claim-registry/v1') > 0);
\ir ../../migrations/20261104200000_claim_verification.sql
select cvt.ok('B2 up again: the migration re-applies (its verify block passes), no claim row changed, nobody holds authority',
  to_regclass('public.claim_reviews') is not null
  and (select md5(string_agg((to_jsonb(c) - 'review_id')::text, '|' order by c.id)) from claims c) = cvt.get('claims_before')
  and not exists (select 1 from claim_verification_authorities)
  and strpos(pg_get_functiondef('public.claim_registry(uuid,date)'::regprocedure), 'claim-registry/v2') > 0);
set session authorization supabase_admin;
insert into claim_verification_authorities (id, team_member_id, authority, basis)
values (cvt.id('auth-owner'), cvt.id('owner'), 'owner', 'Fixture: the verification owner');

-- A review row from an earlier transaction (written around the guards, as
-- only platform administration could): the projection must refuse it.
set local session_replication_role = replica;
insert into claim_reviews (id, client_id, claim_id, action, kind, claim_fingerprint, workspace_ids, reviewer_id, authority_id,
                           created_at, created_txid)
values (cvt.id('forged'), cvt.id('L'), cvt.id('L7'), 'classify', 'offering', repeat('a', 64), '{}', cvt.id('owner'),
        cvt.id('auth-owner'), now() - interval '1 day', 1);
set local session_replication_role = origin;

-- Evidence files as the storage service records them, each with the member's
-- upload request (a fixture: only a superuser writes one for someone else).
create function cvt.put(client_k text, k text, mime text default 'application/pdf') returns text language sql as $$
  insert into claim_evidence_uploads (id, client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
  values (cvt.id('upload-' || k), cvt.id(client_k), cvt.sha(k), 2048, mime, cvt.id('member'), now() + interval '1 hour');
  insert into storage.objects (id, bucket_id, name, metadata, version)
  values (cvt.id('obj-' || k), 'claim-evidence', cvt.id(client_k)::text || '/' || cvt.sha(k) || '.' || claim_evidence_ext(mime),
          jsonb_build_object('size', 2048, 'mimetype', mime, 'eTag', '"' || k || '"'), 'v-' || k)
  returning name $$;
select cvt.put('L', 'doc-contract'), cvt.put('L', 'doc-confirm'), cvt.put('L', 'cap-site', 'image/png'),
       cvt.put('L', 'cap-google', 'image/png'), cvt.put('L', 'cap-old', 'image/png'), cvt.put('L', 'cap-issuer'),
       cvt.put('L', 'cap-own-issuer'), cvt.put('L', 'doc-gone'), cvt.put('X', 'doc-x'), cvt.put('M', 'cap-s', 'image/webp'),
       cvt.put('M', 'cap-f', 'image/webp'), cvt.put('L', 'unregistered'), cvt.put('Z', 'doc-z');
-- Requests the register must refuse: expired, or for a size the storage did not record.
insert into claim_evidence_uploads (id, client_id, sha256, size_bytes, mime_type, requested_by, created_at, expires_at) values
  (cvt.id('upload-expired'), cvt.id('L'), cvt.sha('unregistered'), 2048, 'application/pdf', cvt.id('member'), now() - interval '2 hours', now() - interval '1 hour'),
  (cvt.id('upload-4096'), cvt.id('L'), cvt.sha('unregistered'), 4096, 'application/pdf', cvt.id('member'), now(), now() + interval '1 hour');


-- ── E7. Registering evidence (the service role's door, answering a request) ─
create function cvt.register(client_k text, k text, p_type text, p_mime text default 'application/pdf',
                             p_url text default null, p_captured date default null) returns uuid language sql as $$
  select (claim_evidence_register(cvt.id('upload-' || k), cvt.id(client_k)::text || '/' || cvt.sha(k) || '.' || claim_evidence_ext(p_mime),
                                  cvt.sha(k), 2048, p_mime, p_type, 'Cvt ' || k, k || '.file', p_url, p_captured)).id $$;
grant execute on function cvt.register(text, text, text, text, text, date) to service_role, authenticated;
set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.save('e7a', (cvt.register('L', 'doc-contract', 'document') is not null
  and cvt.register('L', 'cap-site', 'capture', 'image/png', 'https://www.cvt-l.example.test/services', cvt.today() - 2) is not null)::text);
select cvt.ok('E7a the service role registers a document and a capture at their content addresses, the uploader taken from the request',
  cvt.get('e7a') = 'true'
  and (select sha256 = cvt.sha('doc-contract') and size_bytes = 2048 and object_version = 'v-doc-contract'
              and object_etag = '"doc-contract"' and uploaded_by = cvt.id('member') and evidence_type = 'document'
              and upload_id = cvt.id('upload-doc-contract')
         from claim_evidence where sha256 = cvt.sha('doc-contract')));
-- Give the remaining files deterministic ids for the suite (registered the same way).
select cvt.register('L', 'doc-confirm', 'document'), cvt.register('L', 'doc-gone', 'document'),
       cvt.register('L', 'cap-google', 'capture', 'image/png', 'https://www.google.com/maps?cid=1', cvt.today() - 1),
       cvt.register('L', 'cap-old', 'capture', 'image/png', 'https://cvt-l.example.test/services', cvt.today() - 40),
       cvt.register('L', 'cap-issuer', 'capture', 'application/pdf', 'https://licensing.example.gov/verify?r=12345', cvt.today() - 1),
       cvt.register('L', 'cap-own-issuer', 'capture', 'application/pdf', 'https://cvt-l.example.test/licence', cvt.today() - 1),
       cvt.register('X', 'doc-x', 'document'),
       cvt.register('M', 'cap-s', 'capture', 'image/webp', 'https://s.cvt-m.example.test/audits', cvt.today()),
       cvt.register('M', 'cap-f', 'capture', 'image/webp', 'https://f.cvt-m.example.test/audits', cvt.today()),
       cvt.register('Z', 'doc-z', 'document');
reset role;
set session authorization supabase_admin;
-- The suite addresses evidence by key: map each key to its row id.
create table cvt.ev as select k, (select id from claim_evidence where sha256 = cvt.sha(k)) id
  from unnest(array['doc-contract', 'cap-site', 'doc-confirm', 'doc-gone', 'cap-google', 'cap-old', 'cap-issuer',
                    'cap-own-issuer', 'doc-x', 'cap-s', 'cap-f', 'doc-z']) k;
grant select on cvt.ev to anon, authenticated, service_role, authenticator, postgres;
create or replace function cvt.id(k text) returns uuid language sql stable as $$
  select coalesce((select id from cvt.ev where ev.k = $1), md5('cvt:' || $1)::uuid) $$;
grant execute on function cvt.id(text) to anon, authenticated, service_role, authenticator, postgres;

set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.ok('E7b the same bytes for the same client return the existing row',
  cvt.register('L', 'doc-contract', 'document') = cvt.id('doc-contract')
  and (select count(*) from claim_evidence where sha256 = cvt.sha('doc-contract')) = 1);
select cvt.ok('E7c refused: no such request, an expired one, a file other than the request named, a path that is not the content address, a size the storage did not record, a capture with no URL',
  cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-none'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.pdf', cvt.sha('unregistered'))) = 'P0002'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-expired'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.pdf', cvt.sha('unregistered'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 999, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-unregistered'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.pdf', cvt.sha('unregistered'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'image/png', 'document', 'x')$q$,
    cvt.id('upload-unregistered'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.png', cvt.sha('unregistered'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-unregistered'), cvt.id('L')::text || '/' || cvt.sha('doc-contract') || '.pdf', cvt.sha('doc-contract'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-unregistered'), cvt.id('L')::text || '/other.pdf', cvt.sha('unregistered'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 4096, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-4096'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.pdf', cvt.sha('unregistered'))) = '22023'
  and cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'capture', 'x')$q$,
    cvt.id('upload-unregistered'), cvt.id('L')::text || '/' || cvt.sha('unregistered') || '.pdf', cvt.sha('unregistered'))) = '22023'
  and not exists (select 1 from claim_evidence where sha256 = cvt.sha('unregistered')));
select cvt.ok('E7k the service role cannot write an upload request: neither directly nor through the teammate''s function',
  cvt.err(format($q$insert into claim_evidence_uploads (client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
                    values (%L, %L, 1, 'application/pdf', %L, now() + interval '1 day')$q$, cvt.id('L'), cvt.sha('forge'), cvt.id('owner'))) = '42501'
  and cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'application/pdf')$q$, cvt.id('L'), cvt.sha('forge'))) = '42501');
select cvt.ok('E7d the function cannot write the tables directly',
  cvt.err(format($q$insert into claim_evidence (client_id, evidence_type, label, storage_path, object_id, sha256, size_bytes, mime_type, uploaded_by)
                    values (%L, 'document', 'x', 'p', %L, %L, 1, 'application/pdf', %L)$q$,
                 cvt.id('L'), cvt.id('obj-unregistered'), cvt.sha('unregistered'), cvt.id('member'))) = '42501'
  and cvt.err(format($q$update claim_evidence set label = 'y' where id = %L$q$, cvt.id('doc-contract'))) = '42501'
  and cvt.err(format($q$insert into claim_reviews (client_id, claim_id, action, kind, claim_fingerprint, reviewer_id, authority_id)
                    values (%L, %L, 'classify', 'offering', %L, %L, %L)$q$,
                 cvt.id('L'), cvt.id('L7'), repeat('a', 64), cvt.id('owner'), cvt.id('auth-owner'))) = '42501'
  and cvt.err(format($q$insert into claim_verification_authorities (team_member_id, authority, basis) values (%L, 'owner', 'x')$q$, cvt.id('admin2'))) = '42501');
select cvt.ok('E7e … nor classify, verify or revoke',
  cvt.err(format($q$select claim_classify(%L, 'offering', %L, null)$q$, cvt.id('L7'), cvt.fp('L7'))) = '42501'
  and cvt.err(format($q$update claims set kind = 'offering' where id = %L$q$, cvt.id('L7'))) = '42501');
reset role;
set session authorization supabase_admin;
select cvt.ok('E7f storage refuses overwriting, renaming or deleting a registered file; an unregistered one may be deleted',
  cvt.err(format($q$update storage.objects set version = 'v2' where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$update storage.objects set name = 'elsewhere.pdf' where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$delete from storage.objects where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$delete from storage.objects where id = %L$q$, cvt.id('obj-unregistered'))) = ''
  and cvt.err(format($q$update claim_evidence set label = 'y' where id = %L$q$, cvt.id('doc-contract'))) = '42501'
  and cvt.err(format($q$delete from claim_evidence where id = %L$q$, cvt.id('doc-contract'))) = '42501'
  and cvt.err(format($q$update claim_evidence_uploads set requested_by = %L where id = %L$q$, cvt.id('owner'), cvt.id('upload-doc-contract'))) = '42501'
  and cvt.err(format($q$delete from claim_evidence_uploads where id = %L$q$, cvt.id('upload-unregistered'))) = '42501');

-- ── H. Hosted Storage versioning, archival and lifecycle (ChatGPT's 2nd review)
-- Another bucket, to prove ordinary Storage behaviour is untouched.
insert into storage.buckets (id, name) values ('cvt-other', 'cvt-other');
insert into storage.objects (id, bucket_id, name, metadata, version)
values (cvt.id('obj-other'), 'cvt-other', 'x/other.pdf', '{"size": 10, "mimetype": "application/pdf", "eTag": "\"o\""}', 'v-o');
select cvt.ok('H1 a registered file is never archived, marked deleted, re-flagged, given new metadata or a second row at its name; other buckets are untouched',
  cvt.err(format($q$update storage.objects set archived_at = now() where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$update storage.objects set is_delete_marker = true where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$update storage.objects set is_versioned = true where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$update storage.objects set metadata = metadata || '{"size": 4096}' where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$update storage.objects set metadata = metadata || '{"eTag": "\"forged\""}' where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501'
  and cvt.err(format($q$insert into storage.objects (bucket_id, name, metadata, version, is_versioned)
                        values ('claim-evidence', %L, '{"size": 2048, "mimetype": "application/pdf"}', 'v-second', true)$q$,
                     cvt.id('L')::text || '/' || cvt.sha('doc-contract') || '.pdf')) = '42501'
  and cvt.err(format($q$update storage.objects set archived_at = now(), is_delete_marker = true, version = 'v-o2' where id = %L$q$, cvt.id('obj-other'))) = ''
  and cvt.err($q$insert into storage.objects (bucket_id, name, metadata) values ('cvt-other', 'x/other.pdf', '{}')$q$) = ''
  and cvt.err(format($q$update storage.objects set owner = null where id = %L$q$, cvt.id('obj-doc-contract'))) = ''
  and (select claim_evidence_intact(e) from claim_evidence e where id = cvt.id('doc-contract')));
set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.ok('H2 the service role (every Storage API call with the key) cannot change the claim-evidence bucket''s settings; another bucket''s it can',
  cvt.err($q$update storage.buckets set versioning_status = 'ENABLED' where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set lifecycle_configuration = '{"rules": []}', lifecycle_configuration_generation = gen_random_uuid() where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set public = true where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set allowed_mime_types = null where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set file_size_limit = 104857600 where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$delete from storage.buckets where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set versioning_status = 'ENABLED' where id = 'cvt-other'$q$) = ''
  and (select versioning_status = 'DISABLED' and lifecycle_configuration is null and not public from storage.buckets where id = 'claim-evidence'));
reset role;
set session authorization supabase_admin;
-- pglite:skip-begin (PGlite's postgres is a superuser, the database owner's bypass)
set session authorization postgres;
select cvt.ok('H3 the worker''s own SQL cannot change the bucket''s settings or archive a registered file either',
  cvt.err($q$update storage.buckets set versioning_status = 'ENABLED' where id = 'claim-evidence'$q$) = '42501'
  and cvt.err($q$update storage.buckets set public = true where id = 'claim-evidence'$q$) = '42501'
  and cvt.err(format($q$update storage.objects set archived_at = now() where id = %L$q$, cvt.id('obj-doc-contract'))) = '42501');
set session authorization supabase_admin;
-- pglite:skip-end
-- Fail closed: if the bucket were ever versioned (platform administration can
-- still change the row), nothing new registers and registered files stay
-- protected. Restored straight after.
insert into claim_evidence_uploads (id, client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
values (cvt.id('upload-h4'), cvt.id('L'), cvt.sha('h4'), 2048, 'application/pdf', cvt.id('member'), now() + interval '1 hour'),
       (cvt.id('upload-h5'), cvt.id('L'), cvt.sha('h5'), 2048, 'application/pdf', cvt.id('member'), now() + interval '1 hour');
insert into storage.objects (id, bucket_id, name, metadata, version) values
  (cvt.id('obj-h4'), 'claim-evidence', cvt.id('L')::text || '/' || cvt.sha('h4') || '.pdf', '{"size": 2048, "mimetype": "application/pdf"}', 'v-h4'),
  (cvt.id('obj-h5a'), 'claim-evidence', cvt.id('L')::text || '/' || cvt.sha('h5') || '.pdf', '{"size": 2048, "mimetype": "application/pdf"}', 'v-h5a'),
  (cvt.id('obj-h5b'), 'claim-evidence', cvt.id('L')::text || '/' || cvt.sha('h5') || '.pdf', '{"size": 2048, "mimetype": "application/pdf"}', 'v-h5b');
update storage.buckets set versioning_status = 'ENABLED' where id = 'claim-evidence';
select cvt.save('h4_archive', cvt.err(format($q$update storage.objects set archived_at = now() where id = %L$q$, cvt.id('obj-doc-contract'))));
select cvt.save('h4_intact', (select claim_evidence_intact(e) from claim_evidence e where id = cvt.id('doc-contract'))::text);
set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.save('h4_register', cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
  cvt.id('upload-h4'), cvt.id('L')::text || '/' || cvt.sha('h4') || '.pdf', cvt.sha('h4'))));
reset role;
set session authorization supabase_admin;
update storage.buckets set versioning_status = 'DISABLED' where id = 'claim-evidence';
set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.ok('H4 a versioned bucket fails closed: nothing new registers, and a registered file still cannot be archived; it stays intact',
  cvt.get('h4_register') = '42501' and cvt.get('h4_archive') = '42501' and cvt.get('h4_intact') = 'true'
  and (select claim_evidence_intact(e) from claim_evidence e where id = cvt.id('doc-contract'))
  and not exists (select 1 from claim_evidence where sha256 = cvt.sha('h4')));
select cvt.ok('H5 two stored objects at one name: nothing registers',
  cvt.err(format($q$select claim_evidence_register(%L, %L, %L, 2048, 'application/pdf', 'document', 'x')$q$,
    cvt.id('upload-h5'), cvt.id('L')::text || '/' || cvt.sha('h5') || '.pdf', cvt.sha('h5'))) = '22023');
reset role;
set session authorization supabase_admin;
-- The fixtures H4 and H5 used are not evidence; remove them (unregistered).
delete from storage.objects where id in (cvt.id('obj-h4'), cvt.id('obj-h5a'), cvt.id('obj-h5b'), cvt.id('obj-other'));
delete from storage.objects where bucket_id = 'cvt-other';
delete from storage.buckets where id = 'cvt-other';

-- ── E7g. Upload requests: only from the teammate's own signed-in session ────
-- A fictional file for client X, stored as the storage service records it.
insert into storage.objects (id, bucket_id, name, metadata, version)
values (cvt.id('obj-req-new'), 'claim-evidence', cvt.id('X')::text || '/' || cvt.sha('req-new') || '.png',
        jsonb_build_object('size', 4096, 'mimetype', 'image/png', 'eTag', '"req-new"'), 'v-req-new');
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('member');
select cvt.save('up-member', claim_evidence_request_upload(cvt.id('X'), cvt.sha('req-new'), 4096, 'image/png')::text);
select cvt.ok('E7g a teammate''s own session records an upload request: the requester is the caller, valid for an hour; nothing else writes or changes one',
  (select requested_by = cvt.id('member') and client_id = cvt.id('X') and size_bytes = 4096 and mime_type = 'image/png'
          and expires_at between now() + interval '59 minutes' and now() + interval '61 minutes'
     from claim_evidence_uploads where id = cvt.get('up-member')::uuid)
  and cvt.err(format($q$insert into claim_evidence_uploads (client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
                    values (%L, %L, 1, 'application/pdf', %L, now() + interval '1 day')$q$, cvt.id('X'), cvt.sha('forge'), cvt.id('owner'))) = '42501'
  and cvt.err(format($q$update claim_evidence_uploads set requested_by = %L where id = %L$q$, cvt.id('owner'), cvt.get('up-member'))) = '42501'
  and cvt.err(format($q$select claim_evidence_request_upload(%L, 'abc', 1, 'application/pdf')$q$, cvt.id('X'))) = '22023'
  and cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'text/html')$q$, cvt.id('X'), cvt.sha('x'))) = '22023'
  and cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'application/pdf')$q$, cvt.id('upload-none'), cvt.sha('x'))) = 'P0002');
select cvt.jwt('stranger');
select cvt.ok('E7h a sign-in on no team row cannot ask to upload',
  cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'application/pdf')$q$, cvt.id('X'), cvt.sha('forge'))) = '42501');
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select cvt.ok('E7l anon cannot ask to upload or read the requests',
  cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'application/pdf')$q$, cvt.id('X'), cvt.sha('forge'))) = '42501'
  and cvt.err('select * from claim_evidence_uploads') = '42501');
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select cvt.save('ev-req-new', (claim_evidence_register(cvt.get('up-member')::uuid, cvt.id('X')::text || '/' || cvt.sha('req-new') || '.png',
  cvt.sha('req-new'), 4096, 'image/png', 'capture', 'Cvt listing capture', 'listing.png', 'https://listing.example.test/x', cvt.today())).id::text);
select cvt.ok('E7i the service role registers against the member''s request: the uploader is the member, and a retry returns the same row',
  (select uploaded_by = cvt.id('member') and upload_id = cvt.get('up-member')::uuid and client_id = cvt.id('X')
     from claim_evidence where id = cvt.get('ev-req-new')::uuid)
  and (claim_evidence_register(cvt.get('up-member')::uuid, cvt.id('X')::text || '/' || cvt.sha('req-new') || '.png',
         cvt.sha('req-new'), 4096, 'image/png', 'capture', 'Again', null, 'https://listing.example.test/x', cvt.today())).id::text = cvt.get('ev-req-new'));
reset role;
set session authorization supabase_admin;
-- pglite:skip-begin (PGlite's postgres is a superuser, the database owner's bypass)
set session authorization postgres;
select cvt.ok('E7j the worker''s own SQL cannot write an upload request, directly or through the function',
  cvt.err(format($q$insert into claim_evidence_uploads (client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
                    values (%L, %L, 1, 'application/pdf', %L, now() + interval '1 day')$q$, cvt.id('X'), cvt.sha('forge'), cvt.id('owner'))) = '42501'
  and cvt.err(format($q$select claim_evidence_request_upload(%L, %L, 1, 'application/pdf')$q$, cvt.id('X'), cvt.sha('forge'))) = '42501');
set session authorization supabase_admin;
-- pglite:skip-end

-- ── S. Who may decide ───────────────────────────────────────────────────────
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.save('post_hash', (select approved_hash from social_posts where id = cvt.id('P1')));
select cvt.save('draft_hash', (select content_draft_review_hash(d) from content_drafts d where id = cvt.id('D1')));
select cvt.save('legacy', (select string_agg(x->>'id' || ':' || (x->>'legacy_usable'), ',' order by x->>'id') from jsonb_array_elements(cvt.reg('L')->'claims') x));
select cvt.save('governed', (select md5(string_agg(concat_ws('|', id, status, source, confirmed_by, confirmed_on), ',' order by id)) from claims));
do $$
declare r jsonb := cvt.reg('L');
begin
  perform cvt.ok('S0 registry v2 for the owner: can review, names the owner, lists the evidence and the approved locations',
    r->>'version' = 'claim-registry/v2' and (r->'viewer'->>'can_review')::boolean and r->>'verification_owner' = 'Cvt Owner'
    and jsonb_array_length(r->'evidence') = 8
    and (select bool_and((x->>'intact')::boolean) from jsonb_array_elements(r->'evidence') x)
    and (select string_agg(x->>'label', ',' order by x->>'label') from jsonb_array_elements(r->'locations') x) = 'North office,West office'
    and cvt.claim(r, 'L3')->>'fingerprint' = cvt.fp('L3') and cvt.claim(r, 'L3')->'review_id' = 'null'::jsonb
    and (r->'totals'->>'verified')::int = 0);
end $$;
select cvt.ok('S1 the owner classifies a claim; the registry shows the kind and the decision',
  (cvt.classify('L3', 'service_description')->>'action') = 'classify'
  and cvt.c('L', 'L3')->>'kind' = 'service_description' and cvt.c('L', 'L3')->'verification'->'last_decision'->>'action' = 'classify'
  and cvt.c('L', 'L3')->'verification'->'last_decision'->>'by' = 'Cvt Owner' and cvt.reviews('L3') = 1);
select cvt.jwt('admin2');
select cvt.ok('S2 a second admin with no authority is refused by every writer, and the registry offers no controls',
  cvt.err($$select cvt.classify('L4', 'rating_review')$$) = '42501'
  and cvt.err($$select cvt.verify('L3', 'client_published', 'cap-site')$$) = '42501'
  and cvt.err($$select cvt.revoke('L3', 'no reason')$$) = '42501'
  and not (cvt.reg('L')->'viewer'->>'can_review')::boolean and cvt.reg('L')->>'verification_owner' = 'Cvt Owner'
  and cvt.msg($$select cvt.classify('L4', 'rating_review')$$) like 'Only the verification owner%');
select cvt.jwt('member');
select cvt.ok('S3 a member is refused too',
  cvt.err($$select cvt.classify('L4', 'rating_review')$$) = '42501' and not (cvt.reg('L')->'viewer'->>'can_review')::boolean);
select cvt.jwt('stranger');
select cvt.ok('S4 a sign-in on no team row is refused (and reads nothing)',
  cvt.err(format($q$select claim_classify(%L, 'rating_review', 'x', null)$q$, cvt.id('L4'))) = '42501'
  and not exists (select 1 from claim_reviews) and not exists (select 1 from claim_evidence));
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select cvt.ok('S5 anon cannot call a writer or read the ledger, the evidence or the authority',
  cvt.err(format($q$select claim_classify(%L, 'rating_review', 'x', null)$q$, cvt.id('L4'))) = '42501'
  and cvt.err('select * from claim_reviews') = '42501' and cvt.err('select * from claim_evidence') = '42501'
  and cvt.err('select * from claim_verification_authorities') = '42501');
set local role authenticated;
select cvt.jwt('owner');
select cvt.ok('S6 direct writes to the projection are refused even for the owner',
  cvt.err(format($q$update claims set kind = 'offering' where id = %L$q$, cvt.id('L7'))) = '42501'
  and cvt.err(format($q$update claims set verification_method = 'client_published', verified_at = now() where id = %L$q$, cvt.id('L3'))) = '42501'
  and cvt.err(format($q$update claims set review_by = current_date + 9 where id = %L$q$, cvt.id('L3'))) = '42501'
  and cvt.err(format($q$insert into claims (client_id, claim, status, source, kind) values (%L, 'x', 'sourced', 'y', 'offering')$q$, cvt.id('L'))) = '42501');
select cvt.ok('S7 a forged review_id is refused: another claim''s review, or an earlier transaction''s',
  cvt.err(format($q$update claims set review_id = %L, kind = 'service_description' where id = %L$q$, cvt.rid('L3'), cvt.id('L7'))) = '42501'
  and cvt.err(format($q$update claims set review_id = null, kind = null where id = %L$q$, cvt.id('L3'))) = '42501'
  and cvt.err(format($q$update claims set review_id = %L, kind = 'offering' where id = %L$q$, cvt.id('forged'), cvt.id('L7'))) = '42501');
select cvt.ok('S8 the ledger, evidence and authority tables refuse the owner''s direct writes',
  cvt.err(format($q$insert into claim_reviews (client_id, claim_id, action, kind, claim_fingerprint, reviewer_id, authority_id)
                    values (%L, %L, 'classify', 'offering', %L, %L, %L)$q$,
                 cvt.id('L'), cvt.id('L7'), repeat('a', 64), cvt.id('owner'), cvt.id('auth-owner'))) = '42501'
  and cvt.err(format($q$update claim_reviews set note = 'x' where claim_id = %L$q$, cvt.id('L3'))) = '42501'
  and cvt.err(format($q$delete from claim_reviews where claim_id = %L$q$, cvt.id('L3'))) = '42501'
  and cvt.err(format($q$delete from claim_evidence where id = %L$q$, cvt.id('doc-contract'))) = '42501'
  and cvt.err(format($q$update claim_verification_authorities set basis = 'x' where id = %L$q$, cvt.id('auth-owner'))) = '42501'
  and cvt.err(format($q$insert into claim_verification_authorities (team_member_id, authority, basis) values (%L, 'owner', 'x')$q$, cvt.id('admin2'))) = '42501');
select cvt.save('reviews_before_stale', (select count(*)::text from claim_reviews));
select cvt.ok('S9 a stale screen is refused (CV409) and writes nothing: an old fingerprint, or an old review in force',
  cvt.err(format($q$select claim_classify(%L, 'offering', %L, null)$q$, cvt.id('L7'), repeat('0', 64))) = 'CV409'
  and cvt.err(format($q$select claim_classify(%L, 'offering', %L, null)$q$, cvt.id('L3'), cvt.fp('L3'))) = 'CV409'
  and cvt.err(format($q$select claim_verify(%L, 'verify', 'client_published', 'x', current_date, %L, null, %L)$q$,
                     cvt.id('L3'), cvt.fp('L3'), cvt.id('cap-site'))) = 'CV409'
  and (select count(*)::text from claim_reviews) = cvt.get('reviews_before_stale'));
reset role;
set session authorization supabase_admin;
update claim_verification_authorities set revoked_at = now(), revoke_reason = 'Fixture: authority revoked' where id = cvt.id('auth-owner');
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.ok('S10 a revoked authority decides nothing',
  cvt.err($$select cvt.classify('L4', 'rating_review')$$) = '42501' and not (cvt.reg('L')->'viewer'->>'can_review')::boolean);
reset role;
set session authorization supabase_admin;
select cvt.ok('S11 one active owner at a time, even for a superuser grant',
  cvt.err(format($q$insert into claim_verification_authorities (team_member_id, authority, basis) values (%L, 'owner', 'x'), (%L, 'owner', 'y')$q$,
                 cvt.id('owner'), cvt.id('admin2'))) = '23505');
insert into claim_verification_authorities (id, team_member_id, authority, basis)
values (cvt.id('auth-owner-2'), cvt.id('owner'), 'owner', 'Fixture: granted again');
-- pglite:skip-begin (PGlite's postgres is a superuser, the database owner's bypass)
set session authorization postgres;
select cvt.ok('S12 the worker''s own SQL cannot decide, write the ledger or move the projection',
  cvt.err($$select cvt.classify('L4', 'rating_review')$$) = '42501'
  and cvt.err(format($q$insert into claim_reviews (client_id, claim_id, action, kind, claim_fingerprint, reviewer_id, authority_id)
                    values (%L, %L, 'classify', 'offering', %L, %L, %L)$q$,
                 cvt.id('L'), cvt.id('L7'), repeat('a', 64), cvt.id('owner'), cvt.id('auth-owner-2'))) = '42501'
  and cvt.err(format($q$update claims set kind = 'offering' where id = %L$q$, cvt.id('L7'))) = '42501'
  and cvt.err(format($q$insert into claim_verification_authorities (team_member_id, authority, basis) values (%L, 'owner', 'x')$q$, cvt.id('admin2'))) = '42501');
set session authorization supabase_admin;
-- pglite:skip-end

-- ── E. Evidence rules ───────────────────────────────────────────────────────
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.ok('E1 an unclassified claim and a method that does not settle the kind are refused',
  cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract')$$) = '22023'
  and (cvt.classify('L1', 'warranty_guarantee')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L1', 'client_published', 'cap-site')$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'third_party', 'doc-contract')$$) = '22023');
select cvt.ok('E2 evidence: another client''s file (42501); a capture for a contract; a document for a published page',
  cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-x')$$) = '42501'
  and cvt.err($$select cvt.verify('L1', 'client_contract', 'cap-site')$$) = '22023'
  and cvt.err($$select cvt.verify('L3', 'client_published', 'doc-contract')$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'client_contract')$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract', 'loc-north')$$) = '22023');
reset role;
set session authorization supabase_admin;
set local session_replication_role = replica;
delete from storage.objects where id = cvt.id('obj-doc-gone');
set local session_replication_role = origin;
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.ok('E2b a file whose stored object is gone is refused, and the registry flags it',
  cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-gone')$$) = '22023'
  and (select not (x->>'intact')::boolean from jsonb_array_elements(cvt.reg('L')->'evidence') x where x->>'id' = cvt.id('doc-gone')::text));
select cvt.ok('E3 locations: archived, no approver, another client (42501), a phone that differs; another brand site (42501)',
  (cvt.classify('L6', 'contact_identity')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L6', 'structured_record', null, 'loc-east')$$) = '22023'
  and cvt.err($$select cvt.verify('L6', 'structured_record', null, 'loc-south')$$) = '22023'
  and cvt.err($$select cvt.verify('L6', 'structured_record', null, 'loc-x')$$) = '42501'
  and cvt.err($$select cvt.verify('L6', 'structured_record', null, 'loc-west')$$) = '22023'
  and cvt.err($$select cvt.verify('L6', 'structured_record', 'doc-contract')$$) = '22023'
  and (cvt.classify('M3', 'contact_identity')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('M3', 'structured_record', null, 'loc-f')$$) = '42501'
  and cvt.msg($$select cvt.verify('M3', 'structured_record', null, 'loc-f')$$) like '%another brand site%');
select cvt.ok('E4 captures: a published page on a third-party host, a capture over 30 days old, another brand site''s page; the client''s own site as an issuer or platform',
  cvt.err($$select cvt.verify('L3', 'client_published', 'cap-google')$$) = '22023'
  and cvt.err($$select cvt.verify('L3', 'client_published', 'cap-old')$$) = '22023'
  and (cvt.classify('M1', 'service_description')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('M1', 'client_published', 'cap-f')$$) = '22023'
  and (cvt.classify('L5', 'credential')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L5', 'issuer_record', 'cap-own-issuer')$$) = '22023'
  and (cvt.classify('L4', 'rating_review')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L4', 'platform_record', 'cap-site')$$) = '22023');
select cvt.ok('E5 an excerpt, a day examined (not future), an expiry after today, a named contact for a confirmation',
  cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract', p_excerpt => '  ')$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract', p_observed => cvt.today() + 1)$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract', p_expires => cvt.today())$$) = '22023'
  and (cvt.classify('L7', 'offering')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L7', 'client_confirmation', 'doc-confirm')$$) = '22023'
  and cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract', p_contact => 'Pat')$$) = '22023');
select cvt.ok('E6 an unverified claim may be classified but never verified (D4)',
  (cvt.classify('L2', 'warranty_guarantee')->>'action') = 'classify'
  and cvt.err($$select cvt.verify('L2', 'client_contract', 'doc-contract')$$) = '22023'
  and (select status::text from claims where id = cvt.id('L2')) = 'unverified'
  and cvt.c('L', 'L2')->>'bucket' = 'unverified');

-- ── V. Decisions that pass, and what the registry makes of them ────────────
select cvt.ok('V1 a contract verifies the warranty: verified, independently, with its pinned file',
  (cvt.verify('L1', 'client_contract', 'doc-contract', p_excerpt => 'Workmanship is warranted for three (3) years',
              p_expires => cvt.today() + 200)->>'evidence_sha256') = cvt.sha('doc-contract')
  and cvt.c('L', 'L1')->>'bucket' = 'verified' and cvt.c('L', 'L1')->>'verification_state' = 'independently_verified'
  and cvt.c('L', 'L1')->'verification'->>'verified_by_name' = 'Cvt Owner'
  and cvt.c('L', 'L1')->'verification'->'record'->'evidence'->>'sha256' = cvt.sha('doc-contract')
  and (cvt.c('L', 'L1')->'verification'->'record'->'evidence'->>'intact')::boolean
  and cvt.c('L', 'L1')->'verification'->'record'->>'excerpt' = 'Workmanship is warranted for three (3) years'
  and cvt.c('L', 'L1')->'freshness'->>'review_by' = (cvt.today() + 200)::text
  and (select status::text from claims where id = cvt.id('L1')) = 'confirmed');
select cvt.ok('V2 verify once, then re-review; verifying again is refused',
  cvt.err($$select cvt.verify('L1', 'client_contract', 'doc-contract')$$) = '22023'
  and (cvt.verify('L1', 'client_contract', 'doc-contract', p_action => 'review', p_expires => cvt.today() + 200)->>'action') = 'review'
  and cvt.c('L', 'L1')->>'bucket' = 'verified' and cvt.c('L', 'L1')->'verification'->'record'->>'action' = 'review'
  and cvt.err($$select cvt.revoke('L3', 'nothing in force')$$) = '22023'
  and cvt.err($$select cvt.verify('L3', 'client_published', 'cap-site', p_action => 'review')$$) = '22023');
select cvt.ok('V3 a platform capture verifies the rating; an expiry within 14 days → due',
  (cvt.verify('L4', 'platform_record', 'cap-google', p_excerpt => '4.9 stars, 120 reviews', p_expires => cvt.today() + 5)->>'action') = 'verify'
  and cvt.c('L', 'L4')->>'bucket' = 'due' and (cvt.c('L', 'L4')->'freshness'->>'days_left')::int = 5);
select cvt.ok('V4 past the expiry → stale, and evidence_expired',
  cvt.claim(claim_registry(cvt.id('L'), cvt.today() + 201), 'L1')->>'bucket' = 'stale'
  and cvt.claim(claim_registry(cvt.id('L'), cvt.today() + 201), 'L1')->'reasons' ? 'evidence_expired');
select cvt.ok('V5 a phone claim verifies against its approved location, pinned to the identity version',
  (cvt.verify('L6', 'structured_record', null, 'loc-north', p_excerpt => 'Approved phone 555.020.0777')->>'location_identity_version') = '1'
  and cvt.c('L', 'L6')->>'bucket' = 'verified'
  and cvt.c('L', 'L6')->'verification'->'record'->'location'->>'label' = 'North office');
select cvt.ok('V5b the location''s identity is pinned by SHA-256',
  (select location_identity_sha256 ~ '^[0-9a-f]{64}$' and location_identity_version = 1 from claim_reviews where id = cvt.rid('L6')));
select cvt.ok('V6 an issuer capture verifies the licence; a published page verifies the service; a signed confirmation verifies the offer',
  (cvt.verify('L5', 'issuer_record', 'cap-issuer', p_excerpt => 'Licence R-12345: active')->>'action') = 'verify'
  and (cvt.verify('L3', 'client_published', 'cap-site', p_excerpt => 'We install architectural shingles')->>'action') = 'verify'
  and (cvt.verify('L7', 'client_confirmation', 'doc-confirm', p_contact => 'Pat Owner (fictional)')->>'action') = 'verify'
  and cvt.c('L', 'L5')->>'bucket' = 'verified' and cvt.c('L', 'L3')->>'bucket' = 'verified' and cvt.c('L', 'L7')->>'bucket' = 'verified'
  and cvt.c('L', 'L7')->'verification'->'record'->>'confirmed_by_contact' = 'Pat Owner (fictional)');
do $$
declare r jsonb; s jsonb; f jsonb;
begin
  perform cvt.verify('M1', 'client_published', 'cap-s', p_excerpt => 'Safety audits for companies of every size');
  perform cvt.verify('M3', 'structured_record', null, 'loc-s', p_excerpt => 'Approved phone 555-020-0002');
  r := cvt.reg('M'); s := cvt.prog(r, 'safety'); f := cvt.prog(r, 'forklift');
  perform cvt.ok('V7 BHG: a Safety claim verifies with the Safety page and the Safety location; per-site counts follow',
    cvt.claim(r, 'M1')->>'bucket' = 'verified' and cvt.claim(r, 'M3')->>'bucket' = 'verified'
    and (s->'counts'->>'verified')::int = 2 and (f->'counts'->>'verified')::int = 0
    and (select workspace_ids = array[cvt.id('ws-s')] from claim_reviews where id = cvt.rid('M1')));
end $$;
select cvt.ok('V8 nothing a post or draft may cite moved: statuses, sources and legacy usability, the post''s approval and the draft''s hash',
  (select string_agg(x->>'id' || ':' || (x->>'legacy_usable'), ',' order by x->>'id') from jsonb_array_elements(cvt.reg('L')->'claims') x) = cvt.get('legacy')
  and (select md5(string_agg(concat_ws('|', id, status, source, confirmed_by, confirmed_on), ',' order by id)) from claims) = cvt.get('governed')
  and (select approved_hash = cvt.get('post_hash') and review_status = 'approved' from social_posts where id = cvt.id('P1'))
  and (select content_draft_review_hash(d) = cvt.get('draft_hash') from content_drafts d where id = cvt.id('D1')));

-- ── R. Integrity and the other decisions ───────────────────────────────────
update claims set claim = 'Cvt 3-Year Workmanship Warranty (edited)' where id = cvt.id('L1');
select cvt.ok('R1 editing a verified claim asks for review at once (fingerprint)',
  cvt.c('L', 'L1')->>'bucket' = 'needs_review' and cvt.c('L', 'L1')->'reasons' ? 'changed_since_verified'
  and cvt.c('L', 'L1')->>'verification_state' = 'not_independently_verified');
reset role;
set session authorization supabase_admin;
set local session_replication_role = replica;
delete from storage.objects where id = cvt.id('obj-cap-google');
set local session_replication_role = origin;
select cvt.jwt('owner');
update citation_locations set phone = '555.020.0770', identity_note = 'Fixture: new number' where id = cvt.id('loc-north');
select set_config('request.jwt.claims', '', true);
update client_brand_workspaces set claim_ids = array[cvt.id('M2'), cvt.id('M3')] where id = cvt.id('ws-s');
update client_brand_workspaces set claim_ids = array[cvt.id('M1'), cvt.id('M2')] where id = cvt.id('ws-f');
update claims set verification_method = 'client_contract', verified_at = now() where id = cvt.id('L9');
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.ok('R2 a lost file, a re-approved location and a moved brand site each drop a verified claim to needs review',
  cvt.c('L', 'L4')->>'bucket' = 'needs_review' and cvt.c('L', 'L4')->'reasons' ? 'evidence_file_changed'
  and not (cvt.c('L', 'L4')->'verification'->'record'->'evidence'->>'intact')::boolean
  and cvt.c('L', 'L6')->>'bucket' = 'needs_review' and cvt.c('L', 'L6')->'reasons' ? 'evidence_location_changed'
  and cvt.c('M', 'M1')->>'bucket' = 'needs_review' and cvt.c('M', 'M1')->'reasons' ? 'scope_changed_since_verified');
select cvt.ok('R3 verification columns written outside the ledger are never independent verification',
  cvt.c('L', 'L9')->>'bucket' = 'needs_review' and cvt.c('L', 'L9')->'reasons' ? 'verification_unrecorded'
  and cvt.c('L', 'L9')->>'verification_state' = 'not_independently_verified');
select cvt.ok('R4 re-classifying clears the verification; revoking keeps the kind and says why',
  (cvt.classify('L7', 'experience_stat')->>'cleared_verification')::boolean
  and cvt.c('L', 'L7')->>'bucket' = 'needs_review' and cvt.c('L', 'L7')->'verification'->'verified_at' = 'null'::jsonb
  and (cvt.revoke('L5', 'Licence lapsed at the issuer')->>'action') = 'revoke'
  and cvt.c('L', 'L5')->>'kind' = 'credential' and cvt.c('L', 'L5')->>'bucket' = 'needs_review'
  and cvt.c('L', 'L5')->'verification'->'last_decision'->>'reason' = 'Licence lapsed at the issuer'
  and cvt.c('L', 'L5')->'verification'->'record' = 'null'::jsonb);
select cvt.ok('R4b the revoked claim''s columns are cleared, its kind kept',
  (select verified_at is null and verification_method is null and kind = 'credential' from claims where id = cvt.id('L5')));
select cvt.ok('R5 after a full classify → verify → review → revoke cycle the post''s approval and the draft''s hash still hold',
  (select approved_hash = cvt.get('post_hash') and review_status = 'approved' from social_posts sp where id = cvt.id('P1'))
  and (select content_draft_review_hash(d) = cvt.get('draft_hash') from content_drafts d where id = cvt.id('D1')));

-- ── A. Audit, and history is kept ───────────────────────────────────────────
select cvt.ok('A1 every decision is one stamped ledger row, one decision event and one field-diff event',
  (select string_agg(action, ',' order by created_at, action) from claim_reviews where claim_id = cvt.id('L1')) = 'classify,review,verify'
  and (select bool_and(reviewer_id = cvt.id('owner') and authority_id is not null and created_txid is not null)
         from claim_reviews where claim_id = cvt.id('L1'))
  and (select count(*) from creative_governance_events where subject_id = cvt.id('L1') and action in ('classified', 'verified', 'reviewed')) = 3
  and (select bool_and(actor_kind = 'team' and actor_id = cvt.id('owner') and changes ? 'review_id' and changes ? 'claim_fingerprint')
         from creative_governance_events where subject_id = cvt.id('L1') and action in ('classified', 'verified', 'reviewed'))
  and (select changes->>'evidence_sha256' from creative_governance_events where subject_id = cvt.id('L1') and action = 'verified') = cvt.sha('doc-contract')
  and (select count(*) from creative_governance_events where subject_id = cvt.id('L1') and action = 'updated' and changes ? 'review_id') = 3
  and (select note from creative_governance_events where subject_id = cvt.id('L5') and action = 'revoked') = 'Licence lapsed at the issuer');
select cvt.ok('A2 a claim with any review history is kept (23001), a classified-only one included; a claim with none still deletes',
  cvt.err(format('delete from claims where id = %L', cvt.id('L1'))) = '23001'
  and cvt.err(format('delete from claims where id = %L', cvt.id('L2'))) = '23001'
  and cvt.msg(format('delete from claims where id = %L', cvt.id('L2'))) like 'This claim has review history%'
  and cvt.err(format('delete from claims where id = %L', cvt.id('L8'))) = '');
select cvt.ok('A3 a claim cannot move to another client under its history',
  cvt.err(format('update claims set client_id = %L where id = %L', cvt.id('X'), cvt.id('L1'))) in ('23503', '42501'));
reset role;
set session authorization supabase_admin;
select cvt.ok('A4 not even a superuser changes or deletes a review',
  cvt.err(format($q$update claim_reviews set excerpt = 'x' where claim_id = %L$q$, cvt.id('L1'))) = '42501'
  and cvt.err(format($q$delete from claim_reviews where claim_id = %L$q$, cvt.id('L1'))) = '42501');
select cvt.ok('A6 recomputed now, the post''s approval snapshot still hashes to its approval',
  (select approved_hash = social_post_hash(social_post_snapshot(sp)) from social_posts sp where id = cvt.id('P1')));
select cvt.ok('A5 grants: writers and upload requests for authenticated only; the register for the service role only; tables read-only',
  has_function_privilege('authenticated', 'public.claim_verify(uuid,text,text,text,date,text,uuid,uuid,uuid,date,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.claim_classify(uuid,text,text,uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.claim_revoke(uuid,text,text,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_evidence_register(uuid,text,text,bigint,text,text,text,text,text,date)', 'execute')
  and has_function_privilege('service_role', 'public.claim_evidence_register(uuid,text,text,bigint,text,text,text,text,text,date)', 'execute')
  and has_function_privilege('authenticated', 'public.claim_evidence_request_upload(uuid,text,bigint,text)', 'execute')
  and not has_function_privilege('service_role', 'public.claim_evidence_request_upload(uuid,text,bigint,text)', 'execute')
  and not has_function_privilege('anon', 'public.claim_evidence_request_upload(uuid,text,bigint,text)', 'execute')
  and not has_table_privilege('authenticated', 'public.claim_evidence_uploads', 'insert')
  and not has_table_privilege('service_role', 'public.claim_evidence_uploads', 'insert')
  and not has_function_privilege('authenticated', 'public.claim_reviewer_authority()', 'execute')
  and not has_table_privilege('authenticated', 'public.claim_reviews', 'insert')
  and not has_table_privilege('service_role', 'public.claim_evidence', 'insert')
  and (select provolatile = 's' and not prosecdef from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure));

-- ── T. A claim's status changing while a decision form is open ─────────────
-- (ChatGPT's second review.) The fingerprint pins what a decision is about
-- (client, text, source, kind); status is the separate, unchanged citing
-- rule. The one rule that reads status (an unverified claim is not verified
-- here) is checked against the claim row locked at submit, so a form loaded
-- before a status change can never record what the rules would refuse.
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.classify('X1', 'warranty_guarantee');
select cvt.save('x1_fp', cvt.fp('X1'));
select cvt.save('x1_rid', cvt.rid('X1')::text);
select cvt.jwt('member');
update claims set status = 'unverified' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.save('x1_reviews', cvt.reviews('X1')::text);
select cvt.ok('T1 status set to unverified after the form loaded: verify is refused at submit and records nothing',
  cvt.msg(format($q$select claim_verify(%L, 'verify', 'client_contract', 'The contract says so.', %L, %L, %L, %L)$q$,
                 cvt.id('X1'), cvt.today(), cvt.get('x1_fp'), cvt.get('x1_rid'), cvt.id('doc-x'))) like 'An unverified claim cannot be verified%'
  and cvt.reviews('X1')::text = cvt.get('x1_reviews')
  and (select verified_at is null and status::text = 'unverified' from claims where id = cvt.id('X1')));
select cvt.jwt('member');
update claims set status = 'sourced', source = 'Signed agreement (fictional)' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('T2 a source edit after the form loaded is a different claim: the old screen is refused (CV409)',
  cvt.err(format($q$select claim_verify(%L, 'verify', 'client_contract', 'The contract says so.', %L, %L, %L, %L)$q$,
                 cvt.id('X1'), cvt.today(), cvt.get('x1_fp'), cvt.get('x1_rid'), cvt.id('doc-x'))) = 'CV409'
  and cvt.reviews('X1')::text = cvt.get('x1_reviews'));
select cvt.save('x1_fp', cvt.fp('X1'));
select cvt.jwt('member');
update claims set status = 'confirmed', confirmed_by = 'x2@example.test', confirmed_on = now() where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.save('t3', (claim_verify(cvt.id('X1'), 'verify', 'client_contract', 'The contract says so.', cvt.today(),
                                    cvt.get('x1_fp'), cvt.get('x1_rid')::uuid, cvt.id('doc-x'))->>'review_id'));
select cvt.ok('T3 a status-only change (sourced to confirmed) leaves the decision valid: it records, and the status it found is untouched',
  cvt.get('t3') is not null
  and (select status::text = 'confirmed' and confirmed_by = 'x2@example.test' and review_id = cvt.get('t3')::uuid and verified_by = cvt.id('owner')
         from claims where id = cvt.id('X1')));

-- ── W. Status changes after a verification (ChatGPT's second review) ──────
-- X1 is verified (T3, status confirmed). Any status change after that
-- verification needs the owner's fresh review, even when the status is put
-- back. Nothing changes the status, the evidence or the verification itself.
select cvt.save('x1_ver', cvt.get('t3'));
select cvt.jwt('member');
update claims set status = 'unverified' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('W1 verified → unverified: not independently verified, in the Unverified bucket, the reason says why; status, verification and evidence untouched',
  cvt.c('X', 'X1')->>'verification_state' = 'not_independently_verified'
  and cvt.c('X', 'X1')->>'bucket' = 'unverified'
  and cvt.c('X', 'X1')->'reasons' ? 'status_changed_since_verified'
  and (cvt.c('X', 'X1')->'verification'->>'status_changed_since_verified')::boolean
  and (select status::text = 'unverified' and review_id = cvt.get('x1_ver')::uuid and verified_by = cvt.id('owner')
         from claims where id = cvt.id('X1'))
  and (select claim_evidence_intact(e) from claim_evidence e where id = cvt.id('doc-x')));
select cvt.ok('W1b the owner cannot re-review while it is unverified, and the registry offers no re-review',
  cvt.err(format($q$select claim_verify(%L, 'review', 'client_contract', 'The contract says so.', %L, %L, %L, %L)$q$,
                 cvt.id('X1'), cvt.today(), cvt.fp('X1'), cvt.rid('X1'), cvt.id('doc-x'))) = '22023');
select cvt.jwt('member');
update claims set status = 'sourced' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('W2 verified → unverified → sourced: still needs review; putting the status back does not restore the verification',
  cvt.c('X', 'X1')->>'verification_state' = 'not_independently_verified'
  and cvt.c('X', 'X1')->>'bucket' = 'needs_review'
  and cvt.c('X', 'X1')->'reasons' ? 'status_changed_since_verified'
  and (cvt.c('X', 'X1')->>'legacy_usable')::boolean);
select cvt.jwt('member');
update claims set status = 'unverified' where id = cvt.id('X1');
update claims set status = 'confirmed', confirmed_by = 'x3@example.test', confirmed_on = now() where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('W3 verified → unverified → confirmed: still needs review',
  cvt.c('X', 'X1')->>'verification_state' = 'not_independently_verified'
  and cvt.c('X', 'X1')->>'bucket' = 'needs_review'
  and cvt.c('X', 'X1')->'reasons' ? 'status_changed_since_verified');
select cvt.save('w4', (claim_verify(cvt.id('X1'), 'review', 'client_contract', 'The contract still says so.', cvt.today(),
                                    cvt.fp('X1'), cvt.rid('X1'), cvt.id('doc-x'))->>'review_id'));
select cvt.ok('W4 the owner''s fresh review restores the verified state; the status he found is untouched',
  cvt.get('w4') is not null
  and cvt.c('X', 'X1')->>'verification_state' = 'independently_verified'
  and not (cvt.c('X', 'X1')->'reasons' ? 'status_changed_since_verified')
  and cvt.c('X', 'X1')->>'bucket' in ('verified', 'due')
  and (select status::text = 'confirmed' and review_id = cvt.get('w4')::uuid from claims where id = cvt.id('X1')));
select cvt.jwt('member');
update claims set status = 'sourced' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('W5 any later status change (confirmed → sourced) needs review again',
  cvt.c('X', 'X1')->>'verification_state' = 'not_independently_verified'
  and cvt.c('X', 'X1')->'reasons' ? 'status_changed_since_verified');
select cvt.jwt('member');
update claims set source = '' where id = cvt.id('X1');
select cvt.jwt('owner');
select cvt.ok('W6 never "independently verified" while today''s rules refuse the claim (here: sourced with its source removed)',
  cvt.c('X', 'X1')->>'verification_state' = 'not_independently_verified'
  and not (cvt.c('X', 'X1')->>'legacy_usable')::boolean);
reset role;
set session authorization supabase_admin;

-- ── D. Deleting a client still works ────────────────────────────────────────
set session authorization authenticator;
set local role authenticated;
select cvt.jwt('owner');
select cvt.classify('Z1', 'experience_stat');
select cvt.verify('Z1', 'client_confirmation', 'doc-z', p_contact => 'Zed (fictional)');
reset role;
set session authorization supabase_admin;
set session authorization postgres;
delete from clients where id = cvt.id('Z');
select cvt.ok('D1 a client delete cascades through its claims, reviews, evidence rows and history',
  not exists (select 1 from claims where client_id = cvt.id('Z')) and not exists (select 1 from claim_reviews where client_id = cvt.id('Z'))
  and not exists (select 1 from claim_evidence where client_id = cvt.id('Z'))
  and not exists (select 1 from claim_evidence_uploads where client_id = cvt.id('Z'))
  and not exists (select 1 from creative_governance_events where client_id = cvt.id('Z')));
set session authorization supabase_admin;

-- B3 (the rollback refuses once anything is recorded) runs in
-- tests/claim-verification-database.test.mjs, after this suite and before its
-- rollback: a refused script cannot be caught inside psql.
rollback;
