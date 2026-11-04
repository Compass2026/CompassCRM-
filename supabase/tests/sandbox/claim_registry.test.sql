-- 20261103220000: Claims Registry v1 (read-only registry, audit history,
-- registry columns). Plain SQL, one transaction, rolled back: runs in
-- scripts/test-portal-sandbox.sh and in tests/claim-registry-database.test.mjs
-- (PGlite). Fictional clients and example.test hosts only (the repo is
-- public).
--   L  one site: a confirmed 3-year warranty that names the lifetime one as
--      superseded, the unverified lifetime warranty cited by a published post,
--      a rejected post and three drafts in review, and one claim for every
--      source class / indicator
--   M  three brand workspaces: S and F approved, H a draft; a claim only in
--      S, one in S and F, one in H, one in none
--   X  another client (wrong-client evidence)
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   function authenticator, role service_role
--   worker   postgres (the worker's own SQL)
--   stranger authenticator, role authenticated, a sign-in on no team row
--   anon     authenticator, role anon
begin;
create schema crt;
grant usage on schema crt to anon, authenticated, service_role, authenticator, postgres;
create table crt.saved (k text primary key, v text);
grant select, insert, update on crt.saved to anon, authenticated, service_role, authenticator, postgres;
create function crt.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function crt.id(k text) returns uuid language sql immutable as $$ select md5('crt:' || k)::uuid $$;
create function crt.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create function crt.reg(k text) returns jsonb language sql stable as $$ select claim_registry(crt.id(k)) $$;
create function crt.claim(r jsonb, k text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(r->'claims') x where x->>'id' = crt.id(k)::text $$;
create function crt.prog(r jsonb, slug text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(r->'programs') x where x->>'slug' = slug $$;
create function crt.save(k text, v text) returns void language sql as $$
  insert into crt.saved values (k, v) on conflict (k) do update set v = excluded.v $$;
create function crt.get(k text) returns text language sql stable as $$ select v from crt.saved where k = $1 $$;
-- Row versions of every table the registry reads: a write anywhere changes it.
create function crt.fingerprint() returns text language sql stable as $$
  select md5(string_agg(t || ':' || n, ',' order by t)) from (
    select 'claims' t, count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) n from claims
    union all select 'social_posts', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from social_posts
    union all select 'content_drafts', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from content_drafts
    union all select 'post_claims', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from post_claims
    union all select 'content_draft_claims', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from content_draft_claims
    union all select 'events', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from creative_governance_events
    union all select 'workspaces', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from client_brand_workspaces) x
$$;
grant execute on all functions in schema crt to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (triggers off) ─────────────────────────────────────────────────
set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('c4700000-0000-4000-a000-000000000001', 'crt-member@compassmarketing.ai'),
  ('c4700000-0000-4000-a000-000000000002', 'crt-stranger@example.test'),
  ('c4700000-0000-4000-a000-000000000003', 'crt-other@compassmarketing.ai');
insert into team_members (id, auth_user_id, name, email, role) values
  (crt.id('member'), 'c4700000-0000-4000-a000-000000000001', 'Crt Member', 'crt-member@compassmarketing.ai', 'member'),
  (crt.id('other'), 'c4700000-0000-4000-a000-000000000003', 'Crt Other', 'crt-other@compassmarketing.ai', 'member');

insert into clients (id, name, status, website_url, phone, state) values
  (crt.id('L'), 'CRT Single Roofing (fictional)', 'active', 'https://crt-l.example.test', '(555) 010-0001', 'MO'),
  (crt.id('M'), 'CRT Multi Training (fictional)', 'active', 'https://crt-m.example.test', '555-010-0002', 'MO'),
  (crt.id('X'), 'CRT Other Client (fictional)', 'active', 'https://crt-x.example.test', null, 'KS');

insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on, created_at) values
  (crt.id('L1'), crt.id('L'), 'Zqx 3-Year Workmanship Warranty', 'confirmed',
   'Contract excerpt supplied by the owner. It supersedes claim ' || left(crt.id('L2')::text, 8) || ' (lifetime).',
   'owner@crt-l.example.test', now() - interval '10 days', now() - interval '40 days'),
  (crt.id('L2'), crt.id('L'), 'Zqx Lifetime Workmanship Warranty', 'unverified',
   'https://crt-l.example.test/services/roof-replacement', null, null, now() - interval '60 days'),
  (crt.id('L3'), crt.id('L'), 'Zqx installs architectural shingles', 'sourced', 'https://www.crt-l.example.test/about', null, null, now() - interval '50 days'),
  (crt.id('L4'), crt.id('L'), 'Zqx has no recorded source', 'sourced', '   ', null, null, now() - interval '50 days'),
  (crt.id('L5'), crt.id('L'), 'Zqx founded 2019', 'sourced', 'web search summary of an aggregator listing', null, null, now() - interval '50 days'),
  (crt.id('L6'), crt.id('L'), 'Phone (555) 010-0001', 'sourced', 'https://www.bbb.example.test/profile/crt-l', null, null, now() - interval '50 days'),
  (crt.id('L7'), crt.id('L'), 'Call (555) 010-0999 for storm repair', 'sourced', 'https://directory.example.test/crt-l', null, null, now() - interval '50 days'),
  (crt.id('L8'), crt.id('L'), 'Zqx free roof inspections', 'confirmed', 'Confirmed by the owner on a call',
   'owner@crt-l.example.test', now() - interval '120 days', now() - interval '130 days'),
  (crt.id('L9'), crt.id('L'), 'A federal rule requires fall protection', 'sourced', 'https://www.osha.gov/fall-protection', null, null, now() - interval '50 days'),
  (crt.id('L10'), crt.id('L'), 'Zqx 45+ years combined experience (conflicts with the homepage figure)', 'sourced',
   'https://crt-l.example.test/about', null, null, now() - interval '50 days'),
  (crt.id('L11'), crt.id('L'), 'Zqx open Mon–Fri 8–5', 'sourced', 'https://www.google.com/maps?cid=123', null, null, now() - interval '50 days'),
  (crt.id('L13'), crt.id('L'), 'Zqx north office line (555) 010-0777', 'sourced', 'https://www.google.com/maps?cid=456', null, null, now() - interval '50 days'),
  (crt.id('L14'), crt.id('L'), 'Zqx south office line (555) 010-0555', 'sourced', 'https://www.google.com/maps?cid=789', null, null, now() - interval '50 days'),
  (crt.id('L15'), crt.id('L'), 'Zqx east office line (555) 010-0666', 'sourced', 'https://www.google.com/maps?cid=790', null, null, now() - interval '50 days'),
  (crt.id('M1'), crt.id('M'), 'Zqx safety audits', 'sourced', 'https://s.crt-m.example.test/audits', null, null, now() - interval '20 days'),
  (crt.id('M2'), crt.id('M'), 'Zqx founded 2014', 'sourced', 'https://s.crt-m.example.test/about', null, null, now() - interval '20 days'),
  (crt.id('M3'), crt.id('M'), 'Zqx 65+ years combined experience', 'sourced', 'https://crt-m.example.test/', null, null, now() - interval '20 days'),
  (crt.id('M4'), crt.id('M'), 'Zqx heavy equipment classes', 'sourced', 'https://h.crt-m.example.test/', null, null, now() - interval '20 days'),
  (crt.id('X1'), crt.id('X'), 'Zqx other client fact', 'confirmed', 'Confirmed', 'x@example.test', now() - interval '5 days', now() - interval '5 days');

-- Locations with their own numbers (citation_locations). North is active and
-- approved by a teammate: a claim naming its number is the location's, not a
-- client-wide conflict. South is active but has no recorded approver
-- (approved_at is filled by default): its number is not an approved identity.
-- East was approved and is archived.
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone, status, approved_by) values
  (crt.id('loc-north'), crt.id('L'), 'North office', 'CRT Single Roofing', '1 Zqx Way', 'Northtown', 'MO', '63000', '555.010.0777', 'active',
   'c4700000-0000-4000-a000-000000000001'),
  (crt.id('loc-south'), crt.id('L'), 'South office', 'CRT Single Roofing', '2 Zqx Way', 'Southtown', 'MO', '63001', '555.010.0555', 'active', null),
  (crt.id('loc-east'), crt.id('L'), 'East office', 'CRT Single Roofing', '3 Zqx Way', 'Easttown', 'MO', '63002', '555.010.0666', 'archived',
   'c4700000-0000-4000-a000-000000000001');

insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, positioning, voice_tone, standing_cta,
                                     hard_rules, service_ids, claim_ids, asset_ids, status, approved_by, approved_at, created_at) values
  (crt.id('ws-s'), crt.id('M'), 'safety', 'Zqx Safety', 'https://s.crt-m.example.test', '555-010-0002', 'Safety', 'Clear', 'Call',
   array['Sourced claims only'], '{}', array[crt.id('M1'), crt.id('M2')], '{}', 'approved', crt.id('member'), now(), now() - interval '3 days'),
  (crt.id('ws-f'), crt.id('M'), 'forklift', 'Zqx Forklift', 'https://f.crt-m.example.test', '555-010-0003', 'Forklift', 'Clear', 'Call',
   array['Sourced claims only'], '{}', array[crt.id('M2')], '{}', 'approved', crt.id('member'), now(), now() - interval '2 days'),
  (crt.id('ws-h'), crt.id('M'), 'heavy', 'Zqx Heavy', 'https://h.crt-m.example.test', '555-010-0004', 'Heavy', 'Clear', 'Call',
   array['Sourced claims only'], '{}', array[crt.id('M4')], '{}', 'draft', null, null, now() - interval '1 day');

-- The unverified lifetime warranty: one published GBP post, one rejected
-- post, three blog drafts in review. The confirmed warranty: one draft. A
-- sourced claim: one approved, not yet published post (its approval hash must
-- survive the registry columns being set).
insert into social_posts (id, client_id, platform, search_intent, copy, review_status, publish_status, reviewed_by, reviewed_at,
                          review_note, approved_snapshot, approved_hash, published_url, published_at, external_post_id, created_at) values
  (crt.id('P1'), crt.id('L'), 'google_business', 'commercial', 'Zqx offers a Lifetime Workmanship Warranty.', 'approved', 'published',
   crt.id('member'), now() - interval '21 days', null, '{}', 'x', 'https://local.example.test/posts/p1', now() - interval '20 days', 'ext-p1', now() - interval '22 days'),
  (crt.id('P2'), crt.id('L'), 'google_business', 'commercial', 'Zqx lifetime coverage, again.', 'rejected', 'not_scheduled',
   crt.id('member'), now() - interval '15 days', 'Wrong warranty', null, null, null, null, null, now() - interval '16 days'),
  (crt.id('P3'), crt.id('L'), 'google_business', 'commercial', 'Zqx installs architectural shingles.', 'approved', 'not_scheduled',
   crt.id('member'), now() - interval '1 day', null, '{}', 'x', null, null, null, now() - interval '2 days');
