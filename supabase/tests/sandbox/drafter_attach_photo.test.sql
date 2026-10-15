-- Tests for 20261015060000_drafter_attach_photo.sql, run by
-- scripts/test-portal-sandbox.sh after drafter_gbp_destination.test.sql.
-- Uses the fd harness from drafter_facebook.test.sql; own schema (dp).
-- Fictional data only.
--
-- Callers are real sessions, the way each reaches production:
--   worker     psql as postgres (the Supabase connector's login)
--   drafter    psql as authenticator, role service_role (the post-drafter
--              Edge Function through PostgREST)
--   person     psql as authenticator, role authenticated, team JWT
-- What it proves: only the drafter's service session attaches; the client is
-- the post's own; only an approved, stored, hash-verified photo of that client
-- attaches, illustration included; draft / in_review only, never approved or
-- scheduled; a stale read, another image or rendered creative refuses; a
-- retry replays; a grounding refusal rolls everything back; copy, claims,
-- destination, provenance and publishing history are untouched; the history
-- names the drafter, never a person; a photo excluded later lapses approval.

\set team '00000000-0000-4000-a000-000000000001'
\set cb   '00000000-0000-4000-b000-00000000000b'

\o /dev/null
\c - postgres
create schema dp;
create table dp.results (n serial, status text, name text, detail text);
create table dp.ids (k text primary key, id uuid);
create table dp.vals (k text primary key, v text);
grant usage on schema dp to anon, authenticated, service_role;
grant insert, select on dp.results to anon, authenticated, service_role;
grant select, insert on dp.ids, dp.vals to anon, authenticated, service_role;
grant usage on sequence dp.results_n_seq to anon, authenticated, service_role;
create function dp.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into dp.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function dp.id(p_k text) returns uuid language sql stable as $$ select id from dp.ids where k = p_k $$;
create function dp.v(p_k text) returns text language sql stable as $$ select v from dp.vals where k = p_k $$;
-- A drafter_write request for client B on one of this suite's services.
create function dp.req(p_copy text, p_service uuid, p_intent text, p_claims uuid[]) returns jsonb language sql stable as $$
  select jsonb_set(jsonb_set(jsonb_set(
           fd.req(p_copy, null, '{}', p_claims, p_intent, 'google_business'),
           '{brief,target,service}', jsonb_build_object('id', p_service, 'name', 'Attach test')),
           '{brief,allowed_facts,claims}', (select jsonb_agg(jsonb_build_object('id', c)) from unnest(p_claims) c)),
           '{claim_ids}', to_jsonb(p_claims))
$$;
-- An attach request for the post as it stands now.
create function dp.att(p_post uuid, p_asset uuid, p_op text, p_hash text default null, p_via text default 'worker',
                       p_by uuid default null) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('post_id', p_post, 'brand_asset_id', p_asset, 'operation_id', p_op,
    'verified_hash', coalesce(p_hash, (select content_hash from brand_assets where id = p_asset)),
    'expected_updated_at', (select updated_at from social_posts where id = p_post),
    'requested_via', p_via, 'requested_by', p_by, 'runtime', 'sandbox-attach')
$$;
grant execute on all functions in schema dp to anon, authenticated, service_role;

-- ── Fixtures (as the cluster superuser) ─────────────────────────────────────
\c - supabase_admin
create function dp.asset(p_client uuid, p_kind text, p_label text, p_path text, p_hash2 text, p_use text, p_own boolean)
returns uuid language sql as $$
  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at,
                            content_measurement, creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_reviewed_at,
                            creative_review_note)
  values (p_client, p_kind::brand_asset_kind, p_label, 'website_scan', p_client::text || p_path, 'image/jpeg', 950, 1200,
          repeat(p_hash2, 32), now(), '{"measured_by": "sandbox"}', p_use, p_own,
          case when p_use = 'approved' then array['roof'] else '{}' end,
          case when p_kind = 'photo' and p_use = 'approved' then 0.5 end, case when p_kind = 'photo' and p_use = 'approved' then 0.5 end,
          case when p_use <> 'unreviewed' then now() end, case when p_use = 'excluded' then 'Not ours to use' end)
  returning id
