-- Tests for migration 20261008024508_social_history_style (Social History
-- SH2: Client Social Style Profiles), run by scripts/test-portal-sandbox.sh
-- on the same replay after social_history.test.sql. Own harness schema (shy)
-- and its own fictional clients.
--
-- Callers, as they reach production:
--   worker   psql as postgres (the Routine's SQL)
--   service  psql as authenticator, role service_role (the social-history
--            Edge Function's analyze mode)
--   person   psql as authenticator, role authenticated, team JWT
--   stranger psql as authenticator, role authenticated, a non-team sign-in
--
-- Proves: only the function records a profile and only a teammate approves
-- or rejects one (decision 1); approval is bound to the hash the teammate
-- saw; at most one proposed and one approved per client and platform; a
-- profile's content never changes; example posts are the client's own and
-- the voice examples come only from the learnable view (decision 6); the
-- approved read never returns a proposal; nothing outside the family reads
-- profiles and recording one changes no grounding (decisions 2 and 8).

\set team     '00000000-0000-4000-a000-000000000001'
\set stranger '00000000-0000-4000-a000-000000000014'

\o /dev/null
create schema shy;
create table shy.results (n serial, status text, name text, detail text);
create table shy.saved (k text primary key, v jsonb);
grant usage on schema shy to anon, authenticated, service_role, authenticator;
grant insert, select on shy.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on shy.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence shy.results_n_seq to anon, authenticated, service_role, authenticator;
create function shy.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into shy.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function shy.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function shy.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function shy.id(p_k text) returns uuid language sql immutable as $$ select md5('shy:' || p_k)::uuid $$;
create function shy.put(p_k text, p_v jsonb) returns void language sql as $$
  insert into shy.saved (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function shy.get(p_k text) returns jsonb language sql stable as $$ select v from shy.saved where k = p_k $$;
create function shy.post(p_platform_id text) returns uuid language sql stable security definer set search_path = public as $$
  select id from social_history_posts where platform = 'facebook' and platform_post_id = p_platform_id
$$;
create function shy.profile(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p) - 'profile' from social_history_style_profiles p where id = p_id
$$;
create function shy.grounding(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('intelligence', client_intelligence_input(p_client),
    'claims', (select count(*) from claims where client_id = p_client),
    'social_posts', (select count(*) from social_posts where client_id = p_client),
    'history', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id), '[]') from social_history_posts h where client_id = p_client))
$$;
-- A minimal compass-social-style/1 profile naming example posts.
create function shy.profile_doc(p_client uuid, p_reps uuid[], p_tops uuid[] default '{}', p_dnl uuid[] default '{}', p_tag text default 'a')
returns jsonb language sql immutable as $$
  select jsonb_build_object('schema', 'compass-social-style/1', 'analyzer_version', 'social-style-v1', 'client_id', p_client,
    'platform', 'facebook', 'as_of', '2026-10-08T01:00:00.000Z',
    'boundary', 'Style and performance evidence only. Never factual grounding.',
    'corpus', jsonb_build_object('imported', 4, 'learnable', 3, 'voice', 2, 'performance_eligible', 3),
    'traits', jsonb_build_object('tone', jsonb_build_object('labels', jsonb_build_object('conversational', 2), 'confidence', 'low', 'n', 2, 'tag', p_tag)),
    'representative', (select coalesce(jsonb_agg(jsonb_build_object('post_id', x, 'masked_copy', 'Copy')), '[]') from unnest(p_reps) x),
    'top_performers', (select coalesce(jsonb_agg(jsonb_build_object('post_id', x)), '[]') from unnest(p_tops) x),
    'outliers', '[]'::jsonb,
    'do_not_learn', jsonb_build_object('posts', (select coalesce(jsonb_agg(jsonb_build_object('post_id', x)), '[]') from unnest(p_dnl) x), 'phrases', '[]'::jsonb))
$$;
create function shy.fp(p_k text) returns text language sql immutable as $$ select encode(sha256(convert_to(p_k, 'UTF8')), 'hex') $$;
grant execute on all functions in schema shy to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (shy.id('s'), 'Style Roofing', 'Fictionville', 'MO', 'active'),
  (shy.id('o'), 'Other Style Roofing', 'Otherburg', 'MO', 'active');
insert into claims (client_id, claim, status, source) values
  (shy.id('s'), 'Installs Fictional brand shingles', 'sourced', 'https://style-roofing.example/about');

-- A Compass post for client s, published, whose copy the history repeats.
\c - supabase_admin
set session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, copy, external_post_id, published_url) values
  (shy.id('sp'), shy.id('s'), 'facebook', 'navigational',
   'Compass wrote this: our crew is out checking gutters across Fictionville this week.', null, null);
