-- Tests for migration 0054 (Creative Engine: source governance, templates,
-- runs, immutable content-addressed assets, creative links, approval binding,
-- request new creative, storage), run by scripts/test-portal-sandbox.sh on the
-- same replay. Own harness schema (ce) and its own client.
--
-- Callers are real sessions, the way each reaches production:
--   worker     psql as postgres (the Supabase connector's login), with or
--              without SET ROLE service_role / authenticated
--   creative   psql as authenticator, role service_role (the Creative Engine
--              Edge Function through PostgREST; also the post-drafter function)
--   person     psql as authenticator, role authenticated, team JWT
--   portal     psql as authenticator, role authenticated, portal JWT
-- Fictional data only.

\set team   '00000000-0000-4000-a000-000000000001'
\set pb     '00000000-0000-4000-a000-000000000012'
\set strngr '00000000-0000-4000-a000-000000000014'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema ce;
create table ce.results (n serial, status text, name text, detail text);
create table ce.ids (k text primary key, id uuid);
grant usage on schema ce to anon, authenticated, service_role, authenticator;
grant insert, select on ce.results to anon, authenticated, service_role, authenticator;
grant select, insert, update on ce.ids to anon, authenticated, service_role;
grant usage on sequence ce.results_n_seq to anon, authenticated, service_role, authenticator;

create function ce.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into ce.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function ce.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ce.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
-- Deterministic ids and file hashes.
create function ce.id(p_k text) returns uuid language sql immutable as $$ select md5('ce:' || p_k)::uuid $$;
create function ce.h(p_k text) returns text language sql immutable as $$ select encode(sha256(convert_to('bytes:' || p_k, 'UTF8')), 'hex') $$;
create function ce.sha(p_text text) returns text language sql immutable as $$ select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex') $$;
create function ce.got(p_k text) returns uuid language sql stable as $$ select id from ce.ids where k = p_k $$;
create function ce.put(p_k text, p_id uuid) returns void language sql as $$
  insert into ce.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id
$$;
create function ce.brief(p_variant int) returns jsonb language sql immutable as $$
  select jsonb_build_object('layout', 'photo-caption', 'variant', p_variant)
$$;
create function ce.bhash(p_variant int) returns text language sql immutable as $$
  select 'sha256:' || encode(sha256(convert_to(ce.brief(p_variant)::text, 'UTF8')), 'hex')
$$;
-- A creative_write body for a rendered file.
create function ce.render(p_run uuid, p_hash text, p_version int, p_overlay jsonb, p_sources jsonb,
                          p_submit boolean default false, p_width int default 1200, p_height int default 900,
                          p_format text default 'png') returns jsonb
language sql immutable as $$
  select jsonb_build_object('run_id', p_run, 'expected_creative_version', p_version, 'submit', p_submit,
    'asset', jsonb_build_object('content_hash', p_hash, 'format', p_format, 'width', p_width, 'height', p_height,
                                'size_bytes', 1000, 'alt_text', 'Roof replacement on a local home', 'overlay', p_overlay,
                                'generation', jsonb_build_object('renderer', 'sandbox-renderer/1')),
    'sources', p_sources)
$$;
create function ce.src(p_asset uuid, p_role text default 'photo', p_hash text default null) returns jsonb
language sql stable as $$
  select jsonb_build_array(jsonb_build_object('brand_asset_id', p_asset, 'role', p_role,
    'source_content_hash', coalesce(p_hash, (select content_hash from public.brand_assets where id = p_asset)),
    'crop', jsonb_build_object('x', 0, 'y', 0.1, 'w', 1, 'h', 0.75)))
$$;
create function ce.overlay() returns jsonb language sql immutable as $$
  select '[{"role": "service_name", "text": "Roof Replacement"}, {"role": "standing_cta", "text": "Request a Quote"}]'::jsonb
$$;
create function ce.req(p_copy text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'client_id', ce.id('c'), 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1,
    'brief_version', 'drafter-brief/1', 'brief_hash', 'sha256:' || repeat('cd', 32),
    'brief', jsonb_build_object(
      'client', jsonb_build_object('id', ce.id('c')),
      'target', jsonb_build_object('channel', 'google_business', 'post_type', 'standard', 'search_intent', 'commercial',
        'service', jsonb_build_object('id', ce.id('rr'), 'name', 'Roof Replacement'),
        'keyword', null,
        'cta', jsonb_build_object('type', 'LEARN_MORE', 'url', 'https://creative.example.test/roof-replacement'), 'offer', null),
      'allowed_facts', jsonb_build_object('claims', jsonb_build_array(jsonb_build_object('id', ce.id('cl')),
                                                                     jsonb_build_object('id', ce.id('cllong'))))),
    'lint', jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', p_copy, 'claim_ids', jsonb_build_array(ce.id('cl'), ce.id('cllong')), 'asset_ids', '[]'::jsonb)
$$;
grant execute on all functions in schema ce to anon, authenticated, service_role, authenticator;

-- ── Fixtures (as postgres): a client, its service, claims, brand, images ────
insert into clients (id, name, city, state, website_url, status) values
  (ce.id('c'), 'Creative Roofing', 'Wentzville', 'MO', 'https://creative.example.test', 'active');
insert into services (id, client_id, name, status, page_url) values
  (ce.id('rr'), ce.id('c'), 'Roof Replacement', 'approved', 'https://creative.example.test/roof-replacement');
insert into claims (id, client_id, claim, status, source) values
  (ce.id('cl'), ce.id('c'), 'Installs Owens Corning Duration shingles', 'sourced', 'https://creative.example.test/about'),
  (ce.id('cllong'), ce.id('c'), 'Roofing, siding, guttering, fascia and soffit contractor for the whole region', 'sourced', 'https://creative.example.test/about');
update client_brands set tagline = 'Built right the first time' where client_id = ce.id('c');
insert into brand_boards (client_id, version, standing_cta) values (ce.id('c'), 1, 'Request a Quote');
insert into brand_assets (id, client_id, kind, label, source, storage_path, width, height) values
  (ce.id('p1'), ce.id('c'), 'photo', 'Photo from the home page', 'website_scan', ce.id('c') || '/p1.jpg', 1200, 1600),
  (ce.id('p2'), ce.id('c'), 'photo', 'Photo from the home page', 'website_scan', ce.id('c') || '/p2.jpg', 1200, 1600),
  (ce.id('p3'), ce.id('c'), 'photo', 'Stock-looking photo', 'website_scan', ce.id('c') || '/p3.jpg', 1200, 1600),
  (ce.id('p4'), ce.id('c'), 'photo', 'Blurry photo', 'website_scan', ce.id('c') || '/p4.jpg', 400, 300),
  (ce.id('p5'), ce.id('c'), 'photo', 'Crew photo', 'website_scan', ce.id('c') || '/p5.jpg', 1200, 1600),
  (ce.id('l1'), ce.id('c'), 'logo_primary', 'Logo', 'website_scan', ce.id('c') || '/logo.png', 600, 200);
-- The Creative Engine function uploads before it records (bucket stubbed).
insert into storage.objects (bucket_id, name, metadata) values
  ('creative-assets', ce.id('c') || '/' || ce.h('preview1') || '.png', '{"size": 1000, "mimetype": "image/png"}'),
  ('creative-assets', ce.id('c') || '/' || ce.h('r1') || '.png', '{"size": 1000, "mimetype": "image/png"}'),
  ('creative-assets', ce.id('c') || '/' || ce.h('small') || '.png', '{"size": 1000, "mimetype": "image/png"}'),
  ('creative-assets', ce.id('c') || '/' || ce.h('manual') || '.jpg', '{"size": 1000, "mimetype": "image/jpeg"}'),
  ('creative-assets', ce.id('c') || '/' || ce.h('r3') || '.png', '{"size": 1000, "mimetype": "image/png"}');
insert into storage.objects (bucket_id, name, metadata)
  select 'brand-assets', storage_path, '{"size": 1000}' from brand_assets where client_id = ce.id('c');

-- ── S. Static checks ────────────────────────────────────────────────────────
do $$
begin
  perform ce.ok('S1 RLS is on for every creative table',
    (select count(*) from pg_class where relname in ('creative_governance_events', 'client_creative_settings', 'creative_templates',
       'client_creative_templates', 'creative_runs', 'creative_assets', 'creative_asset_sources') and relrowsecurity) = 7);
  perform ce.ok('S2 anon holds no privilege on any creative table',
    not exists (select 1 from unnest(array['creative_governance_events', 'client_creative_settings', 'creative_templates',
       'client_creative_templates', 'creative_runs', 'creative_assets', 'creative_asset_sources']) t
       where has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete')));
  perform ce.ok('S3 authenticated cannot insert / delete runs, assets, sources, templates or history',
    not has_table_privilege('authenticated', 'public.creative_runs', 'insert,update,delete')
    and not has_table_privilege('authenticated', 'public.creative_assets', 'insert,delete')
    and not has_table_privilege('authenticated', 'public.creative_asset_sources', 'insert,update,delete')
    and not has_table_privilege('authenticated', 'public.creative_templates', 'insert,delete')
    and not has_table_privilege('authenticated', 'public.creative_governance_events', 'insert,update,delete')
    and not has_table_privilege('authenticated', 'public.client_creative_settings', 'delete')
    and not has_table_privilege('authenticated', 'public.client_creative_templates', 'delete'));
  perform ce.ok('S4 the Creative Engine functions are the service role''s only',
    not exists (select 1 from unnest(array['creative_register_template(jsonb)', 'creative_begin_run(jsonb)',
       'creative_fail_run(jsonb)', 'creative_write(jsonb)', 'creative_overlay_problems(uuid,uuid,jsonb)']) f
       where not has_function_privilege('service_role', 'public.' || f, 'execute')
          or has_function_privilege('authenticated', 'public.' || f, 'execute')
          or has_function_privilege('anon', 'public.' || f, 'execute')));
  perform ce.ok('S5 request_new_creative: teammates (authenticated) only, security invoker',
    has_function_privilege('authenticated', 'public.request_new_creative(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.request_new_creative(uuid,text)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.request_new_creative(uuid,text)'::regprocedure));
  perform ce.ok('S6 no new security-definer function is callable over the API',
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.prosecdef and (p.proname like 'creative%' or p.proname like '%creative%')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform ce.ok('S7 the creative-assets bucket is private, image-only, size-limited',
    (select not public and allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] and file_size_limit = 20971520
     from storage.buckets where id = 'creative-assets'));
  perform ce.ok('S8 the creative bucket has only a team SELECT policy',
    (select array_agg(cmd::text) from pg_policies where schemaname = 'storage' and qual like '%creative-assets%') = array['SELECT']
    and not exists (select 1 from pg_policies where schemaname = 'storage' and with_check like '%creative-assets%'));
  perform ce.ok('S9 no portal view reads creative data',
    not exists (select 1 from pg_views where viewname like 'portal\_%' and (definition ilike '%creative%' or definition ilike '%post_assets%')));
  perform ce.ok('S10 no policy, no template, nothing reviewed after the migration (fixtures aside)',
    not exists (select 1 from client_creative_settings) and not exists (select 1 from creative_templates)
    and not exists (select 1 from brand_assets where creative_use <> 'unreviewed'));
  perform ce.ok('S11 new assets start unreviewed with no governed metadata',
    (select bool_and(creative_use = 'unreviewed' and depicts_own_work is null and subjects = '{}' and creative_reviewed_by is null)
     from brand_assets where client_id = ce.id('c')));
  perform ce.ok('S12 every existing post has policy none and no creative',
    not exists (select 1 from social_posts where creative_policy <> 'none' or creative_status <> 'none' or creative_version <> 0));
  perform ce.ok('S13 every approved post still hashes to its approval (backward compatible snapshot)',
    not exists (select 1 from social_posts p where review_status = 'approved'
                and social_post_hash(social_post_snapshot(p)) is distinct from approved_hash));
  perform ce.ok('S14 a post without creative has no creative key in its snapshot',
    not exists (select 1 from social_posts p where social_post_snapshot(p) ? 'creative'));
  perform ce.ok('S15 a post link is exactly one of brand asset / creative asset, with a surrogate key',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'post_assets_one_source') like '%num_nonnulls(brand_asset_id, creative_asset_id) = 1%'
    and (select array_agg(a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conname = 'post_assets_pkey') = array['id']::name[]);
  perform ce.ok('S16 creative files are content-addressed by constraint',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'creative_assets_content_addressed') like '%content_hash%');
end $$;

-- ── W. The worker's own SQL (session_user postgres) ─────────────────────────
do $$
declare st text;
begin
  -- Suggestions are not governance: the worker may record them. Hashes are
  -- measurements of the stored bytes: only the source-assets function (0055).
  update brand_assets set creative_suggestions = '{"depicts_own_work": true, "subjects": ["roof"], "model": "sandbox-vision"}'
   where client_id = ce.id('c');
  st := ce.try(format($q$update brand_assets set content_hash = %L where id = %L$q$, ce.h('x'), ce.id('p1')));
  perform ce.ok('W1 the worker records AI suggestions but not content hashes (0055)',
    (select count(*) from brand_assets where client_id = ce.id('c') and creative_suggestions is not null) = 6
    and st like '42501:%source-assets%', st);
  perform ce.ok('W2 a suggestion is not governed truth',
    (select depicts_own_work is null and subjects = '{}' and creative_use = 'unreviewed' from brand_assets where id = ce.id('p1')));
  st := ce.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true where id = %L$q$, ce.id('p1')));
  perform ce.ok('W3 the worker cannot approve an asset for creative use', st like '42501:%teammate%', st);
  st := ce.try(format($q$update brand_assets set subjects = '{roof}' where id = %L$q$, ce.id('p1')));
  perform ce.ok('W4 the worker cannot set governed subjects', st like '42501:%', st);
  st := ce.try(format($q$insert into brand_assets (client_id, kind, label, storage_path, creative_use) values (%L, 'photo', 'x', 'x/y.jpg', 'approved')$q$, ce.id('c')));
  perform ce.ok('W5 a new asset cannot start approved', st like '42501:%unreviewed%', st);
  st := ce.try(format($q$insert into client_creative_settings (client_id, channel, creative_policy) values (%L, 'google_business', 'required')$q$, ce.id('c')));
  perform ce.ok('W6 the worker cannot set a creative policy', st like '42501:%teammate%', st);
  st := ce.try($q$select creative_register_template('{"key": "x", "version": 1}')$q$);
  perform ce.ok('W7 the worker cannot register a template', st like '42501:%', st);
  st := ce.try($q$select creative_begin_run('{}')$q$);
  perform ce.ok('W8 the worker cannot begin a run', st like '42501:%', st);
  st := ce.try($q$select creative_write('{}')$q$);
  perform ce.ok('W9 the worker cannot write creative', st like '42501:%', st);
  perform set_config('compass.creative_write', 'on', false);
  st := ce.try($q$insert into creative_templates (key, version, channel, name, output_width, output_height, mime_type, spec, spec_hash)
                values ('forged', 1, 'google_business', 'Forged', 1200, 900, 'image/png', '{}', 'sha256:' || repeat('0', 64))$q$);
  perform ce.ok('W10 setting the creative flag by hand does not let the worker register a template', st like '42501:%', st);
  st := ce.try(format($q$insert into creative_assets (client_id, content_hash, storage_path, format, mime_type, width, height, size_bytes,
                  strategy, purpose, provenance, alt_text) values (%L, %L, %L, 'png', 'image/png', 10, 10, 10, 'manual', 'post',
                  '{"uploaded_via": "sql"}', 'x')$q$, ce.id('c'), ce.h('forged'), ce.id('c') || '/' || ce.h('forged') || '.png'));
  perform ce.ok('W11 ...nor insert a creative asset', st like '42501:%', st);
  perform set_config('compass.creative_write', '', false);
  st := ce.try(format($q$insert into creative_governance_events (client_id, subject_type, subject_id, actor_kind, action)
                values (%L, 'brand_asset', %L, 'team', 'approved')$q$, ce.id('c'), ce.id('p1')));
  perform ce.ok('W12 the worker cannot forge governance history', st like '42501:%trigger%', st);
end $$;
set role service_role;
select ce.as_user('service_role', null);
do $$
declare st text;
begin
  st := ce.try($q$select creative_begin_run('{}')$q$);
  perform ce.ok('W13 SET ROLE service_role does not make the worker the Creative Engine', st like '42501:%Creative Engine%', st);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- The source-assets function records what it measured (all but p2).
\c - authenticator
set role service_role;
select ce.as_user('service_role', null);
select brand_asset_record_hash(jsonb_build_object('asset_id', id, 'storage_path', storage_path, 'expected_hash', null,
         'content_hash', ce.h(label || id::text), 'width', width, 'height', height, 'byte_size', 1000,
         'content_type', case when kind::text like 'logo%' then 'image/png' else 'image/jpeg' end,
         'raw_width', width, 'raw_height', height, 'orientation', 1, 'measured_by', 'sandbox'))
  from brand_assets where client_id = ce.id('c') and id <> ce.id('p2');
reset role;

-- ── G. A teammate governs source images and the policy ──────────────────────
set role authenticated;
select ce.as_user('authenticated', :'team');
do $$
declare st text; v_me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  st := ce.try(format($q$update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof}', focal_x = 0.5, focal_y = 0.5 where id = %L$q$, ce.id('p2')));
  perform ce.ok('G1 approval needs the file''s content hash', st like '23514:%approved_complete%', st);
  st := ce.try(format($q$update brand_assets set creative_use = 'approved' where id = %L$q$, ce.id('p1')));
  perform ce.ok('G2 approving a photo needs the own-work decision', st like '23514:%approved_complete%', st);
  update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{roof,shingles}',
         focal_x = 0.5, focal_y = 0.4, creative_reviewed_by = gen_random_uuid(), creative_reviewed_at = '2020-01-01'
   where id = ce.id('p1');
  perform ce.ok('G3 a teammate approves a photo; reviewer and time are stamped, not taken from the row',
    (select creative_use = 'approved' and depicts_own_work and subjects = '{roof,shingles}' and focal_x = 0.5
            and creative_reviewed_by = v_me and creative_reviewed_at > now() - interval '1 minute'
     from brand_assets where id = ce.id('p1')));
  perform ce.ok('G4 the approval is in the governance history with who and what',
    exists (select 1 from creative_governance_events where subject_id = ce.id('p1') and action = 'approved'
            and actor_kind = 'team' and actor_id = v_me and changes ? 'creative_use' and changes ? 'depicts_own_work'
            and changes->'subjects'->'to' = '["roof", "shingles"]'::jsonb));
  update brand_assets set creative_use = 'approved', depicts_own_work = false, subjects = '{house}', focal_x = 0.5, focal_y = 0.5 where id = ce.id('p3');
  update brand_assets set creative_use = 'approved', depicts_own_work = true, subjects = '{crew}', focal_x = 0.5, focal_y = 0.5 where id = ce.id('p5');
  update brand_assets set creative_use = 'approved', subjects = '{logo}' where id = ce.id('l1');
  st := ce.try(format($q$update brand_assets set creative_use = 'excluded' where id = %L$q$, ce.id('p4')));
  perform ce.ok('G5 excluding needs a reason', st like '23514:%excluded_explained%', st);
  update brand_assets set creative_use = 'excluded', creative_review_note = 'Too small and blurry' where id = ce.id('p4');
  perform ce.ok('G6 an exclusion is recorded with its reason',
    exists (select 1 from creative_governance_events where subject_id = ce.id('p4') and action = 'excluded' and note = 'Too small and blurry'));
  st := ce.try(format($q$update brand_assets set focal_x = 1.5, focal_y = 0.2 where id = %L$q$, ce.id('p5')));
  perform ce.ok('G7 a focal point lies inside the image', st like '23514:%focal%', st);

  st := ce.try(format($q$insert into client_creative_settings (client_id, channel, creative_policy, generated_imagery)
                values (%L, 'google_business', 'required', 'representational')$q$, ce.id('c')));
  perform ce.ok('G8 representational generated imagery is not a setting', st like '23514:%', st);
  insert into client_creative_settings (client_id, channel, creative_policy) values (ce.id('c'), 'google_business', 'required');
  perform ce.ok('G9 a teammate sets the client''s channel policy; stamped and recorded',
    (select creative_policy = 'required' and generated_imagery = 'off' and updated_by = v_me
     from client_creative_settings where client_id = ce.id('c'))
    and exists (select 1 from creative_governance_events where client_id = ce.id('c') and subject_type = 'client_setting'
                and changes->'creative_policy'->>'to' = 'required'));
  st := ce.try(format($q$delete from client_creative_settings where client_id = %L$q$, ce.id('c')));
  perform ce.ok('G10 a policy row is not deleted (set none instead)', st is not null or exists (select 1 from client_creative_settings where client_id = ce.id('c')), st);
  st := ce.try($q$insert into creative_templates (key, version, channel, name, output_width, output_height, mime_type, spec, spec_hash)
                values ('mine', 1, 'google_business', 'Mine', 1200, 900, 'image/png', '{}', 'sha256:' || repeat('0', 64))$q$);
  perform ce.ok('G11 a teammate cannot register a template (Compass-owned, from the Engine)', st like '42501:%', st);

  -- A hand-written post for this client now requires creative.
  insert into social_posts (id, client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
  values (ce.id('hp'), ce.id('c'), 'google_business', 'commercial', ce.id('rr'), 'New roofs installed right.', 'LEARN_MORE',
          'https://creative.example.test/roof-replacement');
  insert into post_claims (post_id, client_id, claim_id) values (ce.id('hp'), ce.id('c'), ce.id('cl'));
  perform ce.ok('G12 a new post takes the channel policy: required, creative needed',
    (select creative_policy = 'required' and creative_status = 'needed' and creative_version = 0 from social_posts where id = ce.id('hp')));
  st := ce.try(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, ce.id('hp')));
  perform ce.ok('G13 a post that requires creative cannot be submitted without it', st like '23514:%needs its creative%', st);
  st := ce.try(format($q$update social_posts set creative_status = 'ready' where id = %L$q$, ce.id('hp')));
  perform ce.ok('G14 a teammate cannot mark creative ready by hand', st like '42501:%', st);
  st := ce.try(format($q$update social_posts set creative_version = 5 where id = %L$q$, ce.id('hp')));
  perform ce.ok('G15 ...nor move the creative version', st like '42501:%', st);
end $$;
reset role;

-- The worker changes an approved file: its review resets.
\c - postgres
do $$
begin
  update brand_assets set width = 1300 where id = ce.id('p5');
  perform ce.ok('G16 a changed file resets its creative review, whoever changed it',
    (select creative_use = 'unreviewed' and creative_reviewed_by is null from brand_assets where id = ce.id('p5'))
    and exists (select 1 from creative_governance_events where subject_id = ce.id('p5') and action = 'reset_file_changed'
                and actor_kind = 'worker' and changes->'file' ? 'width'));
  perform ce.ok('G17 a worker update of a post''s creative status is refused',
    ce.try(format($q$update social_posts set creative_status = 'none' where id = %L$q$, ce.id('hp'))) like '42501:%');
end $$;

-- ── T. Templates and client-specific previews (the Creative Engine) ─────────
\c - authenticator
set role service_role;
select ce.as_user('service_role', null);
do $$
declare res jsonb; res2 jsonb; st text; v_run uuid;
  t1 jsonb := '{"key": "gbp-photo-caption", "version": 1, "channel": "google_business", "name": "Photo with caption",
                "output_width": 1200, "output_height": 900, "mime_type": "image/png", "spec": {"layers": ["photo", "band", "text"]}}';
begin
  res := creative_register_template(t1);
  perform ce.put('t1', (res->>'template_id')::uuid);
  perform ce.ok('T1 the Engine registers a template version with its spec hash',
    (res->>'registered')::boolean and (select spec_hash = 'sha256:' || encode(sha256(convert_to(spec::text, 'UTF8')), 'hex')
                                        and status = 'published' from creative_templates where id = ce.got('t1')), res::text);
  res2 := creative_register_template(t1);
  perform ce.ok('T2 registering the same version again is a no-op', not (res2->>'registered')::boolean and res2->>'template_id' = res->>'template_id');
  st := ce.try(format('select creative_register_template(%L)', jsonb_set(t1, '{spec}', '{"layers": ["photo"]}')));
  perform ce.ok('T3 the same key and version with a different spec is refused', st like '23505:%new version%', st);
  st := ce.try(format($q$update creative_templates set spec = '{"layers": []}' where id = %L$q$, ce.got('t1')));
  perform ce.ok('T4 a registered template is immutable, even for the Engine', st like '23514:%immutable%', st);
  st := ce.try(format($q$delete from creative_templates where id = %L$q$, ce.got('t1')));
  perform ce.ok('T5 templates are never deleted', st like '42501:%', st);
  res := creative_register_template(jsonb_set(t1, '{version}', '2'));
  perform ce.put('t1v2', (res->>'template_id')::uuid);

  -- A client-specific preview.
  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'purpose', 'template_preview', 'template_id', ce.got('t1'),
    'strategy', 'source_photo', 'reason', 'preview', 'requested_via', 'team', 'brief', ce.brief(0), 'brief_hash', ce.bhash(0),
    'renderer', 'sandbox-renderer/1'));
  v_run := (res->>'run_id')::uuid;
  res := creative_write(jsonb_build_object('run_id', v_run,
    'asset', jsonb_build_object('content_hash', ce.h('preview1'), 'format', 'png', 'width', 1200, 'height', 900, 'size_bytes', 1000,
      'overlay', jsonb_build_array(jsonb_build_object('role', 'service_name', 'text', 'Roof Replacement', 'source_id', ce.id('rr')),
                                   jsonb_build_object('role', 'business_name', 'text', 'Creative Roofing'))),
    'sources', ce.src(ce.id('p1'))));
  perform ce.put('preview', (res->>'creative_asset_id')::uuid);
  perform ce.ok('T6 a preview is recorded and proposes the exact template version for the client',
    (res->>'preview')::boolean
    and (select status = 'proposed' and preview_asset_id = ce.got('preview') from client_creative_templates
         where client_id = ce.id('c') and template_id = ce.got('t1'))
    and (select purpose = 'template_preview' and template_spec_hash = (select spec_hash from creative_templates where id = ce.got('t1'))
         and storage_path = ce.id('c') || '/' || ce.h('preview1') || '.png' from creative_assets where id = ce.got('preview')), res::text);
  perform ce.ok('T7 the run succeeded with the asset', (select status = 'succeeded' and creative_asset_id = ce.got('preview') and finished_at is not null
                                                         from creative_runs where id = v_run));
  st := ce.try(format($q$update client_creative_templates set status = 'approved' where client_id = %L$q$, ce.id('c')));
  perform ce.ok('T8 the Engine cannot approve a template for a client', st like '42501:%teammate%', st);
