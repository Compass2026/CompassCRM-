-- Tests for Business Profile publishing through Zernio (20261011050000), run
-- by scripts/test-portal-sandbox.sh after zernio_publisher.test.sql against
-- the full replay + fixtures. Own harness schema (zg).
--
-- The publisher's behaviour is tests/post-publisher-gbp.test.mjs; this file
-- pins the database rules it relies on: only the publisher's service session
-- records and binds a client's Business Profile location (one per client,
-- `locations/<id>`, equal to the row's external id); binding never enables;
-- the worker's SQL cannot do it; a team admin enables against the account
-- they saw; Facebook's rules are unchanged; publisher_runs records the pinned
-- location for Zernio runs only; an approved post's destination changes only
-- by reopening it.

\set team     '00000000-0000-4000-a000-000000000001'
\set member   '00000000-0000-4000-a000-0000000000f1'
\set ca       '00000000-0000-4000-b000-00000000000a'
\set cb       '00000000-0000-4000-b000-00000000000b'

\o /dev/null
create schema zg;
create table zg.results (n serial, status text, name text, detail text);
create table zg.ids (k text primary key, id uuid);
grant usage on schema zg to anon, authenticated, service_role, authenticator;
grant insert, select on zg.results to anon, authenticated, service_role, authenticator;
grant insert, select on zg.ids to anon, authenticated, service_role, authenticator;
grant usage on sequence zg.results_n_seq to anon, authenticated, service_role, authenticator;
create function zg.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into zg.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function zg.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function zg.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function zg.id(p_k text) returns uuid language sql stable as $$ select id from zg.ids where k = p_k $$;
grant execute on all functions in schema zg to anon, authenticated, service_role, authenticator;