insert into post_claims (post_id, client_id, claim_id) values
  (crt.id('P1'), crt.id('L'), crt.id('L2')), (crt.id('P2'), crt.id('L'), crt.id('L2')), (crt.id('P3'), crt.id('L'), crt.id('L3'));
update social_posts set approved_snapshot = social_post_snapshot(social_posts) where id = crt.id('P3');
update social_posts set approved_hash = social_post_hash(approved_snapshot) where id = crt.id('P3');
insert into content_drafts (id, client_id, deliverable, topic, status, title, body_markdown, created_at)
select crt.id('D' || i), crt.id('L'), 'blog', 'Zqx topic ' || i, 'in_review', 'Zqx roofing question ' || i,
       'Zqx offers a Lifetime Workmanship Warranty.', now() - make_interval(days => 15 - i)
  from generate_series(1, 4) i;
insert into content_draft_claims (draft_id, client_id, claim_id)
select crt.id('D' || i), crt.id('L'), crt.id('L2') from generate_series(1, 3) i
union all select crt.id('D4'), crt.id('L'), crt.id('L1');
set local session_replication_role = origin;

-- ── R. The registry as a teammate ───────────────────────────────────────────
set session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "c4700000-0000-4000-a000-000000000001"}', true);
select crt.save('fp0', crt.fingerprint());
select crt.save('hash_p3', (select approved_hash from social_posts where id = crt.id('P3')));