$$;
do $$
declare v uuid;
begin
  insert into services (client_id, name, status, page_url) values
    ('00000000-0000-4000-b000-00000000000b', 'Attach roofing', 'approved', 'https://b.example.test/attach-roofing') returning id into v;
  insert into dp.ids values ('s1', v);
  insert into services (client_id, name, status, page_url) values
    ('00000000-0000-4000-b000-00000000000b', 'Attach siding', 'approved', 'https://b.example.test/attach-siding') returning id into v;
  insert into dp.ids values ('s2', v);
  insert into claims (client_id, claim, status, source) values
    ('00000000-0000-4000-b000-00000000000b', 'Attach suite claim', 'sourced', 'https://b.example.test/about') returning id into v;
  insert into dp.ids values ('claim', v);
  insert into claims (client_id, claim, status, source) values
    ('00000000-0000-4000-b000-00000000000b', 'Attach rollback claim', 'sourced', 'https://b.example.test/about') returning id into v;
  insert into dp.ids values ('claim_rb', v);

  -- Client B's photos, as a teammate's review and the source-assets hasher
  -- would leave them (the superuser stands in for both here). An approved
  -- asset always carries its measured hash (brand_assets_creative_approved_complete).
  insert into dp.ids values
    ('own',   dp.asset('00000000-0000-4000-b000-00000000000b', 'photo', 'Finished roof', '/scan/attach-a.jpg', 'a1', 'approved', true)),
    ('illus', dp.asset('00000000-0000-4000-b000-00000000000b', 'photo', 'Roof diagram (illustration)', '/upload/attach-illus.jpg', 'a2', 'approved', false)),
    ('unrev', dp.asset('00000000-0000-4000-b000-00000000000b', 'photo', 'Unreviewed', '/scan/attach-u.jpg', 'a3', 'unreviewed', null)),
    ('excl',  dp.asset('00000000-0000-4000-b000-00000000000b', 'photo', 'Excluded', '/scan/attach-x.jpg', 'a4', 'excluded', null)),
    ('logo',  dp.asset('00000000-0000-4000-b000-00000000000b', 'logo_primary', 'Approved logo', '/attach-logo.png', 'a5', 'approved', null)),
    ('other', dp.asset('00000000-0000-4000-b000-00000000000a', 'photo', 'Client A roof', '/scan/a.jpg', 'a6', 'approved', true)),
    ('own2',  dp.asset('00000000-0000-4000-b000-00000000000b', 'photo', 'Second own photo', '/scan/attach-b.jpg', 'a7', 'approved', true));

  insert into dp.ids select 'member', id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001';

  -- A post a person wrote (no drafter run).
  insert into social_posts (client_id, platform, search_intent, service_id, copy)
  values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'informational', (select id from dp.ids where k = 's2'), 'A teammate wrote this.') returning id into v;
  insert into dp.ids values ('human', v);
end $$;