-- ── S. Shape (as postgres) ──────────────────────────────────────────────────
do $$
begin
  perform zg.ok('S1 publisher_bind_gbp_location is the service role''s only',
    has_function_privilege('service_role', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute'));
  perform zg.ok('S2 publisher_bind_account is still the service role''s only',
    has_function_privilege('service_role', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute'));
  perform zg.ok('S3 publisher_runs has target_location_id', exists (
    select 1 from information_schema.columns where table_name = 'publisher_runs' and column_name = 'target_location_id'));
  perform zg.ok('S4 no Business Profile location starts enabled',
    not exists (select 1 from social_accounts where platform = 'google_business' and publish_enabled));
  perform zg.ok('S5 the transport tables have RLS, only an is_team() read, and no API writes',
    (select relrowsecurity from pg_class where oid = 'public.publisher_client_transports'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.publisher_client_transport_events'::regclass)
    and (select count(*) from pg_policies where tablename in ('publisher_client_transports', 'publisher_client_transport_events')
         and cmd = 'SELECT' and qual like '%is_team()%') = 2
    and (select count(*) from pg_policies where tablename in ('publisher_client_transports', 'publisher_client_transport_events')) = 2
    and not has_table_privilege('authenticated', 'public.publisher_client_transports', 'insert,update,delete')
    and not has_table_privilege('service_role', 'public.publisher_client_transports', 'insert,update,delete')
    and not has_table_privilege('anon', 'public.publisher_client_transports', 'select'));
  perform zg.ok('S6 the transport recorder is nobody''s over the API; only an admin path sets it',
    not has_function_privilege('authenticated', 'public.publisher_record_gbp_transport(uuid, text, text, text)', 'execute')
    and not has_function_privilege('service_role', 'public.publisher_record_gbp_transport(uuid, text, text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.publisher_set_gbp_transport(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.publisher_set_gbp_transport(uuid, text)', 'execute'));
end $$;

-- ── W. The worker's SQL (postgres) cannot record or bind a location ─────────
do $$
declare e text;
begin
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', 'A', 'A', '{}')$q$);
  perform zg.ok('W1 the worker cannot call the location bind', e like '42501:%', e);
  e := zg.try($q$insert into social_accounts (client_id, platform, external_account_id, publish_provider, publish_account_id, publish_page_id, publish_verified_at)
                values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'locations/1234567890', 'zernio', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', now())$q$);
  perform zg.ok('W2 a bound location is never inserted directly', e like '42501:%', e);
  perform set_config('compass.publish_transport', 'bind', true);
  e := zg.try($q$insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind) values ('00000000-0000-4000-b000-00000000000a', 'zernio', 'publisher')$q$);
  perform zg.ok('W4 the worker cannot set a client''s transport, even with the flag', e like '42501:%', e);
  e := zg.try($q$insert into publisher_client_transport_events (client_id, to_transport, actor_kind) values ('00000000-0000-4000-b000-00000000000a', 'google', 'team')$q$);
  perform zg.ok('W5 ... nor write its history', e like '42501:%', e);
  perform set_config('compass.publish_transport', '', true);
  e := zg.try($q$select publisher_record_gbp_transport('00000000-0000-4000-b000-00000000000a', 'google', 'team', 'admin')$q$);
  perform zg.ok('W6 ... nor through the recorder (its guard checks the session)', e like '42501:%', e);
end $$;
set role service_role;
select zg.as_user('service_role', null);
do $$
declare e text;
begin
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', 'A', 'A', '{}')$q$);
  perform zg.ok('W3 SET ROLE service_role does not make the worker the publisher', e like '42501:%', e);
end $$;
reset role;

-- ── B. The publisher's service session records and binds the location ───────
\c - authenticator
set role service_role;
select zg.as_user('service_role', null);
do $$
declare e text; r jsonb;
begin
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'eeeeeeeeeeeeeeeeeeeeeee1', '1234567890', 'A', 'A', '{}')$q$);
  perform zg.ok('B1 a bare id is not a location resource', e like '23514:%locations/%', e);
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'Lucas Construction', 'locations/1234567890', 'A', 'A', '{}')$q$);
  perform zg.ok('B2 a name is not a Zernio account id', e like '23514:%', e);
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-0000000000ff', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', 'A', 'A', '{}')$q$);
  perform zg.ok('B3 an unknown client is refused', e like 'P0002:%', e);

  r := publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890',
                                   'Sandbox Client A - Springfield', 'Sandbox GBP', '{"status": "healthy"}');
  insert into zg.ids values ('ga', (r ->> 'social_account_id')::uuid);
  perform zg.ok('B4 the publisher records the client''s location row and binds it, never enabled',
    r ->> 'kind' = 'bound' and not (r ->> 'enabled')::boolean
    and (select platform = 'google_business' and external_account_id = 'locations/1234567890' and publish_page_id = 'locations/1234567890'
              and publish_account_id = 'eeeeeeeeeeeeeeeeeeeeeee1' and not publish_enabled and display_name = 'Sandbox Client A - Springfield'
         from social_accounts where id = zg.id('ga')), r::text);

  perform zg.ok('B4b binding a location selects zernio for the client, recorded as the publisher',
    (select gbp_transport = 'zernio' and changed_by_kind = 'publisher' from publisher_client_transports where client_id = '00000000-0000-4000-b000-00000000000a')
    and (select count(*) from publisher_client_transport_events where client_id = '00000000-0000-4000-b000-00000000000a' and to_transport = 'zernio' and actor_kind = 'publisher') = 1);
  e := zg.try($q$update publisher_client_transports set gbp_transport = 'google' where client_id = '00000000-0000-4000-b000-00000000000a'$q$);
  perform zg.ok('B4c the service session cannot write the transport directly', e like '42501:%', e);
  r := publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', 'renamed', 'Sandbox GBP', '{"status": "healthy"}');
  perform zg.ok('B5 binding the same location again re-verifies the same row',
    r ->> 'kind' = 'verified' and (r ->> 'social_account_id')::uuid = zg.id('ga')
    and (select count(*) from social_accounts where client_id = '00000000-0000-4000-b000-00000000000a' and platform = 'google_business') = 1, r::text);

  -- Several locations per client are allowed (20261027190935, covered in
  -- gbp_location_per_post.test.sql); a location never belongs to two clients.
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890', 'B', 'B', '{}')$q$);
  perform zg.ok('B6 client A''s location can never be bound for another client', e like '23505:%another client%', e);
  e := zg.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b', 'eeeeeeeeeeeeeeeeeeeeeee2', 'locations/1234567890', 'B', 'B', '{}')$q$);
  perform zg.ok('B7 ... not even through another Zernio account', e like '23505:%another client%', e);
  perform zg.ok('B8 ... and the refused bind left no location row behind for client B',
    not exists (select 1 from social_accounts where client_id = '00000000-0000-4000-b000-00000000000b' and platform = 'google_business'));
  e := zg.try(format($q$select publisher_bind_account(%L, 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/42', 'x', '{}')$q$, zg.id('ga')));
  perform zg.ok('B9 a re-verify that names another location is refused', e like '23514:%', e);
  e := zg.try(format($q$update social_accounts set publish_enabled = true where id = %L$q$, zg.id('ga')));
  perform zg.ok('B10 the service session cannot enable by writing the row', e like '42501:%', e);
end $$;
reset role;

-- ── E. A team admin enables, against the account they saw ───────────────────
set role authenticated;
select zg.as_user('authenticated', :'member');
do $$
declare e text;
begin
  e := zg.try(format($q$select publisher_set_account_enabled(%L, true, 'eeeeeeeeeeeeeeeeeeeeeee1')$q$, zg.id('ga')));
  perform zg.ok('E1 a member (not an admin) cannot enable', e like '42501:%', e);
end $$;
select zg.as_user('authenticated', :'team');
do $$
declare e text; r jsonb;
begin
  e := zg.try(format($q$update social_accounts set external_account_id = 'locations/77' where id = %L$q$, zg.id('ga')));
  perform zg.ok('E2 a bound location keeps its location id', e like '23514:%Unbind%', e);
  r := publisher_set_account_enabled(zg.id('ga'), true, 'eeeeeeeeeeeeeeeeeeeeeee1');
  perform zg.ok('E3 the admin enables the location; recorded in the history',
    (r ->> 'changed')::boolean
    and (select array_agg(kind order by id) from social_account_publish_events where social_account_id = zg.id('ga')) = array['bound', 'verified', 'enabled']
    and (select detail ->> 'platform' from social_account_publish_events where social_account_id = zg.id('ga') order by id limit 1) = 'google_business', r::text);
end $$;
reset role;

-- ── D. The approval binds the destination ───────────────────────────────────
-- A Business Profile post approved without a location keeps it; naming the
-- location is a draft edit, so an approved post must be reopened first.
\c - supabase_admin
do $$
declare v uuid;
begin
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'navigational', true, 'Sandbox Client A, plumbing in Springfield.')
  returning id into v;
  insert into zg.ids values ('gpost', v);
end $$;
\c - authenticator
set role authenticated;
select zg.as_user('authenticated', :'team');
do $$
declare e text;
begin
  update social_posts set social_account_id = zg.id('ga') where id = zg.id('gpost');
  perform zg.ok('D1 a draft Business Profile post can name the client''s location',
    (select social_account_id from social_posts where id = zg.id('gpost')) = zg.id('ga'));
  update social_posts set review_status = 'in_review' where id = zg.id('gpost');
  update social_posts set review_status = 'approved' where id = zg.id('gpost');
  perform zg.ok('D2 the approved snapshot carries the location',
    (select approved_snapshot ->> 'social_account_id' from social_posts where id = zg.id('gpost')) = zg.id('ga')::text);
  e := zg.try(format($q$update social_posts set social_account_id = (select id from social_accounts where client_id = '00000000-0000-4000-b000-00000000000a' and platform = 'facebook' limit 1) where id = %L$q$, zg.id('gpost')));
  perform zg.ok('D3 an approved post''s destination cannot be swapped in place', e like '23514:%frozen%', e);
  -- 0045's one later change is an account deleted under the post (FK SET
  -- NULL); the approval then no longer holds, so the claim refuses it.
  update social_posts set social_account_id = null where id = zg.id('gpost');
end $$;
reset role;

-- ── R. Repairing a post approved before it named a location ─────────────────
-- Posts approved before drafts carried a destination (Lucas, Sept 2026) hold
-- an approval with no location; the publisher refuses them (no_location). The
-- repair is the ordinary workflow: a person reopens (the approval is cleared),
-- names the client's own location as a draft, resubmits, and a person approves
-- again. Nothing rewrites the old approval and the worker cannot reopen.
\c - supabase_admin
do $$
declare v uuid;
begin
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'navigational', true, 'Sandbox Client A, approved before it named a location.')
  returning id into v;
  insert into zg.ids values ('rpost', v);
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'locations/555000', 'Sandbox Client B')
  returning id into v;
  insert into zg.ids values ('gb', v);