set session_replication_role = origin;

-- History for both clients, through the SH1 import functions.
\c - authenticator
set role service_role;
select shy.as_user('service_role', null);
do $$
declare r jsonb;
begin
  r := social_history_begin_import(shy.id('s'), 'facebook', '777000111', 'Style Roofing', 'd1d2c3d4e5f6a1b2c3d4e5f6', 10, now() - interval '365 days', null);
  perform social_history_record_posts((r ->> 'import_id')::uuid, jsonb_build_array(
    jsonb_build_object('platform_post_id', '777000111_1', 'permalink', 'https://www.facebook.com/777000111/posts/1', 'published_at', '2026-09-01T15:00:00Z',
      'copy', 'Another roof finished in Fictionville. Thanks to the crew for the careful work!', 'format', 'photo', 'media', '[]'::jsonb, 'is_paid', false, 'is_owner', true, 'raw', '{}'::jsonb, 'metrics', null),
    jsonb_build_object('platform_post_id', '777000111_2', 'permalink', 'https://www.facebook.com/777000111/posts/2', 'published_at', '2026-09-08T15:00:00Z',
      'copy', 'Your roof is your home''s first line of defense. Give us a call for an inspection.', 'format', 'reel', 'media', '[]'::jsonb, 'is_paid', false, 'is_owner', true, 'raw', '{}'::jsonb, 'metrics', null),
    jsonb_build_object('platform_post_id', '777000111_3', 'permalink', 'https://www.facebook.com/777000111/posts/3', 'published_at', '2026-09-15T15:00:00Z',
      'copy', 'Compass wrote this: our crew is out checking gutters across Fictionville this week.', 'format', 'photo', 'media', '[]'::jsonb, 'is_paid', false, 'is_owner', true, 'raw', '{}'::jsonb, 'metrics', null),
    jsonb_build_object('platform_post_id', '777000111_4', 'permalink', 'https://www.facebook.com/777000111/posts/4', 'published_at', '2026-09-22T15:00:00Z',
      'copy', 'Meet the crew! Fantasy football season is serious business around here.', 'format', 'photo', 'media', '[]'::jsonb, 'is_paid', false, 'is_owner', true, 'raw', '{}'::jsonb, 'metrics', null)));
  perform social_history_finish_import((r ->> 'import_id')::uuid, 'completed', null, '{"complete": false}');
  r := social_history_begin_import(shy.id('o'), 'facebook', '777000222', 'Other Style Roofing', 'e1d2c3d4e5f6a1b2c3d4e5f6', 10, now() - interval '365 days', null);
  perform social_history_record_posts((r ->> 'import_id')::uuid, jsonb_build_array(
    jsonb_build_object('platform_post_id', '777000222_1', 'permalink', 'https://www.facebook.com/777000222/posts/1', 'published_at', '2026-09-01T15:00:00Z',
      'copy', 'A post of another client, long enough to be compared by copy.', 'format', 'photo', 'media', '[]'::jsonb, 'is_paid', false, 'is_owner', true, 'raw', '{}'::jsonb, 'metrics', null)));
  perform social_history_finish_import((r ->> 'import_id')::uuid, 'completed', null, '{"complete": false}');