-- ── Drafted posts (the drafter's service session) ───────────────────────────
\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare r jsonb;
begin
  r := drafter_write(dp.req('Attach suite: what a roof replacement involves.', dp.id('s1'), 'informational', array[dp.id('claim')]));
  insert into dp.ids values ('p1', (r->>'post_id')::uuid), ('p1_task', (r->>'review_task_id')::uuid), ('p1_run', (r->>'run_id')::uuid);
  r := drafter_write(dp.req('Attach suite: request a roofing quote.', dp.id('s1'), 'commercial', array[dp.id('claim')]));
  insert into dp.ids values ('p2', (r->>'post_id')::uuid);
  r := drafter_write(dp.req('Attach suite: rollback copy.', dp.id('s1'), 'transactional', array[dp.id('claim_rb')]));
  insert into dp.ids values ('p3', (r->>'post_id')::uuid), ('p3_task', (r->>'review_task_id')::uuid);
  r := drafter_write(dp.req('Attach suite: a draft post.', dp.id('s2'), 'commercial', array[dp.id('claim')]));
  insert into dp.ids values ('p4', (r->>'post_id')::uuid);
end $$;
-- p4 is withdrawn to a draft (anyone may withdraw).
update social_posts set review_status = 'draft' where id = dp.id('p4');
reset role;

-- ── Who may call ────────────────────────────────────────────────────────────
\c - postgres
do $$
declare e text;
begin
  perform dp.ok('S1 only the service role executes it',
    has_function_privilege('service_role', 'public.drafter_attach_photo(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.drafter_attach_photo(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.drafter_attach_photo(jsonb)', 'execute'));
  perform dp.ok('S2 the edit record is team-read only and written by nobody over the API',
    (select relrowsecurity from pg_class where oid = 'public.drafter_post_edits'::regclass)
    and has_table_privilege('authenticated', 'public.drafter_post_edits', 'select')
    and not has_table_privilege('authenticated', 'public.drafter_post_edits', 'insert,update,delete')
    and not has_table_privilege('anon', 'public.drafter_post_edits', 'select')
    and not has_table_privilege('service_role', 'public.drafter_post_edits', 'update,delete'));
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-worker-0001')));
  perform dp.ok('W1 the worker''s SQL cannot attach', e like '42501:%post-drafter%', e);
  e := fd.try(format('insert into post_assets (post_id, client_id, brand_asset_id) values (%L, %L, %L)',
                     dp.id('p1'), '00000000-0000-4000-b000-00000000000b', dp.id('own')));
  perform dp.ok('W2 ... nor link directly (the drafter guard stands)', e like '42501:%' or e like '23514:%', e);
end $$;
\c - authenticator
set role authenticated;
select fd.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-team-00001')));
  perform dp.ok('W3 a signed-in teammate cannot call it directly', e like '42501:%', e);
end $$;
reset role;
set role anon;
select fd.as_user('anon', null);
do $$
declare e text;
begin
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-anon-00001')));
  perform dp.ok('W4 anon cannot call it', e like '42501:%', e);
end $$;
reset role;

-- ── Refusals (the drafter's session) ────────────────────────────────────────
set role service_role;
select fd.as_user('service_role', null);
do $$
declare e text; v_events bigint := (select count(*) from post_events where post_id = dp.id('p1'));
begin
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('other'), 'op-cross-0001')));
  perform dp.ok('R1 another client''s photo is not found', e like 'P0002: asset_not_found%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('unrev'), 'op-unrev-0001')));
  perform dp.ok('R2 an unreviewed photo is refused', e like 'DR422: asset_not_approved%unreviewed%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('excl'), 'op-excl-00001')));
  perform dp.ok('R3 an excluded photo is refused', e like 'DR422: asset_not_approved%excluded%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('logo'), 'op-logo-00001')));
  perform dp.ok('R4 a logo is not a photo', e like 'DR422: asset_not_photo%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-mismatch-1', repeat('ff', 32))));
  perform dp.ok('R6 bytes that do not match the recorded hash are refused', e like 'DR422: asset_hash_mismatch%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)',
                     jsonb_set(dp.att(dp.id('p1'), dp.id('own'), 'op-stale-0001'), '{expected_updated_at}', to_jsonb('2020-01-01T00:00:00Z'::text))));
  perform dp.ok('R7 a stale read of the post is refused', e like 'DR409: stale_post%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-stale-0002') - 'expected_updated_at'));
  perform dp.ok('R8 the expected version is required', e like '23514: bad_request%expected_updated_at%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'short')));
  perform dp.ok('R9 an operation id is required', e like '23514: bad_request%operation_id%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own'), 'op-team-noone', null, 'team', null)));
  perform dp.ok('R10 a team request names a real team member', e like '23514: bad_request%team member%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('human'), dp.id('own'), 'op-human-0001')));
  perform dp.ok('R11 a post a person wrote is not the drafter''s to edit', e like 'DR422: post_not_drafted%', e);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att('00000000-0000-4000-9999-000000000000'::uuid, dp.id('own'), 'op-nopost-001')));
  perform dp.ok('R12 an unknown post is not found', e like 'P0002: post_not_found%', e);
  perform dp.ok('R13 every refusal left the post as it was',
    (select review_status = 'in_review' and review_task_id = dp.id('p1_task') from social_posts where id = dp.id('p1'))
    and not exists (select 1 from post_assets where post_id = dp.id('p1'))
    and not exists (select 1 from drafter_post_edits where post_id = dp.id('p1'))
    and (select count(*) from post_events where post_id = dp.id('p1')) = v_events);