end $$;
reset role;

set role authenticated;
select ce.as_user('authenticated', :'team');
do $$
declare st text; v_me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  update client_creative_templates set status = 'approved', note = 'Looks right' where client_id = ce.id('c') and template_id = ce.got('t1');
  perform ce.ok('T9 a teammate approves the previewed version; stamped and recorded',
    (select status = 'approved' and approved_by = v_me from client_creative_templates where client_id = ce.id('c') and template_id = ce.got('t1'))
    and exists (select 1 from creative_governance_events where subject_type = 'client_template' and action = 'approved' and actor_id = v_me));
  insert into client_creative_templates (client_id, template_id) values (ce.id('c'), ce.got('t1v2'));
  st := ce.try(format($q$update client_creative_templates set status = 'approved' where client_id = %L and template_id = %L$q$, ce.id('c'), ce.got('t1v2')));
  perform ce.ok('T10 a new version cannot be approved without its own preview', st like '23514:%preview%', st);
  st := ce.try(format($q$update client_creative_templates set preview_asset_id = %L where client_id = %L and template_id = %L$q$,
    ce.got('preview'), ce.id('c'), ce.got('t1v2')));
  perform ce.ok('T11 a teammate cannot attach a preview (only the Engine records one)', st like '42501:%', st);
  perform ce.ok('T12 v1 stays approved; v2 is only proposed (no silent replacement)',
    (select array_agg(status order by template_id = ce.got('t1v2')) from client_creative_templates where client_id = ce.id('c'))
      = array['approved', 'proposed']);
