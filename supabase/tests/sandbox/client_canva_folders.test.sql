-- Tests for migration 0056 (Canva folder ids on the client record), run by
-- scripts/test-portal-sandbox.sh on the same replay after the 0055 suite.
-- Own harness schema (cf) and its own fictional clients, plus cf_replay
-- .seeded: what 0056's backfill wrote on the production-shaped clients the
-- replay hook inserted before it (supabase/tests/sandbox/replay/0056.*.sql).
--
-- Callers, as they reach production:
--   worker   psql as postgres
--   service  psql as authenticator, role service_role (an Edge Function)
--   person   psql as authenticator, role authenticated, team JWT
--   portal   psql as authenticator, role authenticated, portal JWT

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'

\o /dev/null
create schema cf;
create table cf.results (n serial, status text, name text, detail text);
create table cf.saved (k text primary key, v jsonb);
grant usage on schema cf, cf_replay to anon, authenticated, service_role, authenticator;
grant insert, select on cf.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on cf.saved to authenticated, service_role, authenticator;
grant select on cf_replay.seeded to authenticated, service_role, authenticator;
grant usage on sequence cf.results_n_seq to anon, authenticated, service_role, authenticator;
create function cf.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cf.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cf.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cf.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cf.id(p_k text) returns uuid language sql immutable as $$ select md5('cf:' || p_k)::uuid $$;
create function cf.set(p_client uuid, p_folder text, p_used text) returns text language sql as $$
  select cf.try(format('update clients set canva_folder_id = %L, canva_used_folder_id = %L where id = %L', p_folder, p_used, p_client))
$$;
grant execute on all functions in schema cf to anon, authenticated, service_role, authenticator;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values
  (cf.id('a'), 'Canva Roofing', 'Wentzville', 'MO', 'active'),
  (cf.id('b'), 'Canva Plumbing', 'Columbia', 'MO', 'launching'),
  (cf.id('none'), 'No Canva Masonry', 'Springfield', 'MO', 'active'),
  (cf.id('off'), 'Former Canva Client', 'Rolla', 'MO', 'offboarded'),
  (cf.id('paused'), 'Paused Canva Client', 'Joplin', 'MO', 'paused');

-- ── M. The backfill (production-shaped clients, via the replay hook) ────────
do $$
declare
  expected jsonb := '{
    "3eaa3389-2a33-4004-837c-8aef90404410": ["FAHWhNkklNQ", "FAHWhHij2r8"],
    "db9009c2-a04b-4e93-843f-e20c49263b5b": ["FAFkWjGulG4", "FAF50sDs_zY"],
    "70211d71-d9f4-46ab-abe2-ef39c41591fb": ["FAF3N2KiA2c", "FAF50jAeWzI"],
    "102d3b20-2795-44ae-bd64-d1e43916291c": ["FAFgsbtQBMU", "FAF50gfFIFo"],
    "1e12fc47-731a-4d84-a4f1-4aed777db451": ["FAFm0L4SN3I", "FAF50oq0gLs"],
    "a88f5ce2-30ac-508b-b217-cf22d277b278": ["FAHWhKRTBmM", "FAHWhFz-WfY"],
    "d94cfde2-0751-4002-a149-c83b4c6c956d": ["FAF1yAflBAI", "FAF50vURLLI"],
    "9a8e05f5-3d28-4839-9735-79bcdd0e277d": ["FAFmufa_fQo", "FAF50si5M04"]
  }';
  got jsonb;
  -- Canva folders with no Compass client (reconciliation of Sept 28 2026).
  canva_only text[] := array['FAFx93DuXNg', 'FAFgsRu4_l8', 'FAFgsSkSRAw', 'FAF0kbxL0WE', 'FAFtGAXTjGM',
    'FAF50o1Thgo', 'FAHAfqDEVD0', 'FAFm0cwmBNo', 'FAF50niyKaE', 'FAFgsUeShZo', 'FAF50gE50nM', 'FAFvbhk1pEA',
    'FAFPNKjVvv8', 'FAFRVPZH7rs', 'FAFxbyVX600', 'FAFndGJujHo', 'uploads'];
