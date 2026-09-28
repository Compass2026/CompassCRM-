-- Tests for migration 0055 (source-asset hashing provenance and the stricter
-- creative-use review), run by scripts/test-portal-sandbox.sh on the same
-- replay after the 0054 suite. Own harness schema (sh) and its own clients,
-- one of them shaped like Lucas Construction's scanned library (12 photos, 2
-- logos without dimensions). Fictional data only.
--
-- Callers, as they reach production:
--   worker   psql as postgres (with or without SET ROLE)
--   hasher   psql as authenticator, role service_role (the source-assets
--            Edge Function through PostgREST)
--   person   psql as authenticator, role authenticated, team JWT
--   portal   psql as authenticator, role authenticated, portal JWT

\set team   '00000000-0000-4000-a000-000000000001'
\set pb     '00000000-0000-4000-a000-000000000012'

\o /dev/null
create schema sh;
create table sh.results (n serial, status text, name text, detail text);
grant usage on schema sh to anon, authenticated, service_role, authenticator;
grant insert, select on sh.results to anon, authenticated, service_role, authenticator;
grant usage on sequence sh.results_n_seq to anon, authenticated, service_role, authenticator;
create function sh.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into sh.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function sh.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function sh.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function sh.id(p_k text) returns uuid language sql immutable as $$ select md5('sh:' || p_k)::uuid $$;
create function sh.h(p_k text) returns text language sql immutable as $$ select encode(sha256(convert_to('bytes:' || p_k, 'UTF8')), 'hex') $$;
-- A record request as the source-assets function sends it.
create function sh.rec(p_asset uuid, p_hash text, p_expected text default null, p_w int default 1200, p_h int default 1600,
                       p_bytes bigint default 1000, p_type text default 'image/jpeg', p_path text default null,
                       p_orientation int default 1) returns jsonb
language sql stable as $$
  select jsonb_build_object('asset_id', p_asset,
    'storage_path', coalesce(p_path, (select storage_path from public.brand_assets where id = p_asset)),
    'expected_hash', p_expected, 'content_hash', p_hash, 'width', p_w, 'height', p_h, 'byte_size', p_bytes,
    'content_type', p_type, 'raw_width', case when p_orientation between 5 and 8 then p_h else p_w end,
    'raw_height', case when p_orientation between 5 and 8 then p_w else p_h end,
    'orientation', p_orientation, 'measured_by', 'source-assets/sandbox')
$$;
grant execute on all functions in schema sh to anon, authenticated, service_role, authenticator;

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into clients (id, name, city, state, website_url, status) values
  (sh.id('c'), 'Hash Roofing', 'Wentzville', 'MO', 'https://hash.example.test', 'active'),
  (sh.id('lucas'), 'Lucas-shaped Construction', 'Wentzville', 'MO', 'https://lucas.example.test', 'active');
insert into brand_assets (id, client_id, kind, label, source, storage_path, url, width, height) values
  (sh.id('a1'), sh.id('c'), 'photo', 'Finished roof', 'website_scan', sh.id('c') || '/scan/a1.jpg', 'https://hash.example.test/a1.jpg', 1200, 1600),
  (sh.id('a2'), sh.id('c'), 'photo', 'Crew', 'website_scan', sh.id('c') || '/scan/a2.jpg', null, 1200, 1600),
  (sh.id('gone'), sh.id('c'), 'photo', 'Missing file', 'website_scan', sh.id('c') || '/scan/gone.jpg', null, 1200, 1600),
  (sh.id('link'), sh.id('c'), 'photo', 'Link only', 'link', null, 'https://hash.example.test/link.jpg', null, null),
  (sh.id('logo'), sh.id('c'), 'logo_primary', 'Logo', 'website_scan', sh.id('c') || '/scan/logo.png', null, null, null);
insert into storage.objects (bucket_id, name, metadata) values
  ('brand-assets', sh.id('c') || '/scan/a1.jpg', '{"size": 1000, "mimetype": "image/jpeg"}'),
  ('brand-assets', sh.id('c') || '/scan/a2.jpg', '{"size": 1000, "mimetype": "image/jpeg"}'),
  ('brand-assets', sh.id('c') || '/scan/logo.png', '{"size": 500, "mimetype": "image/png"}');