end $$;
reset role;

-- ── R. Drafter + render + write (the creative session) ──────────────────────
set role service_role;
select ce.as_user('service_role', null);
-- The post-drafter function's call is its own request (transaction).
do $$
declare res jsonb; v_copy text := 'Planning a roof replacement? We install Owens Corning Duration shingles. Learn more.';
begin
  res := drafter_write(ce.req(v_copy));
  perform ce.put('dp', (res->>'post_id')::uuid);
  perform ce.ok('R1 drafter_write leaves a post that requires creative as a draft, creative needed, no review task',
    res->>'creative_policy' = 'required' and res->>'review_task_id' is null
    and (select review_status = 'draft' and creative_policy = 'required' and creative_status = 'needed' and drafter_run_id is not null
         from social_posts where id = ce.got('dp'))
    and (select status = 'submitted' from drafter_runs where id = (res->>'run_id')::uuid), res::text);
end $$;
do $$
declare res jsonb; st text; v_post uuid; v_run uuid; v_copy text := 'Planning a roof replacement? We install Owens Corning Duration shingles. Learn more.';
  v_runs0 bigint;
begin
  v_post := ce.got('dp');

  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', ce.id('hp'),
    'template_id', ce.got('t1'), 'strategy', 'generated_layer', 'copy_hash', ce.sha('New roofs installed right.'),
    'brief', ce.brief(9), 'brief_hash', ce.bhash(9), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('R2 generated imagery is refused while the client''s setting is off', st like '23514:%Generated imagery is off%', st);
  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1v2'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(1), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('R3 a template version the client has not approved is refused', st like '23514:%not approved%', st);
  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha('other copy'),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(1), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('R4 a brief built for other copy is refused', st like '23514: stale_copy%', st);
  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(2), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('R5 a brief hash that is not the brief''s is refused', st like '23514:%brief_hash%', st);

  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(1), 'renderer', 'sandbox-renderer/1'));
  v_run := (res->>'run_id')::uuid;
  perform ce.put('run1', v_run);
  perform ce.ok('R6 a run begins; the post is rendering',
    not (res->>'reused')::boolean and (select creative_status = 'rendering' from social_posts where id = v_post)
    and (select status = 'rendering' and copy_hash = ce.sha(v_copy) and template_spec_hash = (select spec_hash from creative_templates where id = ce.got('t1'))
         from creative_runs where id = v_run), res::text);
  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(1), 'renderer', 'sandbox-renderer/1'));
  perform ce.ok('R7 the same inputs are the same run (idempotent)', (res->>'reused')::boolean and (res->>'run_id')::uuid = v_run, res::text);
  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(2), 'brief_hash', ce.bhash(2), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('R8 a second rendering run for the same post is refused', st like '23505:%', st);

  v_runs0 := (select count(*) from creative_assets);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('nofile'), 0, ce.overlay(), ce.src(ce.id('p1')))));
  perform ce.ok('R9 a file that is not in the bucket at its content address is refused', st like '23514:%not in the creative-assets bucket%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('small'), 0, ce.overlay(), ce.src(ce.id('p1')), false, 600, 450)));
  perform ce.ok('R10 a render that is not the template''s output size is refused', st like '23514:%output size%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0,
    '[{"role": "tagline", "text": "Best roofer in Missouri"}]', ce.src(ce.id('p1')))));
  perform ce.ok('R11 invented overlay text is refused (must equal the governed tagline)', st like '23514: overlay_ungoverned%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0,
    '[{"role": "headline", "text": "25% off all roofs"}]', ce.src(ce.id('p1')))));
  perform ce.ok('R12 an overlay role outside the governed set is refused', st like '23514: overlay_ungoverned%unknown role%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0,
    jsonb_build_array(jsonb_build_object('role', 'claim', 'text', 'Roofing, siding, guttering, fascia and soffit contractor for the whole region', 'source_id', ce.id('cllong'))),
    ce.src(ce.id('p1')))));
  perform ce.ok('R13 a primary overlay line over 8 words is refused, even when governed', st like '23514: overlay_ungoverned%8 words%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0,
    '[{"role": "service_name", "text": "Roof Repair"}]', ce.src(ce.id('p1')))));
  perform ce.ok('R14 a service name that is not the post''s service is refused', st like '23514: overlay_ungoverned%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('p2')))));
  perform ce.ok('R15 an unreviewed source photo is refused', st like '23514:%unreviewed for creative use%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('p4')))));
  perform ce.ok('R16 an excluded source photo is refused', st like '23514:%excluded for creative use%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('p3')))));
  perform ce.ok('R17 an approved photo that is not the client''s own work is refused', st like '23514:%own work%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('p1'), 'photo', ce.h('other')))));
  perform ce.ok('R18 a source whose bytes are not the reviewed file is refused', st like '23514:%not the reviewed file%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('l1'), 'logo'))));
  perform ce.ok('R19 a source-photo creative needs a photo', st like '23514:%names its approved photo%', st);
  st := ce.try(format('select creative_write(%L)', ce.render(v_run, ce.h('r1'), 3, ce.overlay(), ce.src(ce.id('p1')))));
  perform ce.ok('R20 a stale creative version is refused (compare-and-set)', st like '23514: creative_version_conflict%', st);
  perform ce.ok('R21 every refusal wrote nothing', (select count(*) from creative_assets) = v_runs0
    and (select status from creative_runs where id = v_run) = 'rendering');

  res := creative_write(ce.render(v_run, ce.h('r1'), 0, ce.overlay(), ce.src(ce.id('p1')) || ce.src(ce.id('l1'), 'logo'), true));
  perform ce.put('a1', (res->>'creative_asset_id')::uuid);
  perform ce.ok('R22 the creative is recorded, linked, and the post submitted for review',
    (res->>'new')::boolean and (res->>'creative_version')::int = 1 and res->>'review_task_id' is not null
    and (select review_status = 'in_review' and creative_status = 'ready' and creative_version = 1 and copy = v_copy
         from social_posts where id = v_post), res::text);
  perform ce.ok('R23 the link carries the creative''s bytes hash and the copy it was made for',
    (select count(*) = 1 and bool_and(creative_asset_id = ce.got('a1') and brand_asset_id is null and content_hash = ce.h('r1')
            and copy_hash = ce.sha(v_copy) and role = 'primary')
     from post_assets where post_id = v_post));
  perform ce.ok('R24 the asset is content-addressed, with provenance',
    (select storage_path = ce.id('c') || '/' || ce.h('r1') || '.png' and strategy = 'source_photo' and run_id = v_run
            and template_id = ce.got('t1') and overlay = ce.overlay() and alt_text is not null
     from creative_assets where id = ce.got('a1')));
  perform ce.ok('R25 the sources record the reviewed bytes and the governance at render time',
    (select count(*) = 2 and bool_and(source_content_hash is not null and governance->>'creative_use' = 'approved')
            and bool_or(role = 'photo' and brand_asset_id = ce.id('p1') and (governance->>'depicts_own_work')::boolean
                        and governance->'subjects' = '["roof", "shingles"]' and crop is not null and focal = '{"x": 0.5, "y": 0.4}')
     from creative_asset_sources where creative_asset_id = ce.got('a1')));
  perform ce.ok('R26 post history names the Creative Engine as its own actor',
    exists (select 1 from post_events where post_id = v_post and kind = 'creative_linked' and actor_kind = 'creative' and to_value = ce.got('a1')::text)
    and exists (select 1 from post_events where post_id = v_post and kind = 'submitted' and actor_kind = 'creative')
    and not exists (select 1 from post_events where post_id = v_post and actor_kind = 'publisher'));
  perform ce.ok('R27 the run succeeded with the asset', (select status = 'succeeded' and creative_asset_id = ce.got('a1') from creative_runs where id = v_run));
  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(1), 'brief_hash', ce.bhash(1), 'renderer', 'sandbox-renderer/1'));
  perform ce.ok('R28 repeating the finished request returns the same run and asset', (res->>'reused')::boolean
    and (res->>'creative_asset_id')::uuid = ce.got('a1'), res::text);
end $$;
-- Immutability: the service role outside the Engine's functions (a new request).
do $$
declare st text; v_post uuid := ce.got('dp'); v_run uuid := ce.got('run1');
begin
  st := ce.try(format($q$update creative_assets set alt_text = 'changed' where id = %L$q$, ce.got('a1')));
  perform ce.ok('R29 a creative asset is immutable', st like '42501:%', st);
  st := ce.try(format($q$delete from creative_assets where id = %L$q$, ce.got('a1')));
  perform ce.ok('R30 a creative asset is never deleted', st like '42501:%', st);
  st := ce.try(format($q$update creative_asset_sources set source_content_hash = %L where creative_asset_id = %L$q$, ce.h('x'), ce.got('a1')));
  perform ce.ok('R31 creative sources are immutable', st like '23514:%immutable%', st);
  st := ce.try(format($q$update creative_runs set brief = '{}' where id = %L$q$, v_run));
  perform ce.ok('R32 runs are written only by the Engine''s functions', st like '42501:%', st);
  st := ce.try(format($q$delete from post_assets where post_id = %L$q$, v_post));
  perform ce.ok('R33 a submitted post''s creative cannot be unlinked outside the Engine or a teammate', st like '42501:%', st);
end $$;
reset role;

-- ── A. Approval binds the exact copy and bytes; governance lapses it ────────
set role authenticated;
select ce.as_user('authenticated', :'team');
do $$
declare st text; v_post uuid := ce.got('dp'); s jsonb;
begin
  st := ce.try(format($q$update social_posts set review_status = 'rejected', review_note = 'Not right' where id = %L$q$, v_post));
  perform ce.ok('A1 rejecting a post with creative needs the category (copy, creative or both)', st like '23514:%copy, the creative or both%', st);
  update social_posts set review_status = 'approved' where id = v_post;
  select approved_snapshot into s from social_posts where id = v_post;
  perform ce.ok('A2 the approval binds the exact creative bytes and the copy they were made for',
    s->'creative'->0->>'content_hash' = ce.h('r1') and s->'creative'->0->>'copy_hash' = ce.sha(s->>'copy')
    and s->'creative'->0->>'storage_path' = ce.id('c') || '/' || ce.h('r1') || '.png' and s->'assets' = '[]'::jsonb
    and (select approved_hash = ce.sha(s::text) from social_posts where id = v_post), s::text);

  -- Excluding the source photo after approval sends the post back to review.
  update brand_assets set creative_use = 'excluded', creative_review_note = 'Shows a neighbour''s house' where id = ce.id('p1');
  perform ce.ok('A3 excluding a source image lapses the approved post back to review',
    (select review_status = 'in_review' and approved_hash is null from social_posts where id = v_post)
    and exists (select 1 from post_events where post_id = v_post and kind = 'grounding_lapsed'
                and detail->>'problems' like '%excluded for creative use%'));
  update social_posts set review_status = 'rejected', review_note = 'The photo cannot be used', rejection_category = 'creative' where id = v_post;
  perform ce.ok('A4 a creative-only rejection is recorded',
    (select review_status = 'rejected' and rejection_category = 'creative' from social_posts where id = v_post)
    and exists (select 1 from post_events where post_id = v_post and kind = 'rejection_classified' and to_value = 'creative'));
end $$;

-- ── N. Request new creative ─────────────────────────────────────────────────
do $$
declare st text; v_post uuid := ce.got('dp'); v_copy text; v_runs bigint := (select count(*) from drafter_runs);
begin
  select copy into v_copy from social_posts where id = v_post;
  perform request_new_creative(v_post, 'Use a finished-roof photo');
  perform ce.ok('N1 request new creative: back to draft, creative unlinked, status requested, copy unchanged',
    (select review_status = 'draft' and creative_status = 'requested' and copy = v_copy and creative_version = 1
            and drafter_run_id is not null from social_posts where id = v_post)
    and not exists (select 1 from post_assets where post_id = v_post));
  perform ce.ok('N2 ...and no Drafter run', (select count(*) from drafter_runs) = v_runs);
  perform ce.ok('N3 ...recorded with the teammate and the note',
    exists (select 1 from post_events where post_id = v_post and kind = 'creative_requested' and actor_kind = 'team'
            and detail->>'note' = 'Use a finished-roof photo')
    and exists (select 1 from post_events where post_id = v_post and kind = 'creative_unlinked' and actor_kind = 'team'));

  -- A post whose copy is rejected does not get new creative; it needs a new draft.
  update social_posts set creative_policy = 'none' where id = ce.id('hp');
  perform ce.ok('N4 a teammate may change a draft''s creative policy (recorded)',
    (select creative_policy = 'none' and creative_status = 'none' from social_posts where id = ce.id('hp'))
    and exists (select 1 from post_events where post_id = ce.id('hp') and kind = 'creative_policy_changed' and to_value = 'none'));
  update social_posts set review_status = 'in_review' where id = ce.id('hp');
  st := ce.try(format($q$update social_posts set review_status = 'rejected', review_note = 'x', rejection_category = 'creative' where id = %L$q$, ce.id('hp')));
  perform ce.ok('N5 a post without creative cannot have its creative rejected', st like '23514:%only its copy%', st);
  update social_posts set review_status = 'rejected', review_note = 'Wrong tone' where id = ce.id('hp');
  perform ce.ok('N6 a rejection without creative is a copy rejection', (select rejection_category = 'copy' from social_posts where id = ce.id('hp')));
  st := ce.try(format($q$select request_new_creative(%L, 'x')$q$, ce.id('hp')));
  perform ce.ok('N7 request new creative is refused after a copy rejection', st like '23514:%copy was rejected%', st);

  update brand_assets set creative_use = 'approved', creative_review_note = null where id = ce.id('p1');
end $$;
reset role;

-- ── V. Regenerate (same bytes reuse), manual upload, copy change ────────────
set role service_role;
select ce.as_user('service_role', null);
do $$
declare res jsonb; st text; v_post uuid := ce.got('dp'); v_copy text; v_run uuid; v_src bigint;
begin
  select copy into v_copy from social_posts where id = v_post;
  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post, 'reason', 'regenerate',
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(3), 'brief_hash', ce.bhash(3), 'renderer', 'sandbox-renderer/1'));
  v_run := (res->>'run_id')::uuid;
  st := ce.try(format('select creative_fail_run(%L)', jsonb_build_object('run_id', v_run, 'error', 'renderer out of memory')));
  perform ce.ok('V1 a failed render is recorded; the post shows failed',
    st is null and (select status = 'failed' and error = 'renderer out of memory' from creative_runs where id = v_run)
    and (select creative_status = 'failed' from social_posts where id = v_post)
    and exists (select 1 from post_events where post_id = v_post and kind = 'creative_failed' and actor_kind = 'creative'), st);
  res := creative_begin_run(jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post, 'reason', 'retry',
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(3), 'brief_hash', ce.bhash(3), 'renderer', 'sandbox-renderer/1'));
  perform ce.ok('V2 a failed run does not block retrying the same inputs', not (res->>'reused')::boolean and (res->>'run_id')::uuid <> v_run, res::text);
  v_run := (res->>'run_id')::uuid;
  v_src := (select count(*) from creative_asset_sources);
  res := creative_write(ce.render(v_run, ce.h('r1'), 1, ce.overlay(), ce.src(ce.id('p1'))));
  perform ce.ok('V3 the same bytes are the same asset (no duplicate, no new sources); version advances',
    not (res->>'new')::boolean and (res->>'creative_asset_id')::uuid = ce.got('a1') and (res->>'creative_version')::int = 2
    and (select count(*) from creative_asset_sources) = v_src
    and (select review_status = 'draft' and creative_status = 'ready' from social_posts where id = v_post), res::text);

  -- A teammate's own file, recorded by the Engine.
  st := ce.try(format('select creative_write(%L)', jsonb_build_object('mode', 'manual', 'client_id', ce.id('c'), 'post_id', v_post,
    'uploaded_by', gen_random_uuid(), 'expected_creative_version', 2, 'provenance', jsonb_build_object('uploaded_via', 'app'),
    'asset', jsonb_build_object('content_hash', ce.h('manual'), 'format', 'jpeg', 'width', 1600, 'height', 1200, 'size_bytes', 1000,
                                'alt_text', 'New roof, finished'))));
  perform ce.ok('V4 a manual upload names a real teammate', st like '23514:%teammate%', st);
  st := ce.try(format('select creative_write(%L)', jsonb_build_object('mode', 'manual', 'client_id', ce.id('c'), 'post_id', v_post,
    'uploaded_by', (select id from team_members limit 1), 'expected_creative_version', 2, 'provenance', jsonb_build_object('uploaded_via', 'app'),
    'asset', jsonb_build_object('content_hash', ce.h('manual'), 'format', 'jpeg', 'width', 1600, 'height', 1200, 'size_bytes', 1000,
                                'alt_text', 'New roof, finished', 'overlay', '[{"role": "business_name", "text": "Creative Roofing"}]'::jsonb))));
  perform ce.ok('V5 a manual upload records no overlay', st like '23514: overlay_ungoverned%manual%', st);
  res := creative_write(jsonb_build_object('mode', 'manual', 'client_id', ce.id('c'), 'post_id', v_post,
    'uploaded_by', (select id from team_members limit 1), 'expected_creative_version', 2,
    'provenance', jsonb_build_object('uploaded_via', 'app', 'file_name', 'roof.jpg'),
    'asset', jsonb_build_object('content_hash', ce.h('manual'), 'format', 'jpeg', 'width', 1600, 'height', 1200, 'size_bytes', 1000,
                                'alt_text', 'New roof, finished')));
  perform ce.put('manual', (res->>'creative_asset_id')::uuid);
  perform ce.ok('V6 a manual creative: strategy manual, uploader, path, hash, provenance; it replaces the old link',
    (select strategy = 'manual' and uploaded_by is not null and run_id is null and template_id is null and format = 'jpeg'
            and storage_path = ce.id('c') || '/' || ce.h('manual') || '.jpg' and provenance->>'file_name' = 'roof.jpg'
     from creative_assets where id = ce.got('manual'))
    and (select array_agg(creative_asset_id) from post_assets where post_id = v_post) = array[ce.got('manual')]
    and (select creative_version = 3 from social_posts where id = v_post), res::text);