do $$
declare r jsonb := crt.reg('L'); c jsonb; t jsonb := r->'totals';
begin
  perform crt.ok('R1 one program for a single-site client, nothing classified, nothing verified',
    r->>'version' = 'claim-registry/v1' and not (r->>'multi_site')::boolean
    and jsonb_array_length(r->'programs') = 1 and r->'programs'->0->>'scope' = 'client'
    and (r->'programs'->0->'counts'->>'total')::int = 14 and (t->>'total')::int = 14
    and (t->>'verified')::int = 0 and t->'unassigned' = 'null'::jsonb and t->'shared' = 'null'::jsonb);
  c := crt.claim(r, 'L1');
  perform crt.ok('R2 the confirmed 3-year warranty: citable under current rules, NOT independently verified, needs review',
    c->>'status' = 'confirmed' and (c->>'legacy_usable')::boolean and c->>'bucket' = 'needs_review'
    and c->>'verification_state' = 'not_independently_verified'
    and c->'reasons' ? 'unclassified' and c->'reasons' ? 'method_unrecorded'
    and c->'verification'->>'last_verified_at' is not null and c->'freshness'->>'state' = 'current'
    and (c->'freshness'->>'interval_days')::int = 90 and c->>'kind_label' = 'Not yet classified'
    and c->'source'->>'class' = 'text_note'
    and (c->'affected'->>'total')::int = 1 and c->'affected'->'drafts'->0->>'id' = crt.id('D4')::text);
  c := crt.claim(r, 'L2');
  perform crt.ok('R3 the lifetime warranty: unverified, unusable, cited by 1 published + 1 rejected post and 3 drafts in review',
    c->>'status' = 'unverified' and not (c->>'legacy_usable')::boolean and c->>'bucket' = 'unverified'
    and (c->'affected'->>'published')::int = 1 and (c->'affected'->>'total')::int = 5
    and jsonb_array_length(c->'affected'->'posts') = 2 and jsonb_array_length(c->'affected'->'drafts') = 3
    and c->'affected'->'posts'->0->>'publish_status' = 'published'
    and c->'affected'->'posts'->0->>'published_url' = 'https://local.example.test/posts/p1'
    and (select bool_and(d->>'status' = 'in_review') from jsonb_array_elements(c->'affected'->'drafts') d)
    and c->'reasons' ? 'cited_while_unusable' and c->'reasons' ? 'published_while_unusable'
    and c->'reasons' ? 'supersession_mentioned' and c->'supersession_mentioned_by' = jsonb_build_array(crt.id('L1')::text)
    and c->>'superseded_by' is null and c->>'bucket' <> 'superseded' and c->'source'->>'class' = 'client_site');
  perform crt.ok('R12 a supersession note is tentative: only the claim it names is flagged, and nothing is superseded by it',
    (select count(*) from jsonb_array_elements(r->'claims') x where x->'reasons' ? 'supersession_mentioned') = 1
    and (t->>'superseded')::int = 0);
  perform crt.ok('R4 a sourced claim with a client-site URL is never verified because of the URL',
    crt.claim(r, 'L3')->>'bucket' = 'needs_review' and crt.claim(r, 'L3')->'reasons' ? 'never_verified'
    and crt.claim(r, 'L3')->'source'->>'class' = 'client_site' and crt.claim(r, 'L3')->'source'->>'host' = 'crt-l.example.test'
    and crt.claim(r, 'L3')->'verification'->'last_verified_at' = 'null'::jsonb
    and crt.claim(r, 'L3')->'freshness'->'days_left' = 'null'::jsonb);
  perform crt.ok('R5 sourced with a blank source → missing_source (the gate rule), and unusable',
    crt.claim(r, 'L4')->>'bucket' = 'missing_source' and not (crt.claim(r, 'L4')->>'legacy_usable')::boolean
    and crt.claim(r, 'L4')->'source'->>'class' = 'none');
  perform crt.ok('R6 source classes: summary, third party, government, google, conflict noted',
    crt.claim(r, 'L5')->'source'->>'class' = 'search_summary' and crt.claim(r, 'L5')->'reasons' ? 'summary_source'
    and crt.claim(r, 'L6')->'source'->>'class' = 'third_party_web'
    and crt.claim(r, 'L9')->'source'->>'class' = 'government'
    and crt.claim(r, 'L11')->'source'->>'class' = 'google'
    and crt.claim(r, 'L10')->'reasons' ? 'conflict_noted');
  perform crt.ok('R7 structured phones: client-wide match is a duplicate, a location''s own number is that location''s, anything else only a potential mismatch',
    crt.claim(r, 'L6')->'reasons' ? 'duplicates_structured_phone' and not crt.claim(r, 'L6')->'reasons' ? 'phone_potential_mismatch'
    and crt.claim(r, 'L13')->'reasons' ? 'matches_location_phone' and not crt.claim(r, 'L13')->'reasons' ? 'phone_potential_mismatch'
    and crt.claim(r, 'L13')->>'phone_location' = 'North office'
    and crt.claim(r, 'L7')->'reasons' ? 'phone_potential_mismatch' and crt.claim(r, 'L7')->>'bucket' = 'needs_review'
    and (crt.claim(r, 'L7')->>'legacy_usable')::boolean);
  perform crt.ok('R13 an active location with no recorded approver, or an archived one, is not an approved location phone: potential mismatch only',
    (select approved_at is not null and approved_by is null and status = 'active' from citation_locations where id = crt.id('loc-south'))
    and crt.claim(r, 'L14')->'reasons' ? 'phone_potential_mismatch' and not crt.claim(r, 'L14')->'reasons' ? 'matches_location_phone'
    and crt.claim(r, 'L14')->'phone_location' = 'null'::jsonb
    and crt.claim(r, 'L15')->'reasons' ? 'phone_potential_mismatch' and not crt.claim(r, 'L15')->'reasons' ? 'matches_location_phone'
    and crt.claim(r, 'L14')->>'bucket' = 'needs_review' and (crt.claim(r, 'L14')->>'legacy_usable')::boolean);
  perform crt.ok('R8 a legacy confirmation 120 days old is stale under the 90-day unclassified review',
    crt.claim(r, 'L8')->>'bucket' = 'stale' and crt.claim(r, 'L8')->'freshness'->>'state' = 'overdue'
    and (crt.claim(r, 'L8')->'freshness'->>'days_left')::int < 0);
  perform crt.ok('R9 totals add up and match the legacy rule',
    (t->>'stale')::int = 1 and (t->>'unverified')::int = 1 and (t->>'missing_source')::int = 1
    and (t->>'needs_review')::int = 11 and (t->>'legacy_usable')::int = 12
    and (t->>'cited_while_unusable')::int = 1 and (t->>'published_while_unusable')::int = 1
    and (select count(*) from jsonb_array_elements(r->'claims')) = 14
    and (select bool_and(x->>'verification_state' = 'not_independently_verified') from jsonb_array_elements(r->'claims') x));
  perform crt.ok('R10 ordered by bucket: unverified before missing_source before stale before needs_review',
    r->'claims'->0->>'bucket' = 'unverified' and r->'claims'->1->>'bucket' = 'missing_source'
    and r->'claims'->2->>'bucket' = 'stale' and r->'claims'->3->>'bucket' = 'needs_review');
  perform crt.ok('R11 the reviewed intervals (D1) are reported',
    (select (x->>'review_days')::int from jsonb_array_elements(r->'intervals') x where x->>'kind' = 'warranty_guarantee') = 180
    and (select (x->>'review_days')::int from jsonb_array_elements(r->'intervals') x where x->>'kind' = 'rating_review') = 30
    and (select x->'authoritative_methods' from jsonb_array_elements(r->'intervals') x where x->>'kind' = 'unclassified') = '[]'::jsonb);