-- The Lucas-shaped library: 12 scanned photos and 2 logos without dimensions.
insert into brand_assets (id, client_id, kind, label, source, storage_path, url, width, height, sort_order)
select sh.id('lp' || i), sh.id('lucas'), 'photo', case when i = 1 then 'Brick and stone home with a new roof' else 'Photo from the home page' end,
       'website_scan', sh.id('lucas') || '/scan/photo-' || i || '.jpg', 'https://lucas.example.test/p' || i || '.jpg',
       case when i <= 4 then 1066 else 950 end, case when i <= 4 then 1600 else 1200 end, 100 + i
from generate_series(1, 12) i;
insert into brand_assets (id, client_id, kind, label, source, storage_path, url) values
  (sh.id('llogo'), sh.id('lucas'), 'logo_primary', 'Logo', 'website_scan', sh.id('lucas') || '/scan/logo.png', 'https://lucas.example.test/logo.png'),
  (sh.id('licon'), sh.id('lucas'), 'logo_icon', 'Site icon (192px)', 'website_scan', sh.id('lucas') || '/scan/icon.png', 'https://lucas.example.test/icon.png');
insert into storage.objects (bucket_id, name, metadata)
select 'brand-assets', storage_path, '{"size": 2000}' from brand_assets where client_id = sh.id('lucas');

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
begin
  perform sh.ok('S1 brand_asset_record_hash is the service role''s only, with the caller''s rights',
    has_function_privilege('service_role', 'public.brand_asset_record_hash(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.brand_asset_record_hash(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.brand_asset_record_hash(jsonb)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.brand_asset_record_hash(jsonb)'::regprocedure));
  perform sh.ok('S2 no asset carries a hash before the function records one',
    not exists (select 1 from brand_assets where client_id in (sh.id('c'), sh.id('lucas')) and content_hash is not null));
  perform sh.ok('S3 the approval rule needs a recorded hash, subjects and (photos) own work and focal point',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'brand_assets_creative_approved_complete')
      like '%content_hashed_at%cardinality(subjects) > 0%focal_x%');
end $$;