end $$;
reset role;

set role authenticated;
select ce.as_user('authenticated', :'team');
do $$
declare st text; v_post uuid := ce.got('dp');
begin
  update social_posts set copy = 'Planning a roof replacement? We install Owens Corning Duration shingles. Ask us.' where id = v_post;
  perform ce.ok('C1 a copy change unlinks creative made for the old copy; creative is needed again',
    not exists (select 1 from post_assets where post_id = v_post and creative_asset_id is not null)
    and (select creative_status = 'needed' from social_posts where id = v_post)
    and exists (select 1 from post_events where post_id = v_post and kind = 'creative_unlinked' and actor_kind = 'system'));
  st := ce.try(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, v_post));
  perform ce.ok('C2 ...and it cannot be submitted until new creative is linked', st like '23514:%needs its creative%', st);

  st := ce.try(format($q$update creative_assets set withdrawn_at = now() where id = %L$q$, ce.got('manual')));
  perform ce.ok('C3 withdrawing a creative needs a reason', st like '23514:%withdrawn_explained%', st);
  update creative_assets set withdrawn_at = now(), withdrawn_reason = 'Wrong house' where id = ce.got('manual');
  perform ce.ok('C4 a teammate withdraws a creative; recorded',
    (select withdrawn_at is not null and withdrawn_by is not null from creative_assets where id = ce.got('manual'))
    and exists (select 1 from creative_governance_events where subject_id = ce.got('manual') and action = 'withdrawn' and note = 'Wrong house'));
  st := ce.try(format($q$update creative_assets set withdrawn_reason = 'changed' where id = %L$q$, ce.got('manual')));
  perform ce.ok('C5 a withdrawal happens once', st like '23514:%once%', st);

  update client_creative_templates set status = 'revoked' where client_id = ce.id('c') and template_id = ce.got('t1');
  perform ce.ok('C6 a teammate revokes a template for the client; recorded',
    exists (select 1 from creative_governance_events where subject_type = 'client_template' and action = 'revoked'));