end $$;
reset role;

-- Before: what must not change.
\c - postgres
insert into dp.vals
select 'p1_before', jsonb_build_object('copy', copy, 'account', social_account_id, 'service', service_id, 'keyword', keyword_id,
  'intent', search_intent, 'cta', cta_url, 'run', drafter_run_id, 'attempts', publish_attempts,
  'claims', (select jsonb_agg(claim_id order by claim_id) from post_claims where post_id = p.id))::text
from social_posts p where id = dp.id('p1');
insert into dp.vals select 'runs_before', count(*)::text from drafter_runs;
insert into dp.vals select 'p1_run_before', to_jsonb(r)::text from drafter_runs r where id = dp.id('p1_run');

insert into dp.vals select 'p1_last_event', coalesce(max(id), 0)::text from post_events where post_id = dp.id('p1');

-- ── The attach (in review → withdrawn → photo → resubmitted) ───────────────
\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare r jsonb;
begin
  r := drafter_attach_photo(dp.att(dp.id('p1'), dp.id('own'), 'op-attach-p1-0001', null, 'team', dp.id('member')));
  insert into dp.vals values ('p1_result', r::text);
  perform dp.ok('A1 attached and back in review, unscheduled, no attempts',
    r->>'status' = 'attached' and r->>'review_status' = 'in_review' and r->>'publish_status' = 'not_scheduled'
    and (r->>'publish_attempts')::int = 0 and (r->>'client_id')::uuid = '00000000-0000-4000-b000-00000000000b', r::text);
end $$;
reset role;
\c - postgres
do $$
declare r jsonb := dp.v('p1_result')::jsonb; b jsonb := dp.v('p1_before')::jsonb; e drafter_post_edits;
begin
  perform dp.ok('A2 the post carries exactly the photo, with its hash',
    (select count(*) = 1 and bool_and(brand_asset_id = dp.id('own') and content_hash = repeat('a1', 32) and creative_asset_id is null)
       from post_assets where post_id = dp.id('p1')));
  perform dp.ok('A3 copy, claims, service, keyword, destination, provenance and attempts are unchanged',
    (select jsonb_build_object('copy', copy, 'account', social_account_id, 'service', service_id, 'keyword', keyword_id,
        'intent', search_intent, 'cta', cta_url, 'run', drafter_run_id, 'attempts', publish_attempts,
        'claims', (select jsonb_agg(claim_id order by claim_id) from post_claims where post_id = p.id)) = b
     from social_posts p where id = dp.id('p1')), b::text);
  perform dp.ok('A4 the original drafter run is untouched and no run was added',
    (select to_jsonb(r2)::text from drafter_runs r2 where id = dp.id('p1_run')) = dp.v('p1_run_before')
    and (select count(*)::text from drafter_runs) = dp.v('runs_before'));
  perform dp.ok('A5 the old review task closed as withdrawn, a fresh one is open',
    (select status = 'done' from tasks where id = dp.id('p1_task'))
    and (r->>'review_task_id')::uuid <> dp.id('p1_task')
    and (select status = 'open' and owner = 'CLAUDE_APPROVAL' from tasks where id = (r->>'review_task_id')::uuid)
    and (select review_task_id = (r->>'review_task_id')::uuid and approved_hash is null and reviewed_by is null and updated_by is null
         from social_posts where id = dp.id('p1')), r::text);
  perform dp.ok('A6 the history names the drafter, never a person',
    (select array_agg(kind order by id) from post_events
      where post_id = dp.id('p1') and id > dp.v('p1_last_event')::bigint)
    = array['withdrawn', 'asset_linked', 'submitted']
    and not exists (select 1 from post_events where post_id = dp.id('p1') and id > dp.v('p1_last_event')::bigint
                     and (actor_kind <> 'drafter' or actor_id is not null)),
    (select string_agg(kind || '/' || actor_kind, ',' order by id) from post_events where post_id = dp.id('p1') and id > dp.v('p1_last_event')::bigint));
  select * into e from drafter_post_edits where operation_id = 'op-attach-p1-0001';
  perform dp.ok('A7 the edit record: operation, requester, before / after media, statuses',
    e.outcome = 'attached' and e.kind = 'attach_photo' and e.post_id = dp.id('p1') and e.drafter_run_id = dp.id('p1_run')
    and e.requested_via = 'team' and e.requested_by = dp.id('member') and e.requested_by is not null and e.runtime = 'sandbox-attach'
    and e.before_assets = '[]'::jsonb and e.after_assets->0->>'brand_asset_id' = dp.id('own')::text
    and e.content_hash = repeat('a1', 32) and e.depicts_own_work
    and e.before_review_status = 'in_review' and e.after_review_status = 'in_review'
    and e.before_review_task_id = dp.id('p1_task') and e.after_review_task_id = (r->>'review_task_id')::uuid, to_jsonb(e)::text);
