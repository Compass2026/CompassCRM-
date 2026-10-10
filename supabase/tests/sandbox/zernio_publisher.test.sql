-- Tests for the Zernio Social Publisher v1 migration (20261010224407), run by
-- scripts/test-portal-sandbox.sh against the full replay + fixtures. Own
-- harness schema (zp).
--
-- The publisher's behaviour is tests/post-publisher-zernio.test.mjs; this
-- file pins the database rules it relies on: only the publisher's service
-- session binds a Facebook account to a Zernio account, only after naming
-- the row's own Page; binding never enables; only a signed-in team admin
-- enables, disables or unbinds, against the account they saw; the worker's
-- SQL can do none of it, flag or not; the history is append-only and
-- team-read; publisher_runs takes the Zernio fields and `submitted`; the gate
-- read is the service session's; a brand image carries its hash onto a post.

\set team     '00000000-0000-4000-a000-000000000001'
\set stranger '00000000-0000-4000-a000-000000000014'
\set member   '00000000-0000-4000-a000-0000000000f1'
\set ca       '00000000-0000-4000-b000-00000000000a'
\set cb       '00000000-0000-4000-b000-00000000000b'
\set zacc     'aaaaaaaaaaaaaaaaaaaaaaa1'

\o /dev/null
create schema zp;
create table zp.results (n serial, status text, name text, detail text);
create table zp.ids (k text primary key, id uuid);
grant usage on schema zp to anon, authenticated, service_role, authenticator;
grant insert, select on zp.results to anon, authenticated, service_role, authenticator;
grant select on zp.ids to anon, authenticated, service_role, authenticator;
grant usage on sequence zp.results_n_seq to anon, authenticated, service_role, authenticator;
create function zp.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into zp.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function zp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function zp.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function zp.id(p_k text) returns uuid language sql stable as $$ select id from zp.ids where k = p_k $$;
grant execute on all functions in schema zp to anon, authenticated, service_role, authenticator;

-- ── S. Shape (as postgres) ──────────────────────────────────────────────────
do $$
begin
  perform zp.ok('S1 social_accounts has the binding columns, publishing off by default',
    (select count(*) from information_schema.columns where table_name = 'social_accounts' and column_name like 'publish\_%') = 9
    and (select column_default from information_schema.columns where table_name = 'social_accounts' and column_name = 'publish_enabled') = 'false');
  perform zp.ok('S2 the history table has RLS and only an is_team() read policy',
    (select relrowsecurity from pg_class where oid = 'public.social_account_publish_events'::regclass)
    and (select count(*) from pg_policies where tablename = 'social_account_publish_events') = 1
    and exists (select 1 from pg_policies where tablename = 'social_account_publish_events' and cmd = 'SELECT' and qual like '%is_team()%'));
  perform zp.ok('S3 nobody writes the history through the API',
    not has_table_privilege('anon', 'public.social_account_publish_events', 'select,insert,update,delete')
    and not has_table_privilege('authenticated', 'public.social_account_publish_events', 'insert,update,delete,truncate')
    and not has_table_privilege('service_role', 'public.social_account_publish_events', 'insert,update,delete,truncate'));
  perform zp.ok('S4 publisher_bind_account is the service role''s only',
    has_function_privilege('service_role', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute'));
  perform zp.ok('S5 the admin functions are not anon''s; the gate read is the service role''s only',
    not has_function_privilege('anon', 'public.publisher_set_account_enabled(uuid, boolean, text)', 'execute')
    and not has_function_privilege('anon', 'public.publisher_unbind_account(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.publisher_post_gate(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.publisher_post_gate(uuid)', 'execute'));
  perform zp.ok('S6 publisher_runs accepts submitted and the transport columns',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'publisher_runs_outcome_check') like '%submitted%'
    and exists (select 1 from information_schema.columns where table_name = 'publisher_runs' and column_name = 'provider_media_url'));
  perform zp.ok('S7 no account starts enabled', not exists (select 1 from social_accounts where publish_enabled));
  perform zp.ok('S8 existing reminder runs are marked manual, Google runs google',
    not exists (select 1 from publisher_runs where mode = 'reminder' and transport <> 'manual'));
  perform zp.ok('S9 no portal view reads the binding or its history',
    not exists (select 1 from pg_views where viewname like 'portal\_%'
                and (definition ilike '%social_account_publish_events%' or definition ilike '%publish_account_id%')));
end $$;

-- ── Fixtures (as the cluster superuser) ─────────────────────────────────────
\c - supabase_admin
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000f1', 'zernio-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000f1', 'Zernio Member', 'zernio-member@compassmarketing.ai', 'member');
do $$
declare v uuid;
begin
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000a', 'facebook', '123456789012', 'Client A Page') returning id into v;
  insert into zp.ids values ('fa', v);
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000b', 'facebook', '222333444555', 'Client B Page') returning id into v;
  insert into zp.ids values ('fb', v);
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000a', 'instagram', '777888999000', 'Client A IG') returning id into v;
  insert into zp.ids values ('ig', v);
  insert into brand_assets (client_id, kind, label, storage_path, mime_type, width, height, content_hash, content_hashed_at)
  values ('00000000-0000-4000-b000-00000000000a', 'photo', 'Roof edge', '00000000-0000-4000-b000-00000000000a/photos/edge.jpg',
          'image/jpeg', 1600, 1200, repeat('ab', 32), now()) returning id into v;
  insert into zp.ids values ('img', v);
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy, social_account_id)
  values ('00000000-0000-4000-b000-00000000000a', 'facebook', 'navigational', true, 'Sandbox Client A, plumbing in Springfield.', zp.id('fa'))
  returning id into v;
  insert into zp.ids values ('post', v);