end $$;
\c - authenticator
set role authenticated;
select zg.as_user('authenticated', :'team');
update social_posts set review_status = 'in_review' where id = zg.id('rpost');
update social_posts set review_status = 'approved' where id = zg.id('rpost');
-- zg.ids holds uuids; the old hash is kept as its md5.
insert into zg.ids select 'rhash', md5(approved_hash)::uuid from social_posts where id = zg.id('rpost');
reset role;
\c - postgres
do $$
declare e text;
begin
  perform zg.ok('R1 the stranded state: approved, no location in the post or its approval',
    (select review_status = 'approved' and social_account_id is null and approved_snapshot ->> 'social_account_id' is null
     from social_posts where id = zg.id('rpost')));
  e := zg.try(format($q$update social_posts set review_status = 'draft' where id = %L$q$, zg.id('rpost')));
  perform zg.ok('R2 the worker cannot reopen an approved post', e like '42501:%signed-in%', e);
end $$;
\c - authenticator
set role authenticated;
select zg.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := zg.try(format($q$update social_posts set social_account_id = %L where id = %L$q$, zg.id('ga'), zg.id('rpost')));
  perform zg.ok('R3 the location cannot be added to the approval in place', e like '23514:%frozen%', e);
  update social_posts set review_status = 'draft' where id = zg.id('rpost');
  perform zg.ok('R4 a person reopens: the approval, its hash and the reviewer are cleared',
    (select review_status = 'draft' and publish_status = 'not_scheduled' and approved_snapshot is null
            and approved_hash is null and reviewed_by is null and reviewed_at is null
     from social_posts where id = zg.id('rpost')));
  e := zg.try(format($q$update social_posts set social_account_id = %L where id = %L$q$, zg.id('gb'), zg.id('rpost')));
  perform zg.ok('R5 another client''s location is refused', e like '23503:%', e);
  update social_posts set social_account_id = zg.id('ga') where id = zg.id('rpost');
  e := zg.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, zg.id('rpost')));
  perform zg.ok('R6 a reopened draft cannot skip review', e like '23514:%draft to approved%', e);
  update social_posts set review_status = 'in_review' where id = zg.id('rpost');
  update social_posts set review_status = 'approved' where id = zg.id('rpost');
  perform zg.ok('R7 a fresh approval binds the client''s location under a new hash',
    (select review_status = 'approved' and approved_snapshot ->> 'social_account_id' = zg.id('ga')::text
            and md5(approved_hash)::uuid <> zg.id('rhash') and reviewed_by is not null
     from social_posts where id = zg.id('rpost')));
  e := zg.try(format($q$update social_posts set social_account_id = %L where id = %L$q$, zg.id('gb'), zg.id('rpost')));
  perform zg.ok('R8 once approved again the destination is frozen', e like '23514:%frozen%', e);