begin
  select jsonb_object_agg(id, jsonb_build_array(canva_folder_id, canva_used_folder_id)) into got
  from cf_replay.seeded where canva_folder_id is not null;
  perform cf.ok('M1 the backfill wrote exactly the eight confirmed mappings, keyed by client id',
    got = expected, got::text);
  perform cf.ok('M2 the replay held all nine production-shaped clients',
    (select count(*) from cf_replay.seeded) = 9);
  perform cf.ok('M3 the fictional offboarded Compass Activation Test client stays unmapped',
    (select canva_folder_id is null and canva_used_folder_id is null and status = 'offboarded'
     from cf_replay.seeded where id = '67f110bd-fb6e-4432-8536-7f192df92532'));
  perform cf.ok('M4 Show Me Design maps to the "ShowMe Design+Build" folder and its "Show Me Designs Used" subfolder',
    (select canva_folder_id = 'FAF1yAflBAI' and canva_used_folder_id = 'FAF50vURLLI'
     from cf_replay.seeded where id = 'd94cfde2-0751-4002-a149-c83b4c6c956d'));
  perform cf.ok('M5 Show Me Electrical maps to the "Show Me Electric" folder and the "Show Me Used" subfolder inside it',
    (select canva_folder_id = 'FAFmufa_fQo' and canva_used_folder_id = 'FAF50si5M04'
     from cf_replay.seeded where id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'));
  perform cf.ok('M6 the two Show Me clients share no folder',
    (select count(distinct x) = 4 from cf_replay.seeded s,
       unnest(array[s.canva_folder_id, s.canva_used_folder_id]) x
     where s.id in ('d94cfde2-0751-4002-a149-c83b4c6c956d', '9a8e05f5-3d28-4839-9735-79bcdd0e277d')));
  perform cf.ok('M7 no Canva-only folder is mapped to a Compass client',
    not exists (select 1 from cf_replay.seeded where canva_folder_id = any(canva_only) or canva_used_folder_id = any(canva_only)));
  perform cf.ok('M8 no folder name was stored as an id',
    not exists (select 1 from cf_replay.seeded where canva_folder_id ~ '\s' or canva_used_folder_id ~ '\s'));
end $$;

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
begin
  perform cf.ok('S1 both columns exist, are text and nullable',
    (select count(*) = 2 and bool_and(data_type = 'text' and is_nullable = 'YES') from information_schema.columns
     where table_schema = 'public' and table_name = 'clients' and column_name in ('canva_folder_id', 'canva_used_folder_id')));
  perform cf.ok('S2 a partial unique index per column, live clients only',
    (select count(*) = 2 from pg_indexes where tablename = 'clients'
       and indexname in ('clients_canva_folder_id_live', 'clients_canva_used_folder_id_live')
       and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%<> ''offboarded''%'));
  perform cf.ok('S3 the guard is a security-definer trigger nobody may call directly',
    (select prosecdef from pg_proc where oid = 'public.clients_canva_folders_guard()'::regprocedure)
    and not has_function_privilege('authenticated', 'public.clients_canva_folders_guard()', 'execute')
    and not has_function_privilege('anon', 'public.clients_canva_folders_guard()', 'execute')
    and exists (select 1 from pg_trigger where tgname = 'clients_canva_folders_guard' and tgrelid = 'public.clients'::regclass));
  perform cf.ok('S4 the read model is invoker rights, for the team and the service role, not anon',
    not (select prosecdef from pg_proc where oid = 'public.client_canva_folders(uuid)'::regprocedure)
    and has_function_privilege('authenticated', 'public.client_canva_folders(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.client_canva_folders(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.client_canva_folders(uuid)', 'execute'));
  perform cf.ok('S5 the portal''s client view does not expose the folder ids',
    not exists (select 1 from information_schema.columns where table_name = 'portal_client' and column_name like 'canva%'));
end $$;

-- ── N. Nullable: a client without Canva ─────────────────────────────────────
do $$
begin
  perform cf.ok('N1 a client is created without Canva folders',
    (select canva_folder_id is null and canva_used_folder_id is null from clients where id = cf.id('none')));
  perform cf.ok('N2 a primary folder alone is fine',
    cf.set(cf.id('none'), 'FAtestNone1', null) is null);
  perform cf.ok('N3 ...and clearing it again is fine (Canva stays optional)',
    cf.set(cf.id('none'), null, null) is null);
  perform cf.ok('N3b ...leaving both ids null',
    (select canva_folder_id is null and canva_used_folder_id is null from clients where id = cf.id('none')));
  perform cf.ok('N4 a Used folder without a primary folder is refused',
    cf.set(cf.id('none'), null, 'FAtestNone2') like '23514:%clients_canva_used_needs_primary%');
  perform cf.ok('N5 the same folder as primary and Used is refused',
    cf.set(cf.id('none'), 'FAtestNone1', 'FAtestNone1') like '23514:%clients_canva_folders_distinct%');
  perform cf.ok('N6 a folder name is not an id',
    cf.set(cf.id('none'), 'Lucas Used', null) like '23514:%clients_canva_folder_id_format%');
  perform cf.ok('N7 Canva''s pseudo-folders are not ids',
    cf.set(cf.id('none'), 'uploads', null) like '23514:%'
    and cf.set(cf.id('none'), 'root', null) like '23514:%');
  perform cf.ok('N8 a design id is not a folder id',
    cf.set(cf.id('none'), 'DAGw7dXmnjI', null) like '23514:%'
    and cf.set(cf.id('none'), 'FAtestNone1', 'DAGw7dXmnjI') like '23514:%clients_canva_used_folder_id_format%');
  perform cf.ok('N9 a client without Canva is unaffected by all of that',
    (select canva_folder_id is null and canva_used_folder_id is null from clients where id = cf.id('none')));
end $$;

-- ── D. No shared folders between live clients ───────────────────────────────
do $$
declare e text;
begin
  perform cf.ok('D1 client A takes a primary and a Used folder',
    cf.set(cf.id('a'), 'FAtestA0001', 'FAtestA0002') is null);
  e := cf.set(cf.id('b'), 'FAtestA0001', null);
  perform cf.ok('D2 client B cannot take A''s primary folder', e like '23505:%FAtestA0001%Canva Roofing%', e);
  e := cf.set(cf.id('b'), 'FAtestB0001', 'FAtestA0002');
  perform cf.ok('D3 ...nor A''s Used folder', e like '23505:%FAtestA0002%Canva Roofing%', e);
  e := cf.set(cf.id('b'), 'FAtestA0002', null);
  perform cf.ok('D4 ...nor A''s Used folder as its primary', e like '23505:%', e);
  e := cf.set(cf.id('b'), 'FAtestB0001', 'FAtestA0001');
  perform cf.ok('D5 ...nor A''s primary folder as its Used folder', e like '23505:%', e);
  perform cf.ok('D6 B takes folders of its own',
    cf.set(cf.id('b'), 'FAtestB0001', 'FAtestB0002') is null);
  perform cf.ok('D7 rewriting a client''s own mapping unchanged is fine',
    cf.set(cf.id('a'), 'FAtestA0001', 'FAtestA0002') is null);
  e := cf.try(format($q$insert into clients (name, status, canva_folder_id) values ('Copycat', 'active', %L)$q$, 'FAtestB0001'));
  perform cf.ok('D8 a new client cannot be created on a live client''s folder', e like '23505:%', e);
  e := cf.set(cf.id('paused'), 'FAtestA0001', null);
  perform cf.ok('D9 a paused client counts as live', e like '23505:%', e);
end $$;

-- The unique indexes hold even with the trigger out of the way.
alter table clients disable trigger clients_canva_folders_guard;
do $$
declare e text;
begin
  e := cf.set(cf.id('paused'), 'FAtestA0001', null);
  perform cf.ok('D10 the primary-folder index refuses a duplicate on its own',
    e like '23505:%clients_canva_folder_id_live%', e);
  e := cf.set(cf.id('paused'), 'FAtestP0001', 'FAtestB0002');
  perform cf.ok('D11 the Used-folder index refuses a duplicate on its own',
    e like '23505:%clients_canva_used_folder_id_live%', e);
end $$;
alter table clients enable trigger clients_canva_folders_guard;

do $$
declare e text;
begin
  perform cf.ok('D12 an offboarded client keeps a folder a live client holds (history only)',
    cf.set(cf.id('off'), 'FAtestA0001', 'FAtestA0002') is null);
  e := cf.try(format('update clients set status = %L where id = %L', 'active', cf.id('off')));
  perform cf.ok('D13 ...but reactivating it while A holds the folders is refused', e like '23505:%', e);
  perform cf.ok('D14 A offboarded frees its folders for another client',
    cf.try(format('update clients set status = %L where id = %L', 'offboarded', cf.id('a'))) is null
    and cf.set(cf.id('paused'), 'FAtestA0001', 'FAtestA0002') is null);
  -- Put A back on its own folders for the read-model checks.
  perform cf.set(cf.id('paused'), null, null);
  perform cf.try(format('update clients set status = %L where id = %L', 'active', cf.id('a')));
  perform cf.set(cf.id('off'), null, null);
  perform cf.ok('D15 A is live again on its folders',
    (select status = 'active' and canva_folder_id = 'FAtestA0001' from clients where id = cf.id('a')));
end $$;

-- ── R. Read model and access ────────────────────────────────────────────────
-- Baselines taken as a teammate before anything else changes.
\c - authenticator
set role authenticated;
select cf.as_user('authenticated', :'team');
do $$
declare r record;
begin
  select * into r from client_canva_folders(cf.id('a'));
  perform cf.ok('R1 a teammate reads one client''s folder ids',
    r.canva_folder_id = 'FAtestA0001' and r.canva_used_folder_id = 'FAtestA0002' and r.canva_enabled
    and r.client_name = 'Canva Roofing' and r.client_status = 'active');
  select * into r from client_canva_folders(cf.id('none'));
  perform cf.ok('R2 a client without Canva reads as not enabled, with null ids',
    r.client_id = cf.id('none') and r.canva_folder_id is null and r.canva_used_folder_id is null and not r.canva_enabled);
  perform cf.ok('R3 the list leaves offboarded clients out',
    not exists (select 1 from client_canva_folders() where client_id = cf.id('off'))
    and exists (select 1 from client_canva_folders() where client_id = cf.id('a')));
  select * into r from client_canva_folders(cf.id('off'));
  perform cf.ok('R4 asked by id, an offboarded client is returned but not enabled',
    r.client_status = 'offboarded' and not r.canva_enabled);
  -- No-impact baselines (section I compares against these).
  insert into cf.saved values
    ('fingerprint', authority_fingerprint(cf.id('b'))),
    ('intelligence', client_intelligence_input(cf.id('b')) - 'asOf'),
    -- authority_input stamps authority.now = now(): the one field that moves by itself.
    ('authority_input', (authority_input(cf.id('b')) - 'asOf') #- '{authority,now}');
end $$;
reset role;

set role service_role;
select cf.as_user('service_role', null);
do $$
begin
  perform cf.ok('R5 the service role (an Edge Function) reads the folder ids',
    (select canva_folder_id = 'FAtestB0001' and canva_used_folder_id = 'FAtestB0002' from client_canva_folders(cf.id('b'))));
end $$;
reset role;

select cf.as_user('authenticated', :'pa');
set role authenticated;
do $$
begin
  perform cf.ok('R6 a portal contact reads no folder ids',
    (select count(*) from client_canva_folders()) = 0
    and (select count(*) from client_canva_folders(cf.id('a'))) = 0);
  perform cf.ok('R7 ...and cannot map a folder',
    cf.set(cf.id('none'), 'FAtestPortal', null) is null
    and (select count(*) from clients where id = cf.id('none')) = 0);
end $$;
reset role;
set role anon;
select cf.as_user('anon', null);
do $$
begin
  perform cf.ok('R8 anon cannot call the read model',
    cf.try(format('select * from client_canva_folders(%L)', cf.id('a'))) like '42501:%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- A teammate maps and unmaps a folder (the ordinary team write path).
set role authenticated;
select cf.as_user('authenticated', :'team');
do $$
declare e text;
begin
  perform cf.ok('R9 a teammate maps a folder through PostgREST',
    cf.set(cf.id('none'), 'FAtestTeam1', null) is null);
  perform cf.ok('R9b ...and reads it back',
    (select canva_folder_id = 'FAtestTeam1' from client_canva_folders(cf.id('none'))));
  e := cf.set(cf.id('none'), 'FAtestA0001', null);
  perform cf.ok('R10 ...and is refused another live client''s folder, whatever RLS shows', e like '23505:%', e);
  perform cf.ok('R11 ...and unmaps it', cf.set(cf.id('none'), null, null) is null);
end $$;
reset role;

-- ── I. No impact on Authority, Drafter, Creative Engine, posts, publishing ──
\c - postgres
do $$
begin
  perform cf.ok('R12 the portal contact''s attempt changed nothing',
    (select canva_folder_id is null from clients where id = cf.id('none')));
  perform cf.ok('I1 only 0056''s own functions read the folder columns',
    (select array_agg(proname::text order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosrc ilike '%canva%')
    = array['client_canva_folders', 'clients_canva_folders_guard']);
  perform cf.ok('I2 no view reads them',
    not exists (select 1 from pg_views where schemaname = 'public' and definition ilike '%canva%'));
  perform cf.ok('I3 mapping creates no creative policy: the Creative Engine stays off for mapped clients',
    (select count(*) from client_creative_settings where client_id in (cf.id('a'), cf.id('b'))) = 0
    and creative_policy_for(cf.id('a'), 'gbp') = 'none' and creative_policy_for(cf.id('b'), 'facebook') = 'none');
  perform cf.ok('I4 ...and no creative runs, assets, posts or publisher runs',
    (select count(*) from creative_runs where client_id in (cf.id('a'), cf.id('b')))
    + (select count(*) from creative_assets where client_id in (cf.id('a'), cf.id('b')))
    + (select count(*) from social_posts where client_id in (cf.id('a'), cf.id('b')))
    + (select count(*) from publisher_runs where client_id in (cf.id('a'), cf.id('b'))) = 0);
  perform cf.ok('I5 the publisher switch is untouched',
    not exists (select 1 from app_settings where key = 'publisher' and value ->> 'enabled' = 'true'));
end $$;
-- Change B's mapping as the worker would, then compare as a teammate.
select cf.set(cf.id('b'), 'FAtestB0009', 'FAtestB0008');

\c - authenticator
set role authenticated;
select cf.as_user('authenticated', :'team');
do $$
begin
  perform cf.ok('I6 Authority''s fingerprint is unchanged by a Canva mapping change (no stale runs)',
    authority_fingerprint(cf.id('b')) = (select v from cf.saved where k = 'fingerprint'));
  perform cf.ok('I7 the Client Intelligence document (Drafter brief input) is unchanged',
    client_intelligence_input(cf.id('b')) - 'asOf' = (select v from cf.saved where k = 'intelligence'));
  perform cf.ok('I8 Authority''s input is unchanged',
    (authority_input(cf.id('b')) - 'asOf') #- '{authority,now}' = (select v from cf.saved where k = 'authority_input'));
  perform cf.ok('I9 neither document carries a Canva key',
    position('canva' in client_intelligence_input(cf.id('b'))::text) = 0
    and position('canva' in authority_input(cf.id('b'))::text) = 0);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from cf.results group by status order by status;
select n, status, name, detail from cf.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cf.results where status = 'fail';
  if f > 0 then raise exception '% Canva folder check(s) failed', f; end if;
end $$;