end $$;

-- ── W. The worker's SQL (postgres) can bind nothing, flag or not ────────────
\c - postgres
do $$
declare e text;
begin
  e := zp.try(format($q$update social_accounts set publish_provider = 'zernio', publish_account_id = %L, publish_page_id = '123456789012', publish_verified_at = now() where id = %L$q$, 'aaaaaaaaaaaaaaaaaaaaaaa1', zp.id('fa')));
  perform zp.ok('W1 the worker cannot write a binding', e like '42501:%', e);
  perform set_config('compass.publish_binding', 'bind', true);
  e := zp.try(format($q$update social_accounts set publish_provider = 'zernio', publish_account_id = %L, publish_page_id = '123456789012', publish_verified_at = now() where id = %L$q$, 'aaaaaaaaaaaaaaaaaaaaaaa1', zp.id('fa')));
  perform zp.ok('W2 ... not even with the bind flag', e like '42501:%', e);
  perform set_config('compass.publish_binding', 'admin', true);
  e := zp.try(format($q$update social_accounts set publish_enabled = true where id = %L$q$, zp.id('fa')));
  perform zp.ok('W3 ... nor enable with the admin flag', e is not null, e);
  perform set_config('compass.publish_binding', '', true);
  e := zp.try(format($q$select publisher_bind_account(%L, 'aaaaaaaaaaaaaaaaaaaaaaa1', '123456789012', 'x', '{}')$q$, zp.id('fa')));
  perform zp.ok('W4 the worker cannot call the bind function', e like '42501:%', e);
  e := zp.try($q$insert into social_accounts (client_id, platform, external_account_id, publish_enabled) values ('00000000-0000-4000-b000-00000000000a', 'facebook', '1', true)$q$);
  perform zp.ok('W5 an account is never inserted with publishing fields', e like '42501:%', e);
end $$;

set role service_role;
select zp.as_user('service_role', null);
do $$
declare e text;
begin
  e := zp.try(format($q$select publisher_bind_account(%L, 'aaaaaaaaaaaaaaaaaaaaaaa1', '123456789012', 'x', '{}')$q$, zp.id('fa')));
  perform zp.ok('W6 SET ROLE service_role does not make the worker the publisher', e like '42501:%', e);
  e := zp.try(format($q$select publisher_post_gate(%L)$q$, zp.id('post')));
  perform zp.ok('W7 ... nor let it read the gate', e like '42501:%', e);
end $$;
reset role;