end $$;

-- ── S. Site programs (BHG-shaped) ───────────────────────────────────────────
do $$
declare r jsonb := crt.reg('M'); s jsonb; f jsonb; h jsonb;
begin
  s := crt.prog(r, 'safety'); f := crt.prog(r, 'forklift'); h := crt.prog(r, 'heavy');
  perform crt.ok('S1 three programs from the brand workspaces, in order',
    (r->>'multi_site')::boolean and jsonb_array_length(r->'programs') = 3
    and r->'programs'->0->>'slug' = 'safety' and r->'programs'->2->>'slug' = 'heavy');
  perform crt.ok('S2 a claim only in Safety is Safety''s; Forklift never sees it',
    s->'claim_ids' ? crt.id('M1')::text and not f->'claim_ids' ? crt.id('M1')::text
    and crt.claim(r, 'M1')->'scope'->'programs' = '["safety"]'::jsonb
    and not (crt.claim(r, 'M1')->'scope'->>'shared')::boolean);
  perform crt.ok('S3 a claim in two workspaces is shared and labelled so',
    (crt.claim(r, 'M2')->'scope'->>'shared')::boolean and crt.claim(r, 'M2')->'reasons' ? 'shared_across_sites'
    and s->'claim_ids' ? crt.id('M2')::text and f->'claim_ids' ? crt.id('M2')::text
    and (s->'counts'->>'shared')::int = 1 and (f->'counts'->>'shared')::int = 1);
  perform crt.ok('S4 a claim in no workspace is unassigned and counted for no program',
    (crt.claim(r, 'M3')->'scope'->>'unassigned')::boolean and crt.claim(r, 'M3')->'reasons' ? 'unassigned_to_site'
    and crt.claim(r, 'M3')->'scope'->'programs' = '[]'::jsonb
    and (r->'totals'->>'unassigned')::int = 1
    and (s->'counts'->>'total')::int = 2 and (f->'counts'->>'total')::int = 1);
  perform crt.ok('S5 a draft workspace''s scope is not authoritative: its counts are unknown (null), not 0',
    h->>'workspace_status' = 'draft' and not (h->>'scope_authoritative')::boolean
    and h->'counts' = 'null'::jsonb and h->'claim_ids' ? crt.id('M4')::text
    and (s->>'scope_authoritative')::boolean and (s->'counts'->>'verified')::int = 0);
  perform crt.ok('S6 workspace hosts count as the client''s own site',
    crt.claim(r, 'M1')->'source'->>'class' = 'client_site' and crt.claim(r, 'M3')->'source'->>'class' = 'client_site');
  perform crt.ok('S7 another client''s claims never appear',
    not exists (select 1 from jsonb_array_elements(r->'claims') x where x->>'id' in (crt.id('X1')::text, crt.id('L1')::text))
    and (r->'totals'->>'total')::int = 4);
end $$;