end $$;
reset role;
\c - postgres
do $$
begin
  perform zg.ok('R9 the new approval matches the post as it stands (the publisher''s claim check)',
    (select approved_hash = social_post_hash(social_post_snapshot(p)) from social_posts p where id = zg.id('rpost')));
end $$;

-- ── T. The transport outlives the binding; only an admin returns to Google ──
\c - authenticator
set role authenticated;
select zg.as_user('authenticated', :'member');
do $$
declare e text;
begin
  e := zg.try($q$select publisher_set_gbp_transport('00000000-0000-4000-b000-00000000000a', 'google')$q$);
  perform zg.ok('T1 a member (not an admin) cannot change the transport', e like '42501:%', e);
end $$;
select zg.as_user('authenticated', :'team');
do $$
declare e text; r jsonb;
begin
  e := zg.try($q$select publisher_set_gbp_transport('00000000-0000-4000-b000-00000000000a', 'google')$q$);
  perform zg.ok('T2 returning to Google is refused while a location is bound', e like '23514:%binding%', e);
  r := publisher_unbind_account(zg.id('ga'));
  perform zg.ok('T3 removing the binding keeps the client on zernio (no silent return to Google)',
    (r ->> 'changed')::boolean
    and (select gbp_transport from publisher_client_transports where client_id = '00000000-0000-4000-b000-00000000000a') = 'zernio', r::text);
  e := zg.try($q$update publisher_client_transports set gbp_transport = 'google' where client_id = '00000000-0000-4000-b000-00000000000a'$q$);
  perform zg.ok('T4 a teammate cannot write the transport directly', e is not null, e);
  e := zg.try($q$select publisher_set_gbp_transport('00000000-0000-4000-b000-00000000000a', 'carrier-pigeon')$q$);
  perform zg.ok('T5 only google or zernio', e like '23514:%', e);
  r := publisher_set_gbp_transport('00000000-0000-4000-b000-00000000000a', 'google');
  perform zg.ok('T6 once unbound, an admin returns the client to Google explicitly; recorded with who',
    (r ->> 'changed')::boolean
    and (select gbp_transport = 'google' and changed_by_kind = 'team' and changed_by is not null from publisher_client_transports where client_id = '00000000-0000-4000-b000-00000000000a')
    and (select array_agg(from_transport || '>' || to_transport || ':' || actor_kind order by id) from publisher_client_transport_events
         where client_id = '00000000-0000-4000-b000-00000000000a') = array['google>zernio:publisher', 'zernio>google:team'], r::text);
  e := zg.try('delete from publisher_client_transport_events');
  perform zg.ok('T7 the transport history cannot be deleted through the API', e like '42501:%', e);