end $$;
reset role;

set role service_role;
select ce.as_user('service_role', null);
do $$
declare st text; v_post uuid := ce.got('dp'); v_copy text;
begin
  select copy into v_copy from social_posts where id = v_post;
  st := ce.try(format('select creative_begin_run(%L)', jsonb_build_object('client_id', ce.id('c'), 'post_id', v_post,
    'template_id', ce.got('t1'), 'strategy', 'source_photo', 'copy_hash', ce.sha(v_copy),
    'brief', ce.brief(4), 'brief_hash', ce.bhash(4), 'renderer', 'sandbox-renderer/1')));
  perform ce.ok('C7 a revoked template version is no longer used', st like '23514:%not approved%', st);
  st := ce.try(format('select creative_write(%L)', jsonb_build_object('mode', 'manual', 'client_id', ce.id('c'), 'post_id', v_post,
    'uploaded_by', (select id from team_members limit 1), 'expected_creative_version', 3, 'provenance', jsonb_build_object('uploaded_via', 'app'),
    'asset', jsonb_build_object('content_hash', ce.h('manual'), 'format', 'jpeg', 'width', 1600, 'height', 1200, 'size_bytes', 1000,
                                'alt_text', 'New roof, finished'))));
  perform ce.ok('C8 withdrawn bytes are not linked again', st like '23514:%withdrawn%', st);
