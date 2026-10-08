-- Tests for migration 20261008120000_social_history (Social History SH1),
-- run by scripts/test-portal-sandbox.sh on the same replay. Own harness
-- schema (shx) and its own fictional client; no real platform identifier.
--
-- Callers, as they reach production:
--   worker   psql as postgres (the Routine's SQL, data scripts)
--   service  psql as authenticator, role service_role (the social-history
--            Edge Function)
--   person   psql as authenticator, role authenticated, team JWT
--   portal   psql as authenticator, role authenticated, portal JWT
--   stranger psql as authenticator, role authenticated, a non-team sign-in
--   admin    psql as supabase_admin (fixtures only)
--
-- Proves: only the function writes history; history is never grounding
-- (no evidence function reads it, an import changes no Client Intelligence /
-- Authority input and no claim, offer, service or post); Compass-generated
-- posts never reach the learnable view; snapshots are append-only and
-- recorded only on change; the natural key makes re-import a no-op.

\set team     '00000000-0000-4000-a000-000000000001'
\set pa       '00000000-0000-4000-a000-000000000011'
\set stranger '00000000-0000-4000-a000-000000000014'

\o /dev/null
create schema shx;
create table shx.results (n serial, status text, name text, detail text);
create table shx.saved (k text primary key, v jsonb);
grant usage on schema shx to anon, authenticated, service_role, authenticator;
grant insert, select on shx.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on shx.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence shx.results_n_seq to anon, authenticated, service_role, authenticator;
create function shx.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into shx.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function shx.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function shx.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function shx.id(p_k text) returns uuid language sql immutable as $$ select md5('shx:' || p_k)::uuid $$;
create function shx.put(p_k text, p_v jsonb) returns void language sql as $$
  insert into shx.saved (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function shx.get(p_k text) returns jsonb language sql stable as $$ select v from shx.saved where k = p_k $$;
-- What the harness reads whoever is calling.
create function shx.post(p_platform_id text) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p) from social_history_posts p where platform = 'facebook' and platform_post_id = p_platform_id
$$;
create function shx.snapshots(p_platform_id text) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from social_history_metrics m join social_history_posts p on p.id = m.post_id
   where p.platform = 'facebook' and p.platform_post_id = p_platform_id
$$;
create function shx.grounding(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'intelligence', client_intelligence_input(p_client),
    'fingerprint', authority_fingerprint(p_client),
    'claims', (select count(*) from claims where client_id = p_client),
    'offers', (select count(*) from offers where client_id = p_client),
    'services', (select count(*) from services where client_id = p_client),
    'keywords', (select count(*) from keywords where client_id = p_client),
    'social_posts', (select coalesce(jsonb_agg(to_jsonb(sp) order by sp.id), '[]') from social_posts sp where client_id = p_client),
    'post_claims', (select count(*) from post_claims where client_id = p_client))
$$;
-- One mapped post as the function sends it.
create function shx.row(p_id text, p_copy text, o jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'platform_post_id', p_id, 'provider_post_id', 'ext-' || p_id, 'provider_scheduled_id', o -> 'provider_scheduled_id',
    'permalink', coalesce(o ->> 'permalink', 'https://www.facebook.com/' || replace(p_id, '_', '/posts/')),
    'published_at', coalesce(o ->> 'published_at', '2026-09-01T15:00:00Z'), 'copy', p_copy,
    'format', coalesce(o ->> 'format', 'photo'),
    'media', '[{"type":"image","url":"https://media.example/a.jpg","thumbnail_url":"https://media.example/a.jpg","alt":null,"status":null,"width":null,"height":null}]'::jsonb,
    'thumbnail_url', 'https://media.example/a.jpg', 'is_paid', coalesce((o ->> 'is_paid')::boolean, false),
    'is_owner', coalesce((o ->> 'is_owner')::boolean, true), 'raw', '{"zernio_id":"x"}'::jsonb,
    'metrics', case when o ? 'no_metrics' then null else jsonb_build_object(
      'provider_updated_at', '2026-10-07T12:00:00Z', 'sync_status', 'synced', 'impressions', null, 'reach', null,
      'reactions', coalesce((o ->> 'reactions')::int, 12), 'comments', 2, 'shares', 1, 'saves', null, 'clicks', 0, 'views', 0,
      'engagement_rate', null, 'unavailable', '["engagement_rate","impressions","reach","saves"]'::jsonb, 'raw', '{}'::jsonb) end)
$$;
grant execute on all functions in schema shx to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (shx.id('a'), 'History Roofing', 'Wentzville', 'MO', 'active'),
  (shx.id('b'), 'Other Roofing', 'Rolla', 'MO', 'active'),
  (shx.id('c'), 'Short-lived Roofing', 'Troy', 'MO', 'active');
insert into claims (client_id, claim, status, source) values
  (shx.id('a'), 'Installs Fictional brand shingles', 'sourced', 'https://history-roofing.example/about');

-- Compass's own Facebook posts for client a (a superuser fixture: 0045's
-- triggers are bypassed only to plant a published id and URL).
\c - supabase_admin
set session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, copy, external_post_id, published_url) values
  (shx.id('sp-copy'), shx.id('a'), 'facebook', 'navigational',
   'Compass drafted this one: gutter season is here, and our crew is booking fall cleanups now.', null, null),
  (shx.id('sp-id'), shx.id('a'), 'facebook', 'navigational', 'Short.', '555000111_2002', null),
  (shx.id('sp-url'), shx.id('a'), 'facebook', 'navigational', 'Also short.', null, 'https://www.facebook.com/555000111/posts/2003');