end $$;
reset role;

-- ── P. publisher_runs: the pinned location is a Zernio field ────────────────
\c - postgres
do $$
declare e text;
begin
  perform zg.ok('D4 a destination cleared under an approved post voids the approval (hash no longer matches)',
    (select social_post_hash(social_post_snapshot(p)) is distinct from p.approved_hash and p.review_status = 'approved'
     from social_posts p where id = zg.id('gpost')));
  e := zg.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, request_key, target_account_id, target_location_id)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'now', 'uncertain', 'zernio', 'compass-x-g1', 'eeeeeeeeeeeeeeeeeeeeeee1', 'locations/1234567890')$q$, zg.id('gpost')));
  perform zg.ok('P1 a Zernio run records its pinned location', e is null, e);
  e := zg.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, target_location_id)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'failed', 'google', 'locations/1234567890')$q$, zg.id('gpost')));
  perform zg.ok('P2 a Google run carries no Zernio location', e like '23514:%', e);
  e := zg.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, target_location_id)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'failed', 'zernio', '1234567890')$q$, zg.id('gpost')));
  perform zg.ok('P3 the location is a locations/<id> resource', e like '23514:%', e);
end $$;

\o
\pset footer off
select status, count(*) from zg.results group by status order by status;
select n, status, name, detail from zg.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from zg.results where status = 'fail';
  if f > 0 then raise exception '% zernio gbp check(s) failed', f; end if;
end $$;