-- ── W. The worker's SQL ─────────────────────────────────────────────────────
do $$
declare st text;
begin
  st := sh.try(format($q$update brand_assets set content_hash = %L where id = %L$q$, sh.h('a1'), sh.id('a1')));
  perform sh.ok('W1 the worker cannot write a content hash', st like '42501:%source-assets%', st);
  st := sh.try(format($q$update brand_assets set content_hashed_at = now() where id = %L$q$, sh.id('a1')));
  perform sh.ok('W2 ...nor a hash timestamp', st like '42501:%', st);
  st := sh.try(format($q$insert into brand_assets (client_id, kind, label, storage_path, content_hash, content_hashed_at, content_measurement)
                values (%L, 'photo', 'x', 'x/y.jpg', %L, now(), '{}')$q$, sh.id('c'), sh.h('x')));
  perform sh.ok('W3 ...nor insert an asset with a hash', st like '42501:%', st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1'))));
  perform sh.ok('W4 ...nor call the record function', st like '42501:%source-assets%', st);
  perform set_config('compass.source_hash', 'on', false);
  st := sh.try(format($q$update brand_assets set content_hash = %L where id = %L$q$, sh.h('a1'), sh.id('a1')));
  perform sh.ok('W5 setting the hashing flag by hand does not open the door', st like '42501:%', st);
  perform set_config('compass.source_hash', '', false);
end $$;
set role service_role;
select sh.as_user('service_role', null);
do $$
begin
  perform sh.ok('W6 SET ROLE service_role does not make the worker the hasher',
    sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1')))) like '42501:%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── H. The source-assets function (authenticator + service_role) ────────────
\c - authenticator
set role service_role;
select sh.as_user('service_role', null);
do $$
declare res jsonb; st text; v_at timestamptz; n int;
begin
  res := brand_asset_record_hash(sh.rec(sh.id('a1'), sh.h('a1')));
  perform sh.ok('H1 a stored file is hashed and measured',
    res->>'status' = 'hashed'
    and (select content_hash = sh.h('a1') and content_hashed_at is not null and width = 1200 and height = 1600
                and content_measurement->>'content_type' = 'image/jpeg' and (content_measurement->>'bytes')::int = 1000
                and storage_path = sh.id('c') || '/scan/a1.jpg' and url = 'https://hash.example.test/a1.jpg'
         from brand_assets where id = sh.id('a1')), res::text);
end $$;
do $$
declare res jsonb; v_at timestamptz := (select content_hashed_at from brand_assets where id = sh.id('a1'));
  n int := (select count(*) from creative_governance_events where subject_id = sh.id('a1'));
begin
  res := brand_asset_record_hash(sh.rec(sh.id('a1'), sh.h('a1'), sh.h('a1')));
  perform sh.ok('H2 hashing the same bytes again is a no-op (idempotent: no write, no event)',
    res->>'status' = 'unchanged' and (select content_hashed_at from brand_assets where id = sh.id('a1')) = v_at
    and (select count(*) from creative_governance_events where subject_id = sh.id('a1')) = n, res::text);
end $$;
do $$
declare st text; before jsonb := (select to_jsonb(b) from brand_assets b where id = sh.id('a1'));
begin
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1-new'))));
  perform sh.ok('H3 a writer that did not see the current hash is refused (compare-and-set)', st like '23514: hash_changed%', st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1-new'), sh.h('a1'), 1200, 1600, 1000, 'image/jpeg', 'other/path.jpg')));
  perform sh.ok('H4 bytes read from another path are refused', st like '23514: path_changed%', st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1-new'), sh.h('a1'), 1200, 1600, 999)));
  perform sh.ok('H5 bytes whose size is not the stored object''s are refused', st like '23514: size_mismatch%', st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('a1-new'), sh.h('a1'), 1200, 1600, 1000, 'image/svg+xml')));
  perform sh.ok('H6 an unmeasurable type is refused', st like '23514: unsupported_type%', st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), 'not-a-hash', sh.h('a1'))));
  perform sh.ok('H7 a malformed hash is refused', st like '23514:%sha256%', st);
  perform sh.ok('H8 every refusal left the row exactly as it was', (select to_jsonb(b) from brand_assets b where id = sh.id('a1')) = before);

  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('gone'), sh.h('gone'))));
  perform sh.ok('H9 a missing stored file is refused, nothing recorded', st like '23514: object_missing%'
    and (select content_hash is null from brand_assets where id = sh.id('gone')), st);
  st := sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('link'), sh.h('link'), null, 800, 600, 1000, 'image/jpeg', 'https://hash.example.test/link.jpg')));
  perform sh.ok('H10 a link-only asset (no stored file) is never hashed as if it were stored', st like '23514: path_changed%'
    and (select content_hash is null and storage_path is null from brand_assets where id = sh.id('link')), st);

  perform brand_asset_record_hash(sh.rec(sh.id('logo'), sh.h('logo'), null, 600, 200, 500, 'image/png'));
  perform sh.ok('H11 a logo without dimensions gets its measured dimensions',
    (select width = 600 and height = 200 and content_hash = sh.h('logo') from brand_assets where id = sh.id('logo')));
  perform brand_asset_record_hash(sh.rec(sh.id('a2'), sh.h('a2'), null, 1200, 1600, 1000, 'image/jpeg', null, 6));
  perform sh.ok('H12 display dimensions after EXIF orientation, raw ones kept in the measurement',
    (select width = 1200 and height = 1600 and (content_measurement->>'orientation')::int = 6
            and (content_measurement->>'raw_width')::int = 1600 and (content_measurement->>'raw_height')::int = 1200
     from brand_assets where id = sh.id('a2')));
  perform sh.ok('H13 hashing is recorded in the governance history as the hasher',
    (select count(*) from creative_governance_events where subject_id in (sh.id('a1'), sh.id('logo'), sh.id('a2'))
       and action = 'hashed' and actor_kind = 'hasher' and changes->'content_hash'->>'to' is not null) = 3);
  perform sh.ok('H14 the hasher never touches governed review fields',
    (select bool_and(creative_use = 'unreviewed' and depicts_own_work is null and subjects = '{}' and creative_reviewed_by is null)
     from brand_assets where client_id = sh.id('c')));

  -- The Lucas-shaped library: every stored file hashed; logos measured.
  perform brand_asset_record_hash(sh.rec(id, sh.h(id::text), null, coalesce(width, case when kind::text = 'logo_icon' then 192 else 800 end),
                                         coalesce(height, case when kind::text = 'logo_icon' then 192 else 300 end), 2000,
                                         case when kind::text like 'logo%' then 'image/png' else 'image/jpeg' end))
    from brand_assets where client_id = sh.id('lucas');
  perform sh.ok('H15 Lucas-shaped: 14 of 14 stored files hashed, logos measured, nothing reviewed',
    (select count(*) from brand_assets where client_id = sh.id('lucas') and content_hash is not null and width > 0) = 14
    and (select width = 192 and height = 192 from brand_assets where id = sh.id('licon'))
    and not exists (select 1 from brand_assets where client_id = sh.id('lucas') and creative_use <> 'unreviewed'));
  perform brand_asset_record_hash(sh.rec(id, sh.h(id::text), sh.h(id::text), width, height, 2000,
                                         case when kind::text like 'logo%' then 'image/png' else 'image/jpeg' end))
    from brand_assets where client_id = sh.id('lucas');
  perform sh.ok('H16 Lucas-shaped: a second pass changes nothing',
    (select count(*) from creative_governance_events where client_id = sh.id('lucas') and action = 'hashed') = 14
    and not exists (select 1 from creative_governance_events where client_id = sh.id('lucas') and action <> 'hashed'));