end $$;
reset role;

-- ── P. Portal contact, stranger, anon ───────────────────────────────────────
select ce.as_user('authenticated', :'pb');
set role authenticated;
do $$
begin
  perform ce.ok('P1 a portal contact sees no creative rows',
    (select count(*) from creative_assets) + (select count(*) from creative_runs) + (select count(*) from creative_templates)
    + (select count(*) from client_creative_templates) + (select count(*) from creative_governance_events)
    + (select count(*) from creative_asset_sources) + (select count(*) from client_creative_settings) = 0);
  perform ce.ok('P2 ...no creative files', (select count(*) from storage.objects where bucket_id = 'creative-assets') = 0);
  perform ce.ok('P3 ...cannot request new creative', ce.try(format($q$select request_new_creative(%L, 'x')$q$, ce.got('dp'))) like '42501:%');
  perform ce.ok('P4 ...cannot set a policy',
    ce.try(format($q$insert into client_creative_settings (client_id, channel, creative_policy) values (%L, 'facebook', 'required')$q$, ce.id('c'))) like '42501:%');
end $$;
select ce.as_user('authenticated', :'strngr');
do $$
begin
  perform ce.ok('P5 a signed-in stranger sees no creative rows',
    (select count(*) from creative_assets) + (select count(*) from creative_governance_events) = 0);
  perform ce.ok('P6 ...cannot request new creative', ce.try(format($q$select request_new_creative(%L, 'x')$q$, ce.got('dp'))) like '42501:%');