end $$;

\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare r jsonb; e text; n bigint := (select count(*) from drafter_post_edits); v bigint := (select count(*) from post_events where post_id = dp.id('p1'));
begin
  r := drafter_attach_photo(dp.att(dp.id('p1'), dp.id('own'), 'op-attach-p1-0001', null, 'team', dp.id('member'))
                            || jsonb_build_object('expected_updated_at', '2020-01-01T00:00:00Z'));
  perform dp.ok('I1 a retry of the same operation replays its result, even after the post moved on',
    (r->>'replayed')::boolean and r->>'edit_id' = (dp.v('p1_result')::jsonb)->>'edit_id'
    and (select count(*) from drafter_post_edits) = n and (select count(*) from post_events where post_id = dp.id('p1')) = v, r::text);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own2'), 'op-attach-p1-0001')));
  perform dp.ok('I2 the same operation id for another photo is refused', e like 'DR409: operation_reused%', e);
  r := drafter_attach_photo(dp.att(dp.id('p1'), dp.id('own'), 'op-attach-p1-0002'));
  perform dp.ok('I3 attaching the photo it already has changes nothing',
    r->>'status' = 'unchanged' and r->>'review_task_id' = (dp.v('p1_result')::jsonb)->>'review_task_id'
    and (select count(*) from post_events where post_id = dp.id('p1')) = v, r::text);
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p1'), dp.id('own2'), 'op-attach-p1-0003')));
  perform dp.ok('I4 another image is never replaced or added', e like 'DR409: media_present%', e);

  -- A draft stays a draft; an approved illustration is allowed.
  r := drafter_attach_photo(dp.att(dp.id('p4'), dp.id('illus'), 'op-attach-p4-0001'));
  perform dp.ok('D1 a draft takes the photo and stays a draft; illustration is recorded as not own work',
    r->>'status' = 'attached' and r->>'review_status' = 'draft' and not (r->>'depicts_own_work')::boolean
    and (select review_status = 'draft' from social_posts where id = dp.id('p4'))
    and exists (select 1 from post_assets where post_id = dp.id('p4') and brand_asset_id = dp.id('illus')), r::text);
end $$;
reset role;

-- ── Rollback: a resubmit that grounding refuses leaves nothing behind ───────
\c - supabase_admin
update claims set status = 'unverified', source = null where id = dp.id('claim_rb');
\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare e text; v bigint := (select count(*) from post_events where post_id = dp.id('p3'));
begin
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p3'), dp.id('own2'), 'op-attach-p3-0001')));
  perform dp.ok('B1 the resubmit is refused by grounding', e like '23514:%cannot be submitted%', e);
  perform dp.ok('B2 ... and the withdrawal, link and record roll back with it',
    (select review_status = 'in_review' and review_task_id = dp.id('p3_task') from social_posts where id = dp.id('p3'))
    and (select status = 'open' from tasks where id = dp.id('p3_task'))
    and not exists (select 1 from post_assets where post_id = dp.id('p3'))
    and not exists (select 1 from drafter_post_edits where operation_id = 'op-attach-p3-0001')
    and (select count(*) from post_events where post_id = dp.id('p3')) = v);
end $$;
reset role;