end $$;
select shy.put('before', shy.grounding(shy.id('s')));
reset role;
\c - postgres

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  perform shy.ok('S1 RLS is on and only the team policy exists',
    (select relrowsecurity from pg_class where oid = 'public.social_history_style_profiles'::regclass)
    and (select count(*) = 1 and bool_and(qual like '%is_team()%') from pg_policies where schemaname = 'public' and tablename = 'social_history_style_profiles'));
  perform shy.ok('S2 nobody writes profiles directly (teammate, service role, anon)',
    not has_table_privilege('authenticated', 'public.social_history_style_profiles', 'insert, update, delete')
    and not has_table_privilege('service_role', 'public.social_history_style_profiles', 'insert, update, delete')
    and not has_table_privilege('anon', 'public.social_history_style_profiles', 'select, insert, update, delete'));
  perform shy.ok('S3 recording is the service role''s only; review is the teammate''s only; anon reads nothing',
    has_function_privilege('service_role', 'social_history_style_record(uuid, text, text, jsonb, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'social_history_style_record(uuid, text, text, jsonb, uuid)', 'execute')
    and has_function_privilege('authenticated', 'social_history_style_review(uuid, text, text, text)', 'execute')
    and not has_function_privilege('service_role', 'social_history_style_review(uuid, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'social_history_style_review(uuid, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'social_history_style_approved(uuid, text)', 'execute'));
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'social_history_style' and p.proname !~ '^social_history_';
  perform shy.ok('S4 decision 8: no function outside the family reads profiles', v is null, v);
  select string_agg(viewname, ', ') into v from pg_views
   where schemaname = 'public' and definition ~ 'social_history_style' and viewname !~ '^social_history_';
  perform shy.ok('S5 no view outside the family reads profiles', v is null, v);
  perform shy.ok('S6 neither the drafter nor Authority reads them (client_intelligence_input, authority_input, drafter_write)',
    not exists (select 1 from pg_proc where proname in ('client_intelligence_input', 'authority_input', 'drafter_write', 'authority_record_run')
                 and prosrc ~ 'social_history'));
  perform shy.ok('S7 the Compass copy match left post 3 out of the learnable view',
    not exists (select 1 from social_history_learnable_posts where id = shy.post('777000111_3'))
    and exists (select 1 from social_history_learnable_posts where id = shy.post('777000111_1')));
end $$;

-- ── W. The worker's SQL and a teammate cannot record ───────────────────────
do $$
declare e text;
begin
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$,
    shy.id('s'), shy.fp('w'), shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')])));
  perform shy.ok('W1 the worker''s SQL cannot record a profile', e like '42501%', e);
  e := shy.try(format($q$insert into social_history_style_profiles (client_id, platform, version, analyzer_version, input_fingerprint, as_of,
    posts_imported, posts_learnable, posts_voice, posts_performance, profile, profile_hash) values (%L, 'facebook', 1, 'social-style-v1', %L, now(), 0, 0, 0, 0, '{}', %L)$q$,
    shy.id('s'), shy.fp('w'), shy.fp('w')));
  perform shy.ok('W2 the worker''s SQL cannot insert one either (guard)', e like '42501%', e);
  perform set_config('compass.social_history_write', 'on', true);
  e := shy.try(format($q$insert into social_history_style_profiles (client_id, platform, version, analyzer_version, input_fingerprint, as_of,
    posts_imported, posts_learnable, posts_voice, posts_performance, profile, profile_hash) values (%L, 'facebook', 1, 'social-style-v1', %L, now(), 0, 0, 0, 0, '{}', %L)$q$,
    shy.id('s'), shy.fp('w'), shy.fp('w')));
  perform shy.ok('W3 not even with the write flag set', e like '42501%', e);
  perform set_config('compass.social_history_write', '', true);
end $$;

\c - authenticator
set role authenticated;
select shy.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$,
    shy.id('s'), shy.fp('w'), shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')])));
  perform shy.ok('W4 a teammate cannot record a profile (the function records)', e like '42501%', e);
end $$;
reset role;

-- ── R. The function records ─────────────────────────────────────────────────
set role service_role;
select shy.as_user('service_role', null);
do $$
declare r jsonb; r2 jsonb; e text; doc jsonb;
begin
  doc := shy.profile_doc(shy.id('s'), array[shy.post('777000111_1'), shy.post('777000111_2')], array[shy.post('777000111_2')], array[shy.post('777000111_3')], 'v1');
  r := social_history_style_record(shy.id('s'), 'facebook', shy.fp('v1'), doc);
  perform shy.put('v1', r);
  perform shy.ok('R1 a profile is recorded as proposed, version 1, hashed over the stored jsonb',
    r ->> 'status' = 'proposed' and (r ->> 'version')::int = 1 and not (r ->> 'unchanged')::boolean
    and r ->> 'profile_hash' = encode(sha256(convert_to(doc::text, 'UTF8')), 'hex'), r::text);
  r2 := social_history_style_record(shy.id('s'), 'facebook', shy.fp('v1'), doc);
  perform shy.ok('R2 the same fingerprint and analyzer version is a no-op', (r2 ->> 'unchanged')::boolean and r2 ->> 'id' = r ->> 'id', r2::text);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$, shy.id('s'), shy.fp('compass'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000111_3')])));
  perform shy.ok('R3 decision 6: a Compass post cannot be a representative example', e like '22023%' and e like '%learnable%', e);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$, shy.id('s'), shy.fp('compass-top'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')], array[shy.post('777000111_3')])));
  perform shy.ok('R4 nor a top performer', e like '22023%', e);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$, shy.id('s'), shy.fp('other'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000222_1')])));
  perform shy.ok('R5 another client''s post cannot be an example', e like '22023%' and e like '%not this client%', e);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$, shy.id('s'), shy.fp('bad'),
    shy.profile_doc(shy.id('o'), array[shy.post('777000111_1')])));
  perform shy.ok('R6 a profile for another client is refused', e like '22023%', e);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', %L, %L)$q$, shy.id('s'), shy.fp('bad2'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')]) - 'boundary'));
  perform shy.ok('R7 a profile without its boundary statement is refused', e like '22023%', e);
  e := shy.try(format($q$select social_history_style_record(%L, 'facebook', 'not-a-hash', %L)$q$, shy.id('s'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')])));
  perform shy.ok('R8 a malformed fingerprint is refused', e like '23514%', e);
  r2 := social_history_style_record(shy.id('s'), 'facebook', shy.fp('v2'),
    shy.profile_doc(shy.id('s'), array[shy.post('777000111_1'), shy.post('777000111_4')], '{}', '{}', 'v2'));
  perform shy.put('v2', r2);
  perform shy.ok('R9 a new analysis is version 2 and supersedes the open proposal',
    (r2 ->> 'version')::int = 2 and r2 ->> 'superseded' = r ->> 'id'
    and shy.profile((r ->> 'id')::uuid) ->> 'status' = 'superseded'
    and shy.profile((r ->> 'id')::uuid) ->> 'superseded_by' = r2 ->> 'id'
    and (select count(*) from social_history_style_profiles where client_id = shy.id('s') and status = 'proposed') = 1, r2::text);
  e := shy.try(format($q$select social_history_style_review(%L, 'approve', %L)$q$, r2 ->> 'id', r2 ->> 'profile_hash'));
  perform shy.ok('R10 the service role cannot approve (decision 1)', e like '42501%', e);
end $$;
reset role;
\c - postgres
do $$
declare e text; v2 jsonb := shy.get('v2');
begin
  e := shy.try(format($q$select social_history_style_review(%L, 'approve', %L)$q$, v2 ->> 'id', v2 ->> 'profile_hash'));
  perform shy.ok('R11 nor can the worker''s SQL', e like '42501%', e);
  e := shy.try(format($q$update social_history_style_profiles set status = 'approved', reviewed_at = now() where id = %L$q$, v2 ->> 'id'));
  perform shy.ok('R12 nor approve by a direct update', e like '42501%', e);
end $$;

-- ── V. A teammate reviews ───────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select shy.as_user('authenticated', :'team');
do $$
declare e text; v1 jsonb := shy.get('v1'); v2 jsonb := shy.get('v2'); r jsonb;
begin
  perform shy.ok('V0 the approved read returns nothing while only a proposal exists',
    social_history_style_approved(shy.id('s')) is null);
  e := shy.try(format($q$select social_history_style_review(%L, 'approve', %L)$q$, v2 ->> 'id', repeat('0', 64)));
  perform shy.ok('V1 approval is bound to the hash the teammate saw', e like 'SH409%', e);
  e := shy.try(format($q$select social_history_style_review(%L, 'reject', %L, ' ')$q$, v2 ->> 'id', v2 ->> 'profile_hash'));
  perform shy.ok('V2 rejecting needs a reason', e like '22023%', e);
  e := shy.try(format($q$select social_history_style_review(%L, 'approve', %L)$q$, v1 ->> 'id', v1 ->> 'profile_hash'));
  perform shy.ok('V3 a superseded proposal cannot be approved', e like 'SH409%', e);
  r := social_history_style_review((v2 ->> 'id')::uuid, 'approve', v2 ->> 'profile_hash', 'Sounds like them.');
  perform shy.ok('V4 a teammate approves the proposal; the reviewer is recorded',
    r ->> 'status' = 'approved' and shy.profile((v2 ->> 'id')::uuid) ->> 'reviewed_by' is not null
    and shy.profile((v2 ->> 'id')::uuid) ->> 'review_note' = 'Sounds like them.', r::text);
  perform shy.ok('V5 the approved read returns exactly that profile',
    social_history_style_approved(shy.id('s')) ->> 'id' = v2 ->> 'id'
    and (social_history_style_approved(shy.id('s')) -> 'profile' -> 'traits' -> 'tone' ->> 'tag') = 'v2');
  e := shy.try(format($q$select social_history_style_review(%L, 'reject', %L, 'x')$q$, v2 ->> 'id', v2 ->> 'profile_hash'));
  perform shy.ok('V6 an approved profile is not reviewed again', e like 'SH409%', e);
  e := shy.try(format($q$update social_history_style_profiles set profile = '{}' where id = %L$q$, v2 ->> 'id'));
  perform shy.ok('V7 a teammate cannot edit a profile', e like '42501%', e);
  e := shy.try(format($q$delete from social_history_style_profiles where id = %L$q$, v2 ->> 'id'));
  perform shy.ok('V8 nor delete one', e like '42501%', e);
end $$;
reset role;

-- A third analysis; the teammate then excludes one of its examples.
set role service_role;
select shy.as_user('service_role', null);
select shy.put('v3', social_history_style_record(shy.id('s'), 'facebook', shy.fp('v3'),
  shy.profile_doc(shy.id('s'), array[shy.post('777000111_2')], '{}', '{}', 'v3')));
reset role;
set role authenticated;
select shy.as_user('authenticated', :'team');
do $$
declare e text; v2 jsonb := shy.get('v2'); v3 jsonb := shy.get('v3'); r jsonb;
begin
  perform shy.ok('V9 a new proposal leaves the approved profile in force',
    shy.profile((v2 ->> 'id')::uuid) ->> 'status' = 'approved' and v3 ->> 'superseded' is null
    and social_history_style_approved(shy.id('s')) ->> 'id' = v2 ->> 'id', v3::text);
  perform social_history_set_learning(shy.post('777000111_2'), 'excluded', 'An outdated offer.');
  e := shy.try(format($q$select social_history_style_review(%L, 'approve', %L)$q$, v3 ->> 'id', v3 ->> 'profile_hash'));
  perform shy.ok('V10 approval is refused when an example post left the learnable set since the analysis', e like 'SH409%' and e like '%learnable%', e);
  r := social_history_style_review((v3 ->> 'id')::uuid, 'reject', v3 ->> 'profile_hash', 'Built on an excluded post.');
  perform shy.ok('V11 rejecting it is fine and final',
    r ->> 'status' = 'rejected' and shy.profile((v3 ->> 'id')::uuid) ->> 'status' = 'rejected');
  perform social_history_set_learning(shy.post('777000111_2'), 'included', null);
end $$;
reset role;

set role service_role;
select shy.as_user('service_role', null);
select shy.put('v4', social_history_style_record(shy.id('s'), 'facebook', shy.fp('v4'),
  shy.profile_doc(shy.id('s'), array[shy.post('777000111_1')], '{}', '{}', 'v4')));
select shy.put('o1', social_history_style_record(shy.id('o'), 'facebook', shy.fp('o1'),
  shy.profile_doc(shy.id('o'), array[shy.post('777000222_1')])));
select shy.put('after', shy.grounding(shy.id('s')));
reset role;
set role authenticated;
select shy.as_user('authenticated', :'team');
do $$
declare v2 jsonb := shy.get('v2'); v4 jsonb := shy.get('v4'); r jsonb;
begin
  r := social_history_style_review((v4 ->> 'id')::uuid, 'approve', v4 ->> 'profile_hash');
  perform shy.ok('V12 approving a newer profile supersedes the old approved one (one approved at a time)',
    r ->> 'superseded' = v2 ->> 'id' and shy.profile((v2 ->> 'id')::uuid) ->> 'status' = 'superseded'
    and shy.profile((v2 ->> 'id')::uuid) ->> 'superseded_by' = v4 ->> 'id'
    and (select count(*) from social_history_style_profiles where client_id = shy.id('s') and status = 'approved') = 1
    and (v4 ->> 'version')::int = 4, r::text);
end $$;
reset role;

-- ── P. Strangers and anon ───────────────────────────────────────────────────
set role authenticated;
select shy.as_user('authenticated', :'stranger');
do $$
declare e text; v4 jsonb := shy.get('v4');
begin
  perform shy.ok('P1 a non-team sign-in sees no profile', not exists (select 1 from social_history_style_profiles));
  perform shy.ok('P2 and the approved read gives it nothing', social_history_style_approved(shy.id('s')) is null);
  e := shy.try(format($q$select social_history_style_review(%L, 'reject', %L, 'x')$q$, v4 ->> 'id', v4 ->> 'profile_hash'));
  perform shy.ok('P3 and it cannot review', e like '42501%' or e like 'P0002%', e);
end $$;
reset role;
set role anon;
select shy.as_user('anon', null);
do $$
declare e text;
begin
  e := shy.try('select count(*) from social_history_style_profiles');
  perform shy.ok('P4 anon reads nothing', e like '42501%', e);
end $$;
reset role;

-- ── G. Grounding unchanged ──────────────────────────────────────────────────
\c - postgres
do $$
declare b jsonb := shy.get('before'); a jsonb := shy.get('after');
begin
  perform shy.ok('G1 recording profiles changed nothing Client Intelligence reads', a -> 'intelligence' = b -> 'intelligence');
  perform shy.ok('G2 no claim or post was created', a -> 'claims' = b -> 'claims' and a -> 'social_posts' = b -> 'social_posts');
  perform shy.ok('G3 the imported history is unchanged by the analysis (learning toggles aside)',
    (select jsonb_agg(x - 'learning_status' - 'learning_note' - 'learning_set_by' - 'learning_set_at') from jsonb_array_elements(a -> 'history') x)
    = (select jsonb_agg(x - 'learning_status' - 'learning_note' - 'learning_set_by' - 'learning_set_at') from jsonb_array_elements(b -> 'history') x));
end $$;

-- ── D. A client's deletion cascades through the guard ──────────────────────
-- (client o: 0045 refuses deleting client s's draft Compass post.)
\c - supabase_admin
do $$
declare e text;
begin
  perform shy.ok('D0 client o has a profile to delete', exists (select 1 from social_history_style_profiles where client_id = shy.id('o')));
  e := shy.try(format('delete from clients where id = %L', shy.id('o')));
  perform shy.ok('D1 deleting a client removes its profiles (the guard lets the cascade through)',
    e is null and not exists (select 1 from social_history_style_profiles where client_id = shy.id('o'))
    and exists (select 1 from social_history_style_profiles where client_id = shy.id('s')), e);
end $$;

\c - postgres
\o
\pset footer off
select status, count(*) from shy.results group by status order by status;
select n, status, name, detail from shy.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from shy.results where status = 'fail';
  if f > 0 then raise exception '% social style check(s) failed', f; end if;
end $$;