-- ── W. No writes; repeatable ────────────────────────────────────────────────
do $$
declare a jsonb := crt.reg('L'); b jsonb := crt.reg('L');
begin
  perform crt.ok('W1 the registry writes nothing (row versions of every table it reads unchanged)',
    crt.fingerprint() = crt.get('fp0'));
  perform crt.ok('W2 repeatable: two calls agree (as_of aside)', (a - 'as_of') = (b - 'as_of'));
  perform crt.ok('W3 deterministic boundary: as of a chosen day',
    (claim_registry(crt.id('L'), (now() at time zone 'America/Chicago')::date + 400)->'totals'->>'stale')::int = 2);
end $$;

-- ── V. The registry columns are locked (ChatGPT review 42aca6fb) ─────────────
-- A signed-in teammate cannot set any of them, by any route; ordinary claim
-- edits still work. The suites seed them as a superuser (platform
-- administration), which the CRM never is.
select crt.ok('V1 a signed-in teammate cannot classify, verify, date or supersede a claim, nor insert one so',
  crt.err(format('update claims set kind = %L where id = %L', 'warranty_guarantee', crt.id('L1'))) = '42501'
  and crt.err(format('update claims set verification_method = %L, verified_at = now() where id = %L', 'client_contract', crt.id('L1'))) = '42501'
  and crt.err(format('update claims set verified_by = %L where id = %L', crt.id('member'), crt.id('L1'))) = '42501'
  and crt.err(format('update claims set review_by = current_date + 30 where id = %L', crt.id('L1'))) = '42501'
  and crt.err(format('update claims set superseded_by = %L where id = %L', crt.id('L1'), crt.id('L2'))) = '42501'
  and crt.err(format($q$insert into claims (client_id, claim, status, source, kind) values (%L, 'x', 'sourced', 'y', 'offering')$q$, crt.id('L'))) = '42501'
  and (select kind is null and verified_at is null and superseded_by is null from claims where id = crt.id('L1')));
update claims set kind = null, review_by = null where id = crt.id('L1');
update claims set source = 'https://www.osha.gov/fall-protection/general' where id = crt.id('L9');
select crt.ok('V2 … a write that leaves them unchanged, and ordinary edits, still work and are recorded as the teammate''s',
  (select source = 'https://www.osha.gov/fall-protection/general' from claims where id = crt.id('L9'))
  and (select e.actor_kind = 'team' and e.actor_id = crt.id('member') and e.changes ? 'source'
         from creative_governance_events e where e.subject_type = 'claim' and e.subject_id = crt.id('L9') order by e.id desc limit 1)
  and not exists (select 1 from creative_governance_events e where e.subject_id = crt.id('L1')));
reset role;
set session authorization supabase_admin;
update claims set kind = 'warranty_guarantee', verification_method = 'client_contract', verified_at = now(), verified_by = crt.id('other')
 where id = crt.id('L1');
set session authorization authenticator;
set local role authenticated;
do $$
declare c jsonb := crt.claim(crt.reg('L'), 'L1');
begin
  perform crt.ok('V3 classified + authoritative method + current → verified, independently',
    c->>'bucket' = 'verified' and c->>'verification_state' = 'independently_verified'
    and (c->'verification'->>'authoritative')::boolean and c->'verification'->>'verified_by_name' = 'Crt Other'
    and (c->'freshness'->>'interval_days')::int = 180 and (c->'freshness'->>'days_left')::int between 179 and 180
    and not c->'reasons' ? 'unclassified');
  perform crt.ok('V4 history records the administrative seed as the superuser''s, with the diff',
    (select count(*) from creative_governance_events e where e.subject_type = 'claim' and e.subject_id = crt.id('L1')) = 1
    and (select e.actor_kind = 'superuser' and e.actor_id is null and e.action = 'updated'
                and e.changes ? 'kind' and e.changes ? 'verified_by' and e.changes->'kind'->>'to' = 'warranty_guarantee'
           from creative_governance_events e where e.subject_type = 'claim' and e.subject_id = crt.id('L1')));
end $$;
reset role;
set session authorization supabase_admin;
update claims set review_by = (now() at time zone 'America/Chicago')::date + 5 where id = crt.id('L1');
set session authorization authenticator;
set local role authenticated;
select crt.ok('V5 a document expiry earlier than the interval wins → due',
  crt.claim(crt.reg('L'), 'L1')->>'bucket' = 'due' and (crt.claim(crt.reg('L'), 'L1')->'freshness'->>'days_left')::int = 5);