-- ── A person approves; the drafter can no longer touch it ──────────────────
set role authenticated;
select fd.as_user('authenticated', :'team');
update social_posts set review_status = 'approved' where id = dp.id('p1');
update social_posts set review_status = 'approved' where id = dp.id('p2');
update social_posts set publish_status = 'scheduled', scheduled_at = now() + interval '7 days' where id = dp.id('p2');
reset role;
set role service_role;
select fd.as_user('service_role', null);
do $$
declare e text;
begin
  perform dp.ok('P1 the approval carries the photo as the publisher reads it (storage path and hash)',
    (select approved_snapshot->'assets'->0->>'id' = dp.id('own')::text
        and approved_snapshot->'assets'->0->>'content_hash' = repeat('a1', 32)
        and approved_snapshot->'assets'->0->>'storage_path' = '00000000-0000-4000-b000-00000000000b/scan/attach-a.jpg'
        and jsonb_array_length(approved_snapshot->'assets') = 1
     from social_posts where id = dp.id('p1')));
  e := fd.try(format('select drafter_attach_photo(%L::jsonb)', dp.att(dp.id('p2'), dp.id('own2'), 'op-attach-p2-0001')));
  perform dp.ok('P2 an approved, scheduled post is refused', e like 'DR409: post_state%approved%', e);
  perform dp.ok('P3 ... and stays approved and scheduled with no attempts',
    (select review_status = 'approved' and publish_status = 'scheduled' and publish_attempts = 0 from social_posts where id = dp.id('p2')));
end $$;
reset role;

-- ── Revocation after approval lapses it ─────────────────────────────────────
set role authenticated;
select fd.as_user('authenticated', :'team');
update brand_assets set creative_use = 'excluded', creative_review_note = 'Client asked us not to use it'
 where id = dp.id('own');
reset role;
\c - postgres
do $$
begin
  perform dp.ok('X1 excluding a linked photo sends the approved post back to review',
    (select review_status = 'in_review' and approved_hash is null from social_posts where id = dp.id('p1')));
  perform dp.ok('X2 ... with the excluded image named as the problem',
    (select 'A linked image is excluded from creative use; remove it or pick another.' = any (social_post_grounding_problems(p))
     from social_posts p where id = dp.id('p1')));
  perform dp.ok('X3 unreviewed images are not newly refused',
    not exists (select 1 from social_posts p join post_assets pa on pa.post_id = p.id join brand_assets b on b.id = pa.brand_asset_id
                 where b.creative_use = 'unreviewed'
                   and 'A linked image is excluded from creative use; remove it or pick another.' = any (social_post_grounding_problems(p))));
end $$;

-- ── The record is append-only ───────────────────────────────────────────────
do $$
declare e text;
begin
  e := fd.try($q$update drafter_post_edits set runtime = 'forged' where operation_id = 'op-attach-p1-0001'$q$);
  perform dp.ok('M1 the worker cannot edit an edit record', e like '42501:%immutable%', e);
  e := fd.try($q$delete from drafter_post_edits where operation_id = 'op-attach-p1-0001'$q$);
  perform dp.ok('M2 ... nor delete one', e like '42501:%', e);
  e := fd.try($q$insert into drafter_post_edits (operation_id, client_id, post_id, drafter_run_id, kind, outcome, brand_asset_id,
                   content_hash, before_review_status, after_review_status, before_assets, after_assets, requested_via, runtime, result)
                 values ('op-forged-00001', '00000000-0000-4000-b000-00000000000b', gen_random_uuid(), gen_random_uuid(), 'attach_photo',
                   'attached', gen_random_uuid(), repeat('00', 32), 'draft', 'draft', '[]', '[]', 'worker', 'x', '{}')$q$);
  perform dp.ok('M3 ... nor forge one', e like '42501:%', e);
end $$;
\c - authenticator
set role authenticated;
select fd.as_user('authenticated', :'team');
do $$
begin
  perform dp.ok('M4 a teammate reads the edit record',
    exists (select 1 from drafter_post_edits where operation_id = 'op-attach-p1-0001'));
end $$;
reset role;

\c - postgres
\o
\pset footer off
select status, count(*) from dp.results group by status order by status;
select n, status, name, detail from dp.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from dp.results where status = 'fail';
  if f > 0 then raise exception '% drafter attach check(s) failed', f; end if;
end $$;