-- ── B. The publisher's service session binds, after naming the row's Page ──
\c - authenticator
set role service_role;
select zp.as_user('service_role', null);
do $$
declare e text; r jsonb;
begin
  e := zp.try(format($q$select publisher_bind_account(%L, 'aaaaaaaaaaaaaaaaaaaaaaa1', '999999999999', 'x', '{}')$q$, zp.id('fa')));
  perform zp.ok('B1 a Zernio account posting to another Page is refused', e like '23514:%Page%', e);
  e := zp.try(format($q$select publisher_bind_account(%L, 'aaaaaaaaaaaaaaaaaaaaaaa1', '777888999000', 'x', '{}')$q$, zp.id('ig')));
  perform zp.ok('B2 only Facebook accounts are bound', e like '23514:%Facebook%', e);
  e := zp.try(format($q$select publisher_bind_account(%L, 'Lucas Construction', '123456789012', 'x', '{}')$q$, zp.id('fa')));
  perform zp.ok('B3 a name is not a Zernio account id', e like '23514:%', e);
  r := publisher_bind_account(zp.id('fa'), 'aaaaaaaaaaaaaaaaaaaaaaa1', '123456789012', 'Client A Page', '{"status": "healthy"}');
  perform zp.ok('B4 the publisher binds the exact account, and binding does not enable',
    r ->> 'kind' = 'bound' and (r ->> 'enabled')::boolean = false
    and (select publish_account_id = 'aaaaaaaaaaaaaaaaaaaaaaa1' and publish_page_id = '123456789012' and not publish_enabled
              and publish_verified_at is not null from social_accounts where id = zp.id('fa')), r::text);
  e := zp.try(format($q$select publisher_bind_account(%L, 'aaaaaaaaaaaaaaaaaaaaaaa1', '222333444555', 'x', '{}')$q$, zp.id('fb')));
  perform zp.ok('B5 one Zernio account can never serve two clients', e like '23505:%', e);
  e := zp.try(format($q$update social_accounts set publish_enabled = true where id = %L$q$, zp.id('fa')));
  perform zp.ok('B6 the service session cannot enable by writing the row', e like '42501:%', e);
  r := publisher_post_gate(zp.id('post'));
  perform zp.ok('B7 the gate read answers for a draft: not approved, no valid hash',
    r ->> 'review_status' = 'draft' and (r ->> 'hash_ok')::boolean = false, r::text);
end $$;
reset role;

-- ── E. A team admin enables, against the account they saw ───────────────────
set role authenticated;
select zp.as_user('authenticated', :'member');
do $$
declare e text;
begin
  e := zp.try(format($q$select publisher_set_account_enabled(%L, true, 'aaaaaaaaaaaaaaaaaaaaaaa1')$q$, zp.id('fa')));
  perform zp.ok('E1 a member (not an admin) cannot enable', e like '42501:%', e);
end $$;
select zp.as_user('authenticated', :'stranger');
do $$
declare e text;
begin
  e := zp.try(format($q$select publisher_set_account_enabled(%L, true, 'aaaaaaaaaaaaaaaaaaaaaaa1')$q$, zp.id('fa')));
  perform zp.ok('E2 a non-team sign-in cannot enable', e like '42501:%', e);
  perform zp.ok('E3 a non-team sign-in sees no binding history', (select count(*) from social_account_publish_events) = 0);
end $$;
select zp.as_user('authenticated', :'team');
do $$
declare e text; r jsonb;
begin
  e := zp.try(format($q$select publisher_set_account_enabled(%L, true, 'bbbbbbbbbbbbbbbbbbbbbbb2')$q$, zp.id('fa')));
  perform zp.ok('E4 enabling against a different account than bound is refused', e like '23514:%changed%', e);
  e := zp.try(format($q$select publisher_set_account_enabled(%L, true, null)$q$, zp.id('fb')));
  perform zp.ok('E5 an unbound account cannot be enabled', e like '23514:%', e);
  r := publisher_set_account_enabled(zp.id('fa'), true, 'aaaaaaaaaaaaaaaaaaaaaaa1');
  perform zp.ok('E6 the admin enables the bound account; who and when are recorded',
    (r ->> 'changed')::boolean and (select publish_enabled and publish_enabled_by is not null and publish_enabled_at is not null
                                    from social_accounts where id = zp.id('fa')), r::text);
  e := zp.try(format($q$update social_accounts set publish_account_id = 'cccccccccccccccccccccccc' where id = %L$q$, zp.id('fa')));
  perform zp.ok('E7 a teammate cannot rewrite the binding directly', e is not null, e);
  e := zp.try(format($q$update social_accounts set external_account_id = '555' where id = %L$q$, zp.id('fa')));
  perform zp.ok('E8 a bound account keeps its Page id', e like '23514:%Unbind%', e);
  perform zp.ok('E9 the team reads the history: bound, then enabled',
    (select array_agg(kind order by id) from social_account_publish_events where social_account_id = zp.id('fa')) = array['bound', 'enabled']);
  e := zp.try('delete from social_account_publish_events');
  perform zp.ok('E10 the history cannot be deleted through the API', e like '42501:%', e);
  e := zp.try('update social_account_publish_events set kind = ''unbound''');
  perform zp.ok('E11 ... nor edited', e like '42501:%', e);
  e := zp.try(format($q$select publisher_post_gate(%L)$q$, zp.id('post')));
  perform zp.ok('E12 a teammate cannot call the gate read', e like '42501:%', e);