end $$;
reset role;

-- ── T. A teammate reviews ───────────────────────────────────────────────────
set role authenticated;
select sh.as_user('authenticated', :'team');
do $$
declare st text; v_me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  st := sh.try(format($q$update brand_assets set content_hash = %L where id = %L$q$, sh.h('forged'), sh.id('a1')));
  perform sh.ok('T1 a teammate cannot write a hash either', st like '42501:%source-assets%', st);
  perform sh.ok('T2 ...nor call the record function', sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a1'), sh.h('x'), sh.h('a1')))) like '42501:%');

  st := sh.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true, focal_x = 0.5, focal_y = 0.5 where id = %L$q$, sh.id('a1')));
  perform sh.ok('T3 approval needs governed subject tags', st like '23514:%approved_complete%', st);
  st := sh.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof}' where id = %L$q$, sh.id('a1')));
  perform sh.ok('T4 approving a photo needs a focal point', st like '23514:%approved_complete%', st);
  st := sh.try(format($q$update brand_assets set creative_use = 'approved', subjects = '{roof}', focal_x = 0.5, focal_y = 0.5 where id = %L$q$, sh.id('a1')));
  perform sh.ok('T5 approving a photo needs the explicit own-work decision', st like '23514:%approved_complete%', st);
  st := sh.try(format($q$update brand_assets set subjects = '{Roof!}' where id = %L$q$, sh.id('a1')));
  perform sh.ok('T6 subject tags are short lower-case words', st like '23514:%subjects_vocabulary%', st);

  -- AI suggestions never stand in for a decision.
  perform sh.ok('T7 suggestions do not approve: an asset with only suggestions stays unapprovable',
    sh.try(format($q$update brand_assets set creative_use = 'approved' where id = %L$q$, sh.id('lp2'))) like '23514:%');

  update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof,shingles}', focal_x = 0.5, focal_y = 0.4
   where id = sh.id('a1');
  perform sh.ok('T8 a complete approval by a teammate is stamped and recorded with the approved hash',
    (select creative_use = 'approved' and creative_reviewed_by = v_me from brand_assets where id = sh.id('a1'))
    and exists (select 1 from creative_governance_events where subject_id = sh.id('a1') and action = 'approved'
                and actor_kind = 'team' and actor_id = v_me and changes->>'approved_content_hash' = sh.h('a1')));
  update brand_assets set creative_use = 'approved', subjects = '{logo}' where id = sh.id('logo');
  perform sh.ok('T9 a logo needs subjects but no own-work decision or focal point',
    (select creative_use = 'approved' from brand_assets where id = sh.id('logo')));

  st := sh.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof}', focal_x = 0.5, focal_y = 0.5 where id = %L$q$, sh.id('gone')));
  perform sh.ok('T10 an unhashed asset cannot be approved', st like '23514:%', st);
  st := sh.try(format($q$update brand_assets set creative_use = 'excluded' where id = %L$q$, sh.id('a2')));
  perform sh.ok('T11 exclusion needs a reason', st like '23514:%excluded_explained%', st);
  update brand_assets set creative_use = 'excluded', creative_review_note = 'Shows another company''s crew' where id = sh.id('a2');
  update brand_assets set creative_use = 'unreviewed', creative_review_note = null where id = sh.id('a2');
  perform sh.ok('T12 a teammate may set an image back to unreviewed; both steps recorded',
    (select creative_use = 'unreviewed' from brand_assets where id = sh.id('a2'))
    and exists (select 1 from creative_governance_events where subject_id = sh.id('a2') and action = 'excluded')
    and exists (select 1 from creative_governance_events where subject_id = sh.id('a2') and action = 'unreviewed'));

  -- A teammate replacing the file: hash cleared, review reset.
  update brand_assets set storage_path = sh.id('c') || '/scan/logo-v2.png' where id = sh.id('logo');
  perform sh.ok('T13 replacing a file clears its hash and resets its review',
    (select content_hash is null and content_hashed_at is null and content_measurement is null and creative_use = 'unreviewed'
     from brand_assets where id = sh.id('logo'))
    and exists (select 1 from creative_governance_events where subject_id = sh.id('logo') and action = 'hash_cleared')
    and exists (select 1 from creative_governance_events where subject_id = sh.id('logo') and action = 'reset_file_changed'));