end $$;
reset role;
set role anon;
select ce.as_user('anon', null);
do $$
begin
  perform ce.ok('P7 anon cannot read creative tables', ce.try('select count(*) from creative_assets') like '42501:%');
  perform ce.ok('P8 anon cannot call request_new_creative', ce.try(format($q$select request_new_creative(%L, 'x')$q$, ce.got('dp'))) like '42501:%');
end $$;
reset role;

-- The team reads creative files; nobody writes them through the API.
select ce.as_user('authenticated', :'team');
set role authenticated;
do $$
begin
  perform ce.ok('P9 a teammate reads creative files', (select count(*) from storage.objects where bucket_id = 'creative-assets') >= 5);
  perform ce.ok('P10 a teammate cannot upload into the creative bucket (only the Engine, with the service role)',
    ce.try(format($q$insert into storage.objects (bucket_id, name) values ('creative-assets', %L)$q$, ce.id('c') || '/x.png')) like '42501:%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── X. Storage and records hold against the worker ──────────────────────────
\c - postgres
do $$
declare st text;
begin
  st := ce.try(format($q$delete from storage.objects where bucket_id = 'creative-assets' and name = %L$q$, ce.id('c') || '/' || ce.h('r1') || '.png'));
  perform ce.ok('X1 a creative file is never deleted', st like '42501:%immutable%', st);
  st := ce.try(format($q$update storage.objects set name = 'moved.png' where bucket_id = 'creative-assets' and name = %L$q$, ce.id('c') || '/' || ce.h('r1') || '.png'));
  perform ce.ok('X2 ...nor renamed', st like '42501:%immutable%', st);
  st := ce.try(format($q$update storage.objects set metadata = '{"size": 1000, "mimetype": "image/png", "cacheControl": "3600"}' where bucket_id = 'creative-assets' and name = %L$q$, ce.id('c') || '/' || ce.h('r1') || '.png'));
  perform ce.ok('X3 ...its metadata may still be completed by Storage', st is null, st);
  st := ce.try(format($q$delete from storage.objects where bucket_id = 'brand-assets' and name = %L$q$, ce.id('c') || '/p1.jpg'));
  perform ce.ok('X4 other buckets are unaffected', st is null, st);
  st := ce.try(format($q$update creative_assets set withdrawn_at = now(), withdrawn_reason = 'x' where id = %L$q$, ce.got('a1')));
  perform ce.ok('X5 the worker cannot withdraw a creative', st like '42501:%teammate%', st);
  st := ce.try(format($q$update client_creative_templates set status = 'approved' where client_id = %L and template_id = %L$q$, ce.id('c'), ce.got('t1v2')));
  perform ce.ok('X6 the worker cannot approve a template for a client', st like '42501:%', st);
  st := ce.try(format($q$insert into post_assets (post_id, client_id, creative_asset_id) values (%L, %L, %L)$q$, ce.got('dp'), ce.id('c'), ce.got('a1')));
  perform ce.ok('X7 the worker cannot link creative to a post', st like '42501:%', st);
  st := ce.try(format($q$update social_posts set creative_policy = 'none' where id = %L$q$, ce.got('dp')));
  perform ce.ok('X8 the worker cannot change a post''s creative policy', st like '42501:%', st);
  st := ce.try(format($q$select request_new_creative(%L, 'x')$q$, ce.got('dp')));
  perform ce.ok('X9 the worker cannot request new creative', st like '42501:%', st);
  st := ce.try(format($q$delete from creative_governance_events where client_id = %L$q$, ce.id('c')));
  perform ce.ok('X10 governance history is append-only', st like '42501:%append-only%', st);
  st := ce.try(format($q$update creative_runs set status = 'cancelled' where id = %L$q$, ce.got('run1')));
  perform ce.ok('X11 the worker cannot touch runs', st like '42501:%', st);
  st := ce.try(format($q$insert into post_assets (post_id, client_id, brand_asset_id, creative_asset_id) values (%L, %L, %L, %L)$q$,
    ce.got('dp'), ce.id('c'), ce.id('p1'), ce.got('a1')));
  perform ce.ok('X12 a link is a brand asset or a creative asset, never both', st is not null, st);

  -- Deleting a source brand asset keeps the creative's record (hash stays)
  -- and the one post still reading it is told.
  delete from brand_assets where id = ce.id('l1');
  perform ce.ok('X13 a deleted source brand asset leaves the source record (id cleared, hash kept)',
    (select brand_asset_id is null and source_content_hash is not null from creative_asset_sources
     where creative_asset_id = ce.got('a1') and role = 'logo'));
end $$;

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from ce.results group by status order by status;
select n, status, name, detail from ce.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from ce.results where status = 'fail';
  if f > 0 then raise exception '% creative engine check(s) failed', f; end if;
end $$;