reset role;
set session authorization supabase_admin;
update claims set verification_method = 'third_party', review_by = null where id = crt.id('L1');
set session authorization authenticator;
set local role authenticated;
select crt.ok('V6 a method that is not authoritative for the kind → needs review, not independently verified',
  crt.claim(crt.reg('L'), 'L1')->>'bucket' = 'needs_review' and crt.claim(crt.reg('L'), 'L1')->'reasons' ? 'method_not_authoritative'
  and crt.claim(crt.reg('L'), 'L1')->>'verification_state' = 'not_independently_verified');
reset role;
set session authorization supabase_admin;
update claims set verification_method = 'client_contract', verified_at = now() - interval '1 minute' where id = crt.id('L1');
set session authorization authenticator;
set local role authenticated;
update claims set claim = 'Zqx 3-Year Workmanship Warranty (edited)' where id = crt.id('L1');
select crt.ok('V7 a teammate''s material change after verification asks for re-verification at once',
  crt.claim(crt.reg('L'), 'L1')->>'bucket' = 'needs_review' and crt.claim(crt.reg('L'), 'L1')->'reasons' ? 'changed_since_verified');
reset role;
set session authorization supabase_admin;
select crt.ok('V8 even the administrative path keeps a successor to the same client, and a verification whole',
  crt.err(format('update claims set superseded_by = %L where id = %L', crt.id('X1'), crt.id('L2'))) = '23503'
  and crt.err(format('update claims set superseded_by = %L where id = %L', crt.id('L2'), crt.id('L2'))) = '23514'
  and crt.err(format('update claims set kind = %L where id = %L', 'unclassified', crt.id('L2'))) = '23514'
  and crt.err(format('update claims set kind = %L where id = %L', 'made_up', crt.id('L2'))) = '23503'
  and crt.err(format('update claims set verified_at = now() where id = %L', crt.id('L2'))) = '23514'
  and crt.err(format('update claims set verified_by = %L where id = %L', crt.id('member'), crt.id('L2'))) = '23514');
update claims set superseded_by = crt.id('L1') where id = crt.id('L2');
update claims set kind = 'service_description' where id = crt.id('L3');
set session authorization authenticator;
set local role authenticated;
do $$
declare r jsonb := crt.reg('L');
begin
  perform crt.ok('V9 only a recorded superseded_by supersedes: it wins over every other bucket and the successor lists it',
    crt.claim(r, 'L2')->>'bucket' = 'superseded' and crt.claim(r, 'L2')->'reasons' ? 'cited_while_superseded'
    and crt.claim(r, 'L1')->'supersedes' = jsonb_build_array(crt.id('L2')::text));
end $$;
select crt.ok('V10 the approved post standing on a classified claim keeps its approval and hash',
  (select review_status = 'approved' and approved_hash = crt.get('hash_p3') from social_posts where id = crt.id('P3')));
select crt.ok('V11 nobody writes history directly',
  crt.err(format($q$insert into creative_governance_events (client_id, subject_type, subject_id, actor_kind, action)
                    values (%L, 'claim', %L, 'team', 'forged')$q$, crt.id('L'), crt.id('L1'))) = '42501'
  and crt.err('update creative_governance_events set note = ''x'' where subject_type = ''claim''') = '42501'
  and crt.err('delete from creative_governance_events where subject_type = ''claim''') = '42501');
select crt.ok('V12 the review intervals are read-only to the team',
  crt.err('update claim_review_intervals set review_days = 1') = '42501'
  and crt.err($q$insert into claim_review_intervals values ('x_kind', 'X', 1, '{}', 'x')$q$) = '42501'
  and (select count(*) from claim_review_intervals) = 9);
reset role;
set session authorization supabase_admin;
select crt.ok('V13 the approval snapshot ignores the registry columns: recomputed, it still matches the approval',
  (select approved_hash = social_post_hash(social_post_snapshot(social_posts)) from social_posts where id = crt.id('P3')));

-- ── A. Who may call it, and who may set the columns ─────────────────────────
-- The function (service role) and the worker cannot classify or verify.
set session authorization authenticator;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select crt.ok('A1 an Edge Function cannot classify, verify, date or supersede a claim',
  crt.err(format('update claims set kind = %L where id = %L', 'offering', crt.id('L8'))) = '42501'
  and crt.err(format('update claims set review_by = current_date where id = %L', crt.id('L8'))) = '42501'
  and crt.err(format($q$insert into claims (client_id, claim, status, source, kind) values (%L, 'x', 'sourced', 'y', 'offering')$q$, crt.id('L'))) = '42501');
update claims set source = 'Confirmed by the owner on a call (notes filed)' where id = crt.id('L8');
select crt.ok('A2 … but its ordinary claim edits still work, and are recorded as the function''s',
  (select e.actor_kind = 'worker' and e.actor_id is null from creative_governance_events e
    where e.subject_type = 'claim' and e.subject_id = crt.id('L8') order by e.id desc limit 1));