end $$;
reset role;

-- New bytes for an approved image: rehashed, review reset.
set role service_role;
select sh.as_user('service_role', null);
do $$
declare res jsonb;
begin
  res := brand_asset_record_hash(sh.rec(sh.id('a1'), sh.h('a1-v2'), sh.h('a1'), 1200, 1600, 1000));
  perform sh.ok('R1 new bytes give a new hash; the approval no longer covers them',
    res->>'status' = 'rehashed' and (res->>'review_reset')::boolean and res->>'previous_hash' = sh.h('a1')
    and (select content_hash = sh.h('a1-v2') and creative_use = 'unreviewed' and creative_reviewed_by is null
         from brand_assets where id = sh.id('a1'))
    and exists (select 1 from creative_governance_events where subject_id = sh.id('a1') and action = 'rehashed'
                and changes->'content_hash'->>'from' = sh.h('a1')), res::text);
end $$;
reset role;

-- The worker editing file fields clears the attestation.
\c - postgres
do $$
begin
  update brand_assets set width = 1300 where id = sh.id('lp3');
  perform sh.ok('W7 a worker change to the file fields clears the hash (recorded)',
    (select content_hash is null and content_hashed_at is null from brand_assets where id = sh.id('lp3'))
    and exists (select 1 from creative_governance_events where subject_id = sh.id('lp3') and action = 'hash_cleared' and actor_kind = 'worker'));
  -- A stored file that disappears cannot be approved even though its row is hashed.
  delete from storage.objects where bucket_id = 'brand-assets' and name = sh.id('lucas') || '/scan/photo-4.jpg';
end $$;
\c - authenticator
set role authenticated;
select sh.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := sh.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof}', focal_x = 0.5, focal_y = 0.5 where id = %L$q$, sh.id('lp4')));
  perform sh.ok('T14 a hashed row whose stored file is gone cannot be approved', st like '23514:%missing from the brand-assets bucket%', st);
end $$;
reset role;

-- ── P. Portal contact and anon ──────────────────────────────────────────────
select sh.as_user('authenticated', :'pb');
set role authenticated;
do $$
begin
  perform sh.ok('P1 a portal contact cannot call the record function',
    sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a2'), sh.h('p'), sh.h('a2')))) like '42501:%');
  perform sh.ok('P2 ...sees no brand assets or history',
    (select count(*) from brand_assets where client_id = sh.id('c')) + (select count(*) from creative_governance_events) = 0);
  perform sh.ok('P3 ...and its review update touches nothing',
    sh.try(format($q$update brand_assets set creative_use = 'excluded', creative_review_note = 'x' where id = %L$q$, sh.id('lp5'))) is null
    and (select 1) = 1);
end $$;
reset role;
set role anon;
select sh.as_user('anon', null);
do $$
begin
  perform sh.ok('P4 anon cannot call the record function',
    sh.try(format('select brand_asset_record_hash(%L)', sh.rec(sh.id('a2'), sh.h('p'), sh.h('a2')))) like '42501:%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
do $$
begin
  perform sh.ok('P5 the portal contact''s update changed nothing',
    (select creative_use = 'unreviewed' from brand_assets where id = sh.id('lp5')));
end $$;

\o
\pset footer off
select status, count(*) from sh.results group by status order by status;
select n, status, name, detail from sh.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from sh.results where status = 'fail';
  if f > 0 then raise exception '% source-asset hashing check(s) failed', f; end if;
end $$;