end $$;
reset role;

-- ── R. Re-verifying keeps the switch; a different account turns it off ──────
set role service_role;
select zp.as_user('service_role', null);
do $$
declare r jsonb;
begin
  r := publisher_bind_account(zp.id('fa'), 'aaaaaaaaaaaaaaaaaaaaaaa1', '123456789012', 'Client A Page', '{"status": "healthy"}');
  perform zp.ok('R1 re-verifying the same account keeps it enabled', r ->> 'kind' = 'verified' and (r ->> 'enabled')::boolean, r::text);
  r := publisher_bind_account(zp.id('fa'), 'dddddddddddddddddddddddd', '123456789012', 'Client A Page', '{"status": "healthy"}');
  perform zp.ok('R2 binding a different Zernio account switches publishing off',
    r ->> 'kind' = 'bound' and not (r ->> 'enabled')::boolean
    and (select not publish_enabled and publish_enabled_by is null from social_accounts where id = zp.id('fa')), r::text);
end $$;
reset role;

-- ── U. The admin unbinds ────────────────────────────────────────────────────
set role authenticated;
select zp.as_user('authenticated', :'team');
do $$
declare r jsonb;
begin
  r := publisher_unbind_account(zp.id('fa'));
  perform zp.ok('U1 unbinding clears every publishing field and is recorded',
    (r ->> 'changed')::boolean
    and (select publish_provider is null and publish_account_id is null and publish_page_id is null and not publish_enabled
         from social_accounts where id = zp.id('fa'))
    and (select kind from social_account_publish_events where social_account_id = zp.id('fa') order by id desc limit 1) = 'unbound', r::text);

  -- M. A brand image linked to a draft carries its measured hash.
  insert into post_assets (post_id, client_id, brand_asset_id, sort_order)
  values (zp.id('post'), '00000000-0000-4000-b000-00000000000a', zp.id('img'), 1);
  perform zp.ok('M1 the link records the brand asset''s hash',
    (select content_hash from post_assets where post_id = zp.id('post') and brand_asset_id = zp.id('img')) = repeat('ab', 32));
end $$;
reset role;
select zp.as_user('anon', null);
set role anon;
do $$
declare e text;
begin
  e := zp.try('select * from social_account_publish_events');
  perform zp.ok('A1 anon reads no history', e like '42501:%', e);
end $$;
reset role;

-- ── P. publisher_runs takes Zernio rows, refuses Zernio fields elsewhere ────
\c - postgres
do $$
declare e text;
begin
  e := zp.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, provider_post_id, request_key, target_account_id, provider_media_url)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'submitted', 'zernio', 'abc123', 'compass-x-g1', 'aaaaaaaaaaaaaaaaaaaaaaa1', 'https://media.zernio.com/temp/x.jpg')$q$, zp.id('post')));
  perform zp.ok('P1 a submitted Zernio run is accepted', e is null, e);
  e := zp.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, provider_post_id)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'published', 'google', 'abc123')$q$, zp.id('post')));
  perform zp.ok('P2 a Google run carries no Zernio post id', e like '23514:%', e);
  e := zp.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport, provider_media_url)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'uncertain', 'zernio', 'http://insecure.example/x.jpg')$q$, zp.id('post')));
  perform zp.ok('P3 a media URL must be https', e like '23514:%', e);
  e := zp.try(format($q$insert into publisher_runs (post_id, client_id, mode, outcome, transport)
    values (%L, '00000000-0000-4000-b000-00000000000a', 'tick', 'published', 'carrier-pigeon')$q$, zp.id('post')));
  perform zp.ok('P4 an unknown transport is refused', e like '23514:%', e);
end $$;

\o
\pset footer off
select status, count(*) from zp.results group by status order by status;
select n, status, name, detail from zp.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from zp.results where status = 'fail';
  if f > 0 then raise exception '% zernio publisher check(s) failed', f; end if;
end $$;