reset role;
set session authorization supabase_admin;
-- pglite:skip-begin (PGlite's postgres is a superuser, the database owner's bypass)
set session authorization postgres;
select crt.ok('A3 the worker''s own SQL cannot either',
  crt.err(format('update claims set kind = %L where id = %L', 'offering', crt.id('L8'))) = '42501');
insert into claims (id, client_id, claim, status, source) values (crt.id('L12'), crt.id('L'), 'Zqx worker claim', 'sourced', 'https://crt-l.example.test/x');
delete from claims where id = crt.id('L12');
select crt.ok('A4 a worker insert and delete are both recorded; the deleted claim keeps its history',
  (select string_agg(e.action, ',' order by e.id) from creative_governance_events e where e.subject_id = crt.id('L12')) = 'created,deleted'
  and (select e.changes->'claim'->>'from' from creative_governance_events e where e.subject_id = crt.id('L12') and e.action = 'deleted') = 'Zqx worker claim');
set session authorization supabase_admin;
-- pglite:skip-end

set session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "c4700000-0000-4000-a000-000000000002"}', true);
select crt.ok('A5 a sign-in on no team row is refused',
  crt.err(format('select claim_registry(%L)', crt.id('L'))) = '42501');
select crt.ok('A6 … and reads no history and no claims',
  not exists (select 1 from creative_governance_events) and not exists (select 1 from claims)
  and not exists (select 1 from claim_review_intervals));
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select crt.ok('A7 anon cannot execute it or read the intervals',
  crt.err(format('select claim_registry(%L)', crt.id('L'))) = '42501'
  and crt.err('select * from claim_review_intervals') = '42501');
reset role;
set session authorization supabase_admin;
select crt.ok('A8 grants: authenticated may only read the intervals; anon has no execute',
  not has_function_privilege('anon', 'public.claim_registry(uuid,date)', 'execute')
  and has_function_privilege('authenticated', 'public.claim_registry(uuid,date)', 'execute')
  and not has_table_privilege('authenticated', 'public.claim_review_intervals', 'insert')
  and not has_function_privilege('authenticated', 'public.claims_history()', 'execute')
  and not has_function_privilege('authenticated', 'public.claims_registry_guard()', 'execute'));
select crt.ok('A9 claims RLS is unchanged: one team policy',
  (select count(*) from pg_policies where tablename = 'claims') = 1
  and (select qual from pg_policies where tablename = 'claims') like '%is_team()%');
select crt.ok('A10 STABLE and security invoker',
  (select provolatile = 's' and not prosecdef from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure));

-- ── D. Deleting a client still works (its claims leave no orphan history) ───
set session authorization postgres;
delete from clients where id = crt.id('X');
select crt.ok('D1 a client delete cascades through its claims without error, history included',
  not exists (select 1 from claims where client_id = crt.id('X'))
  and not exists (select 1 from creative_governance_events where client_id = crt.id('X')));
set session authorization supabase_admin;

-- ── B. Down, then up ────────────────────────────────────────────────────────
select crt.save('events_before_down', (select count(*)::text from creative_governance_events where subject_type = 'claim'));
\ir ../../rollback/20261103220000_claim_registry.down.sql
select crt.ok('B1 down: the registry, its columns, triggers and intervals are gone; the history stays',
  to_regprocedure('public.claim_registry(uuid,date)') is null and to_regclass('public.claim_review_intervals') is null
  and not exists (select 1 from information_schema.columns where table_name = 'claims' and column_name in ('kind', 'verified_at', 'superseded_by'))
  and not exists (select 1 from pg_trigger where tgrelid = 'public.claims'::regclass and tgname in ('claims_history', 'claims_registry_guard'))
  and (select count(*)::text from creative_governance_events where subject_type = 'claim') = crt.get('events_before_down'));
select crt.ok('B2 after down, today''s gate rule is untouched (the post standing on L3 is still approved)',
  (select review_status = 'approved' and approved_hash = crt.get('hash_p3') from social_posts where id = crt.id('P3')));
\ir ../../migrations/20261103220000_claim_registry.sql
set session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "c4700000-0000-4000-a000-000000000001"}', true);
select crt.ok('B3 up again: the registry answers and the columns start empty',
  (crt.reg('L')->'totals'->>'total')::int = 14 and (crt.reg('L')->'totals'->>'verified')::int = 0
  and crt.claim(crt.reg('L'), 'L2')->>'bucket' = 'unverified');
reset role;
set session authorization supabase_admin;

rollback;