set session_replication_role = origin;

-- authority_fingerprint is team-only: read as the governed service caller.
\c - authenticator
set role service_role;
select shx.as_user('service_role', null);
select shx.put('before', shx.grounding(shx.id('a')));
reset role;
\c - postgres

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
declare t text; v text;
begin
  foreach t in array array['social_history_imports', 'social_history_posts', 'social_history_metrics'] loop
    perform shx.ok('S1 RLS is on and only the team policy exists on ' || t,
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
      and (select count(*) = 1 and bool_and(qual like '%is_team()%') from pg_policies where schemaname = 'public' and tablename = t));
    perform shx.ok('S2 nobody writes ' || t || ' directly (teammate, service role, anon)',
      not has_table_privilege('authenticated', 'public.' || t, 'insert, update, delete')
      and not has_table_privilege('service_role', 'public.' || t, 'insert, update, delete')
      and not has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete'));
  end loop;
  perform shx.ok('S3 anon reads neither view',
    not has_table_privilege('anon', 'public.social_history_post_latest', 'select')
    and not has_table_privilege('anon', 'public.social_history_learnable_posts', 'select'));
  perform shx.ok('S4 the writers are the service role''s only; learning is the teammate''s only',
    has_function_privilege('service_role', 'social_history_begin_import(uuid, text, text, text, text, int, timestamptz, uuid)', 'execute')
    and has_function_privilege('service_role', 'social_history_record_posts(uuid, jsonb)', 'execute')
    and has_function_privilege('service_role', 'social_history_finish_import(uuid, text, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'social_history_begin_import(uuid, text, text, text, text, int, timestamptz, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'social_history_record_posts(uuid, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'social_history_finish_import(uuid, text, text, jsonb)', 'execute')
    and not has_function_privilege('anon', 'social_history_record_posts(uuid, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'social_history_set_learning(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'social_history_set_learning(uuid, text, text)', 'execute'));
  -- Decision 8, after every migration: nothing outside the family reads history.
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'social_history_' and p.proname !~ '^social_history_';
  perform shx.ok('S5 no function outside social_history_* mentions Social History', v is null, v);
  select string_agg(viewname, ', ') into v from pg_views
   where schemaname = 'public' and definition ~ 'social_history_' and viewname !~ '^social_history_';
  perform shx.ok('S6 no view outside social_history_* reads Social History', v is null, v);
  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('client_intelligence_input', 'authority_input', 'authority_fingerprint', 'authority_record_run',
                       'authority_apply', 'social_post_grounding_problems', 'drafter_write', 'portal_client_id')
     and p.prosrc ~* 'social_history';
  perform shx.ok('S7 the Client Intelligence, Authority, grounding and drafter functions never read history', v is null, v);
  perform shx.ok('S8 those functions exist (S7 is not vacuous)',
    (select count(distinct proname) from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('client_intelligence_input', 'authority_input', 'authority_fingerprint', 'social_post_grounding_problems', 'drafter_write')) = 5);
  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^social_history_'
     and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(claims|offers|services|post_claims|post_assets|social_posts|keywords|client_brands|brand_assets|authority_\w+)\M';
  perform shx.ok('S9 no Social History function writes a grounding, post or Authority table', v is null, v);
  select string_agg(t.tgrelid::regclass::text, ', ') into v
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and p.prosrc ~ 'social_history_' and t.tgrelid::regclass::text !~ '^social_history_';
  perform shx.ok('S10 no trigger on another table reads Social History', v is null, v);
  perform shx.ok('S11 no portal view mentions Social History',
    not exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal_%' and definition ~ 'social_history'));
end $$;

-- ── W. The worker's SQL cannot write history ────────────────────────────────
do $$
declare st text;
begin
  st := shx.try(format($q$select social_history_begin_import(%L, 'facebook', '555000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('a')));
  perform shx.ok('W1 the worker cannot open an import', st like '42501:%', st);
  st := shx.try(format($q$insert into social_history_posts (client_id, social_account_id, platform, platform_post_id, origin,
      published_at, copy_hash, format, last_import_id) values (%L, %L, 'facebook', '1_1', 'external', now(), 'x', 'text', %L)$q$,
      shx.id('a'), shx.id('acct'), shx.id('imp')));
  perform shx.ok('W2 the worker cannot insert a post (the guard refuses)', st like '42501:%', st);
  perform set_config('compass.social_history_write', 'on', false);
  st := shx.try(format($q$select social_history_record_posts(%L, '[]')$q$, shx.id('imp')));
  perform shx.ok('W3 setting the write flag by hand does not open the door', st like '42501:%', st);
  perform set_config('compass.social_history_write', '', false);
end $$;
set role service_role;
do $$
declare st text;
begin
  st := shx.try(format($q$select social_history_begin_import(%L, 'facebook', '555000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('a')));
  perform shx.ok('W4 SET ROLE service_role does not let the worker open an import', st like '42501:%', st);
end $$;
reset role;

-- ── F. The social-history function (authenticator + service_role) ─────────
\c - authenticator
set role service_role;
select shx.as_user('service_role', null);
do $$
declare r jsonb; c jsonb; imp uuid; st text;
begin
  st := shx.try(format($q$select social_history_begin_import(%L, 'instagram', '555000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('a')));
  perform shx.ok('F0 SH1 imports Facebook only', st like '22023:%', st);
  r := social_history_begin_import(shx.id('a'), 'facebook', '555000111', 'History Roofing', 'a1b2c3d4e5f6a1b2c3d4e5f6', 50, now() - interval '365 days', null);
  imp := (r ->> 'import_id')::uuid;
  perform shx.put('imp1', r);
  perform shx.ok('F1 an import opens and records the account identity (manual_only, no token)',
    (select status = 'running' from social_history_imports where id = imp)
    and (select external_account_id = '555000111' and display_name = 'History Roofing' and status = 'manual_only' and access_token is null
           from social_accounts where id = (r ->> 'social_account_id')::uuid));
  st := shx.try(format($q$select social_history_begin_import(%L, 'facebook', '555000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('a')));
  perform shx.ok('F2 a second running import for the account is refused', st like '55P03:%', st);
  st := shx.try(format($q$select social_history_begin_import(%L, 'facebook', '555000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('b')));
  perform shx.ok('F3 a Page recorded for one client cannot be imported for another', st like '23505:%another client%', st);
  st := shx.try(format($q$select social_history_begin_import(%L, 'facebook', '999000111', 'x', 'a1b2c3d4e5f6a1b2c3d4e5f6', 10, now(), null)$q$, shx.id('a')));
  perform shx.ok('F4 a different Page for the same client is refused', st like '23505:%different Page%', st);

  c := social_history_record_posts(imp, jsonb_build_array(
    shx.row('555000111_2001', 'Another roof finished in Wentzville. Thanks to the crew for a great week!'),
    shx.row('555000111_2002', 'Copy that differs from the Compass post, matched by id.'),
    shx.row('555000111_2003', 'Copy that differs too, matched by the published URL.'),
    shx.row('555000111_2004', '  COMPASS drafted this one: gutter season is here,   and our crew is booking fall cleanups now.  '),
    shx.row('555000111_2005', 'Scheduled through the provider by the client.', '{"provider_scheduled_id": "67000000000000000000abcd"}'),
    shx.row('555000111_2006', 'Boosted post.', '{"is_paid": true}'),
    shx.row('555000111_2007', 'A visitor post on the Page.', '{"is_owner": false}'),
    shx.row('555000111_2008', 'No metrics yet.', '{"no_metrics": true}')));
  perform shx.ok('F5 eight posts recorded, seven snapshots (one had none)',
    c = '{"inserted": 8, "updated": 0, "unchanged": 0, "metrics_captured": 7}'::jsonb, c::text);
  perform shx.ok('F6 the origin is decided by the database: id, URL and copy matches are compass, the rest external / provider_scheduled',
    shx.post('555000111_2001') ->> 'origin' = 'external'
    and shx.post('555000111_2002') ->> 'origin' = 'compass' and (shx.post('555000111_2002') ->> 'compass_post_id')::uuid = shx.id('sp-id')
    and shx.post('555000111_2003') ->> 'origin' = 'compass' and (shx.post('555000111_2003') ->> 'compass_post_id')::uuid = shx.id('sp-url')
    and shx.post('555000111_2004') ->> 'origin' = 'compass' and (shx.post('555000111_2004') ->> 'compass_post_id')::uuid = shx.id('sp-copy')
    and shx.post('555000111_2005') ->> 'origin' = 'provider_scheduled');
  perform shx.ok('F7 the copy hash is the database''s, over normalised copy',
    shx.post('555000111_2004') ->> 'copy_hash' = social_history_copy_hash('compass drafted this one: gutter season is here, and our crew is booking fall cleanups now.'));

  c := social_history_record_posts(imp, jsonb_build_array(
    shx.row('555000111_2001', 'Another roof finished in Wentzville. Thanks to the crew for a great week!'),
    shx.row('555000111_2008', 'No metrics yet.', '{"no_metrics": true}')));
  perform shx.ok('F8 recording the same posts again changes nothing and adds no snapshot',
    c = '{"inserted": 0, "updated": 0, "unchanged": 2, "metrics_captured": 0}'::jsonb and shx.snapshots('555000111_2001') = 1, c::text);
  c := social_history_record_posts(imp, jsonb_build_array(
    shx.row('555000111_2001', 'Another roof finished in Wentzville. Thanks to the whole crew!', '{"reactions": 40}')));
  perform shx.ok('F9 an edited post updates in place; changed numbers append a snapshot',
    c = '{"inserted": 0, "updated": 1, "unchanged": 0, "metrics_captured": 1}'::jsonb
    and shx.post('555000111_2001') ->> 'copy' = 'Another roof finished in Wentzville. Thanks to the whole crew!'
    and shx.post('555000111_2001') ->> 'copy_changed_at' is not null
    and shx.snapshots('555000111_2001') = 2, c::text);
  c := social_history_record_posts(imp, jsonb_build_array(shx.row('555000111_2002', 'Copy that differs from the Compass post, matched by id.')));
  perform shx.ok('F10 a Compass post stays compass on re-import', shx.post('555000111_2002') ->> 'origin' = 'compass');

  st := shx.try(format($q$update social_history_metrics set reactions = 0 where post_id = %L$q$, shx.post('555000111_2001') ->> 'id'));
  perform shx.ok('F11 the service role cannot rewrite a snapshot directly', st like '42501:%', st);
  st := shx.try(format($q$update social_history_posts set copy = 'x' where id = %L$q$, shx.post('555000111_2001') ->> 'id'));
  perform shx.ok('F12 the service role cannot edit a post directly', st like '42501:%', st);
  st := shx.try(format($q$select social_history_record_posts(%L, %L)$q$, imp,
    (select jsonb_agg(shx.row('555000111_3' || lpad(g::text, 3, '0'), 'x')) from generate_series(1, 51) g)));
  perform shx.ok('F13 at most 50 posts per call', st like '22023:%', st);

  perform social_history_finish_import(imp, 'completed', null,
    '{"complete": true, "oldest_seen": "2026-08-01T00:00:00Z", "skipped": 1, "provider_state": {"available": 9}}');
  perform shx.ok('F14 the import finishes completed with its counts',
    (select status = 'completed' and finished_at is not null and fetched = 12 and inserted = 8 and skipped = 1
       and provider_state ->> 'available' = '9' from social_history_imports where id = imp));
  st := shx.try(format($q$select social_history_record_posts(%L, '[]')$q$, imp));
  perform shx.ok('F15 a finished import takes no more posts', st like '42501:%', st);

  -- A second import that no longer sees 2007: it is kept and marked missing.
  r := social_history_begin_import(shx.id('a'), 'facebook', '555000111', 'History Roofing', 'a1b2c3d4e5f6a1b2c3d4e5f6', 50, now() - interval '365 days', null);
  imp := (r ->> 'import_id')::uuid;
  c := social_history_record_posts(imp, jsonb_build_array(
    shx.row('555000111_2001', 'Another roof finished in Wentzville. Thanks to the whole crew!', '{"reactions": 40}'),
    shx.row('555000111_2002', 'Copy that differs from the Compass post, matched by id.'),
    shx.row('555000111_2003', 'Copy that differs too, matched by the published URL.'),
    shx.row('555000111_2004', '  COMPASS drafted this one: gutter season is here,   and our crew is booking fall cleanups now.  '),
    shx.row('555000111_2005', 'Scheduled through the provider by the client.', '{"provider_scheduled_id": "67000000000000000000abcd"}'),
    shx.row('555000111_2006', 'Boosted post.', '{"is_paid": true}')));
  perform shx.ok('F16a the second import sees six unchanged posts and adds no snapshot',
    c = '{"inserted": 0, "updated": 0, "unchanged": 6, "metrics_captured": 0}'::jsonb, c::text);
  perform social_history_finish_import(imp, 'completed', null, '{"complete": true, "oldest_seen": "2026-08-01T00:00:00Z"}');
  perform shx.ok('F16b a post a complete listing no longer returns is kept with missing_since',
    shx.post('555000111_2007') ->> 'missing_since' is not null and shx.post('555000111_2008') ->> 'missing_since' is not null
    and shx.post('555000111_2006') ->> 'missing_since' is null);
  r := social_history_begin_import(shx.id('a'), 'facebook', '555000111', 'History Roofing', 'a1b2c3d4e5f6a1b2c3d4e5f6', 50, now() - interval '365 days', null);
  perform social_history_finish_import((r ->> 'import_id')::uuid, 'failed', 'Zernio 429: Too many requests', '{"complete": false}');
  perform shx.ok('F17 a failed import keeps its reason',
    (select status = 'failed' and error like 'Zernio 429%' from social_history_imports where id = (r ->> 'import_id')::uuid));
  st := shx.try(format($q$select social_history_set_learning(%L, 'excluded', 'x')$q$, shx.post('555000111_2001') ->> 'id'));
  perform shx.ok('F18 the service cannot change what is learned', st like '42501:%', st);

  -- Client c: history and no Compass posts (D1 deletes it).
  r := social_history_begin_import(shx.id('c'), 'facebook', '555000333', 'Short-lived Roofing', 'c1c2c3d4e5f6a1b2c3d4e5f6', 10, now() - interval '365 days', null);
  perform social_history_record_posts((r ->> 'import_id')::uuid, jsonb_build_array(shx.row('555000333_1', 'A post.')));
  perform social_history_finish_import((r ->> 'import_id')::uuid, 'completed', null, '{"complete": false}');
end $$;
reset role;

-- ── T. A teammate ───────────────────────────────────────────────────────────
set role authenticated;
select shx.as_user('authenticated', :'team');
do $$
declare st text; n int;
begin
  perform shx.ok('T1 a teammate reads posts, snapshots, imports and the views',
    (select count(*) from social_history_posts where client_id = shx.id('a')) = 8
    and (select count(*) from social_history_metrics where client_id = shx.id('a')) >= 8
    and (select count(*) from social_history_imports where client_id = shx.id('a')) = 3
    and (select reactions from social_history_post_latest where platform_post_id = '555000111_2001') = 40);
  st := shx.try(format($q$update social_history_posts set learning_status = 'excluded', learning_note = 'x' where client_id = %L$q$, shx.id('a')));
  perform shx.ok('T2 a teammate cannot write a post directly', st like '42501:%', st);
  st := shx.try(format($q$select social_history_record_posts(%L, '[]')$q$, (shx.get('imp1') ->> 'import_id')));
  perform shx.ok('T3 a teammate cannot call the writers', st like '42501:%', st);

  select count(*) into n from social_history_learnable_posts where client_id = shx.id('a');
  perform shx.ok('T4 learnable: no Compass post, no paid post, no visitor post, nothing missing',
    n = 2 and (select array_agg(platform_post_id order by platform_post_id) from social_history_learnable_posts where client_id = shx.id('a'))
      = array['555000111_2001', '555000111_2005'], n::text);
  st := shx.try(format($q$select social_history_set_learning(%L, 'excluded')$q$, shx.post('555000111_2005') ->> 'id'));
  perform shx.ok('T5 excluding needs a reason', st like '22023:%', st);
  perform social_history_set_learning((shx.post('555000111_2005') ->> 'id')::uuid, 'excluded', 'A promotion that has ended.');
  perform shx.ok('T6 an excluded post leaves the learnable set and records who',
    not exists (select 1 from social_history_learnable_posts where platform_post_id = '555000111_2005')
    and shx.post('555000111_2005') ->> 'learning_set_by' is not null);
  st := shx.try(format($q$select social_history_set_learning(%L, 'included')$q$, shx.post('555000111_2004') ->> 'id'));
  perform shx.ok('T7 a Compass-generated post can never be included', st like '42501:%Compass-generated%', st);
  st := shx.try(format($q$delete from social_accounts where client_id = %L$q$, shx.id('a')));
  perform shx.ok('T7b a teammate cannot delete an account that has history (the cascade meets the guard)', st like '42501:%', st);
end $$;
reset role;

-- What Client Intelligence and Authority read, after the imports.
set role service_role;
select shx.as_user('service_role', null);
select shx.put('after', shx.grounding(shx.id('a')));
reset role;

-- A Compass post published after the import (by URL) leaves the learnable set at once.
\c - supabase_admin
set session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, copy, published_url) values
  (shx.id('sp-later'), shx.id('a'), 'facebook', 'navigational', 'Later.', 'https://www.facebook.com/555000111/posts/2001');
set session_replication_role = origin;
\c - authenticator
set role authenticated;
select shx.as_user('authenticated', :'team');
do $$
begin
  perform shx.ok('T8 a post matched to Compass after the import is excluded live (decision 6)',
    not exists (select 1 from social_history_learnable_posts where platform_post_id = '555000111_2001'));
end $$;
reset role;

-- ── P. Portal contact, stranger, anon ──────────────────────────────────────
set role authenticated;
select shx.as_user('authenticated', :'pa');
do $$
begin
  perform shx.ok('P1 a portal contact sees no Social History',
    (select count(*) from social_history_posts) = 0 and (select count(*) from social_history_metrics) = 0
    and (select count(*) from social_history_imports) = 0 and (select count(*) from social_history_learnable_posts) = 0);
  perform shx.ok('P2 a portal contact cannot change learning',
    shx.try(format($q$select social_history_set_learning(%L, 'excluded', 'x')$q$, shx.id('nope'))) like '42501:%');
end $$;
select shx.as_user('authenticated', :'stranger');
do $$
begin
  perform shx.ok('P3 a non-team sign-in sees no Social History',
    (select count(*) from social_history_posts) = 0 and (select count(*) from social_history_post_latest) = 0);
end $$;
reset role;
set role anon;
select shx.as_user('anon', null);
do $$
begin
  perform shx.ok('P4 anon reads nothing', shx.try('select count(*) from social_history_posts') like '42501:%'
    and shx.try('select count(*) from social_history_learnable_posts') like '42501:%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── G. History is never grounding ───────────────────────────────────────────
\c - postgres
do $$
declare b jsonb := shx.get('before'); a jsonb := shx.get('after');
begin
  perform shx.ok('G1 importing changed nothing Client Intelligence reads', a -> 'intelligence' = b -> 'intelligence');
  perform shx.ok('G2 importing changed no Authority fingerprint section', a -> 'fingerprint' = b -> 'fingerprint');
  perform shx.ok('G3 no claim, offer, service, keyword, post or post claim was created or changed',
    (a - 'intelligence' - 'fingerprint') = (b - 'intelligence' - 'fingerprint'));
  perform shx.ok('G4 the imported copy appears in no claim',
    not exists (select 1 from claims c join social_history_posts p on p.client_id = c.client_id
                 where social_history_norm_copy(c.claim) = social_history_norm_copy(p.copy)
                    or c.source = p.permalink));
end $$;

-- ── D. A client's deletion cascades through the guards ─────────────────────
\c - supabase_admin
do $$
declare e text;
begin
  perform shx.ok('D0 client c has history to delete', exists (select 1 from social_history_metrics where client_id = shx.id('c')));
  e := shx.try(format('delete from clients where id = %L', shx.id('c')));
  perform shx.ok('D1 deleting a client removes its history and account (the guard lets the cascade through)',
    e is null and not exists (select 1 from social_history_posts where client_id = shx.id('c'))
    and not exists (select 1 from social_history_metrics where client_id = shx.id('c'))
    and not exists (select 1 from social_history_imports where client_id = shx.id('c'))
    and not exists (select 1 from social_accounts where client_id = shx.id('c'))
    and exists (select 1 from social_history_posts where client_id = shx.id('a')), e);
end $$;

\c - postgres
\o
\pset footer off
select status, count(*) from shx.results group by status order by status;
select n, status, name, detail from shx.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from shx.results where status = 'fail';
  if f > 0 then raise exception '% social history check(s) failed', f; end if;
end $$;
