-- Tests for migration 0057 (overlay roles: phone, website, service segment,
-- template label; claims in template previews; up to 12 lines), run by
-- scripts/test-portal-sandbox.sh on the same replay. Own harness schema (co)
-- and its own client. Also proves that the renderer's spec hash (TypeScript,
-- tests/fixtures/creative-lucas-templates.json) is Postgres's own
-- creative_spec_hash for every Lucas template: the runner passes the file as
-- :'specs'.
--
-- Callers are real sessions: postgres (the worker's login), supabase_admin
-- (fixtures a person or the hasher would have made), authenticator +
-- service_role (the Creative Engine function). Fictional data only.

\o /dev/null
create schema co;
create table co.results (n serial, status text, name text, detail text);
create table co.ids (k text primary key, id uuid);
grant usage on schema co to anon, authenticated, service_role, authenticator;
grant insert, select on co.results to anon, authenticated, service_role, authenticator;
grant select, insert, update on co.ids to service_role, authenticator;
grant usage on sequence co.results_n_seq to anon, authenticated, service_role, authenticator;
create table co.specs (doc jsonb);
grant select on co.specs to service_role;
insert into co.specs values (:'specs'::jsonb);

create function co.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into co.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function co.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function co.id(p_k text) returns uuid language sql immutable as $$ select md5('co:' || p_k)::uuid $$;
create function co.h(p_k text) returns text language sql immutable as $$ select encode(sha256(convert_to('bytes:' || p_k, 'UTF8')), 'hex') $$;
create function co.got(p_k text) returns uuid language sql stable as $$ select id from co.ids where k = p_k $$;
create function co.put(p_k text, p_id uuid) returns void language sql as $$
  insert into co.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id
$$;
create function co.line(p_role text, p_text text, p_src uuid default null) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('role', p_role, 'text', p_text, 'source_id', p_src))
$$;
-- The overlay rule for a template preview (no post) of the fixture client.
create function co.problems(p_overlay jsonb) returns text[] language sql as $$
  select public.creative_overlay_problems(co.id('c'), null, p_overlay)
$$;
grant execute on all functions in schema co to service_role, authenticator;

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
insert into clients (id, name, city, state, phone, website_url, status) values
  (co.id('c'), 'Overlay Roofing', 'Wentzville', 'MO', '(555) 010-0000', 'https://www.overlay.example.test/', 'active'),
  (co.id('other'), 'Other Roofing', 'Troy', 'MO', '(555) 010-9999', 'https://other.example.test', 'active');
insert into services (id, client_id, name, segment, status) values
  (co.id('rr'), co.id('c'), 'Roof Replacement', 'Roofing', 'approved'),
  (co.id('old'), co.id('c'), 'Roof Coating', 'Roofing', 'retired'),
  (co.id('nosegment'), co.id('c'), 'Gutter Installation', null, 'approved');
insert into claims (id, client_id, claim, status, source) values
  (co.id('oc'), co.id('c'), 'Owens Corning Preferred Contractor', 'sourced', 'https://overlay.example.test/about'),
  (co.id('free'), co.id('c'), 'Free quotes offered', 'unverified', null),
  (co.id('nosrc'), co.id('c'), 'Installs Duration shingles', 'sourced', null),
  (co.id('conf'), co.id('c'), 'BBB Accredited Business since 6/30/2025', 'confirmed', null),
  (co.id('theirs'), co.id('other'), 'Other Roofing is certified', 'sourced', 'https://other.example.test');
update client_brands set tagline = 'Built right the first time' where client_id = co.id('c');
insert into brand_boards (client_id, version, standing_cta) values (co.id('c'), 1, 'Request a quote');

-- A reviewed photo and logo, as a person and the hasher would have left them.
\c - supabase_admin
insert into brand_assets (id, client_id, kind, label, source, storage_path, width, height, content_hash, content_hashed_at,
                          creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_reviewed_at) values
  (co.id('p1'), co.id('c'), 'photo', 'Finished roof', 'website_scan', co.id('c') || '/p1.jpg', 1536, 2048, co.h('p1'), now(),
   'approved', true, '{roof,architectural shingles}', 0.5, 0.33, now()),
  (co.id('l1'), co.id('c'), 'logo_primary', 'Wordmark', 'link', co.id('c') || '/logo.png', 1200, 886, co.h('l1'), now(),
   'approved', null, '{logo,wordmark}', null, null, now());
insert into storage.objects (bucket_id, name, metadata) values
  ('brand-assets', co.id('c') || '/p1.jpg', '{"size": 1000}'),
  ('brand-assets', co.id('c') || '/logo.png', '{"size": 1000}'),
  ('creative-assets', co.id('c') || '/' || co.h('render9') || '.png', '{"size": 70000, "mimetype": "image/png"}'),
  ('creative-assets', co.id('c') || '/' || co.h('render13') || '.png', '{"size": 70000, "mimetype": "image/png"}');
\c - postgres

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
begin
  perform co.ok('S1 creative_overlay_problems stays service-role only and security invoker',
    has_function_privilege('service_role', 'public.creative_overlay_problems(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.creative_overlay_problems(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.creative_overlay_problems(uuid,uuid,jsonb)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.creative_overlay_problems(uuid,uuid,jsonb)'::regprocedure));
  perform co.ok('S2 the stored overlay is bounded at 12 lines',
    pg_get_constraintdef((select oid from pg_constraint where conname = 'creative_assets_overlay_bounded')) like '%<= 12%');
  perform co.ok('S3 the worker still cannot call the overlay rule or the writes',
    co.try($q$select creative_write('{}')$q$) like '42501:%'
    and co.try($q$select creative_register_template('{}')$q$) like '42501:%');
end $$;

-- ── The Creative Engine session ─────────────────────────────────────────────
\c - authenticator
set role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', false);
do $$
declare res jsonb; t jsonb; n int := 0; mism text := ''; v_run uuid; st text; lines jsonb;
begin
  -- H. The renderer's spec hash is creative_spec_hash, for every Lucas spec.
  for t in select * from jsonb_array_elements((select doc from co.specs)) loop
    res := creative_register_template(t - 'spec_hash');
    if res->>'spec_hash' <> t->>'spec_hash' then mism := mism || (t->>'key') || ' '; end if;
    n := n + 1;
    if t->>'key' = 'lucas-real-work-gbp' then perform co.put('realwork', (res->>'template_id')::uuid); end if;
    if t->>'key' = 'lucas-seasonal-gbp' then perform co.put('seasonal', (res->>'template_id')::uuid); end if;
  end loop;
  perform co.ok('H1 all 15 Lucas specs register, and each spec hash equals the renderer''s (TypeScript) hash',
    n = 15 and mism = '', format('%s specs; mismatches: %s', n, mism));
  perform co.ok('H2 the registered specs hold no phone, website or claim text',
    not exists (select 1 from creative_templates where key like 'lucas-%'
                 and (spec::text ~* '\(636\)|459-9328|lucasconstructionmo|owens corning|lifetime workmanship|5-star')));

  -- P. Phone, website, segment.
  perform co.ok('P1 the governed phone is a valid line',
    cardinality(co.problems(jsonb_build_array(co.line('phone', '(555) 010-0000')))) = 0);
  perform co.ok('P2 a phone that is not the record''s is refused',
    array_to_string(co.problems(jsonb_build_array(co.line('phone', '(555) 010-1234'))), ' ') like '%exactly the governed phone%');
  perform co.ok('P3 the website is shown without scheme, www and trailing slash',
    cardinality(co.problems(jsonb_build_array(co.line('website', 'overlay.example.test')))) = 0
    and cardinality(co.problems(jsonb_build_array(co.line('website', 'https://www.overlay.example.test/')))) = 1);
  perform co.ok('P4 the approved service''s segment is a valid line (preview: named by source_id)',
    cardinality(co.problems(jsonb_build_array(co.line('service_segment', 'Roofing', co.id('rr'))))) = 0);
  perform co.ok('P5 a retired service''s segment, a missing segment and invented text are refused',
    cardinality(co.problems(jsonb_build_array(co.line('service_segment', 'Roofing', co.id('old'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('service_segment', 'Gutters', co.id('nosegment'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('service_segment', 'Exteriors', co.id('rr'))))) = 1);

  -- L. Template labels.
  perform co.ok('L1 a label of the named template is a valid line',
    cardinality(co.problems(jsonb_build_array(co.line('template_label', 'Our work', co.got('realwork'))))) = 0);
  perform co.ok('L2 invented label text, another template''s label and no template are refused',
    cardinality(co.problems(jsonb_build_array(co.line('template_label', 'Best work', co.got('realwork'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('template_label', 'Fall', co.got('realwork'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('template_label', 'Fall', co.got('seasonal'))))) = 0
    and cardinality(co.problems(jsonb_build_array(co.line('template_label', 'Our work')))) = 1);
  perform co.ok('L3 a source_id that is not an id is a problem, not an error',
    array_to_string(co.problems('[{"role": "template_label", "text": "Our work", "source_id": "our_work"}]'), ' ') like '%not an id%');

  -- C. Claims in a preview.
  perform co.ok('C1 a sourced (with source) or confirmed claim of the client is a valid preview line',
    cardinality(co.problems(jsonb_build_array(co.line('claim', 'Owens Corning Preferred Contractor', co.id('oc'))))) = 0
    and cardinality(co.problems(jsonb_build_array(co.line('claim', 'BBB Accredited Business since 6/30/2025', co.id('conf'))))) = 0);
  perform co.ok('C2 an unverified claim, a sourced claim without a source and another client''s claim are refused',
    cardinality(co.problems(jsonb_build_array(co.line('claim', 'Free quotes offered', co.id('free'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('claim', 'Installs Duration shingles', co.id('nosrc'))))) = 1
    and cardinality(co.problems(jsonb_build_array(co.line('claim', 'Other Roofing is certified', co.id('theirs'))))) = 1);
  perform co.ok('C3 a claim line must still equal the claim',
    cardinality(co.problems(jsonb_build_array(co.line('claim', 'Owens Corning Certified Contractor', co.id('oc'))))) = 1);

  -- N. Line count, primary line, unchanged refusals.
  lines := jsonb_build_array(
    co.line('service_name', 'Roof Replacement', co.id('rr')), co.line('service_segment', 'Roofing', co.id('rr')),
    co.line('claim', 'Owens Corning Preferred Contractor', co.id('oc')), co.line('tagline', 'Built right the first time'),
    co.line('standing_cta', 'Request a quote'), co.line('phone', '(555) 010-0000'), co.line('website', 'overlay.example.test'),
    co.line('business_name', 'Overlay Roofing'), co.line('claim', 'BBB Accredited Business since 6/30/2025', co.id('conf')));
  perform co.ok('N1 nine governed lines (a full layout) have no problems', cardinality(co.problems(lines)) = 0,
    array_to_string(co.problems(lines), ' | '));
  perform co.ok('N2 twelve lines are allowed; thirteen are refused',
    cardinality(co.problems(lines || jsonb_build_array(co.line('phone', '(555) 010-0000'), co.line('phone', '(555) 010-0000'),
      co.line('phone', '(555) 010-0000')))) = 0
    and array_to_string(co.problems(lines || jsonb_build_array(co.line('phone', '(555) 010-0000'), co.line('phone', '(555) 010-0000'),
      co.line('phone', '(555) 010-0000'), co.line('phone', '(555) 010-0000'))), ' ') like '%twelve%');
  perform co.ok('N3 the primary line is still at most 8 words; unknown roles still refused',
    array_to_string(co.problems(jsonb_build_array(co.line('tagline', 'Built right the first time'),
      co.line('headline', 'Best roofer in town'))), ' ') like '%unknown role%'
    and array_to_string(co.problems('[{"role": "business_name", "text": "a b c d e f g h i"}]'), ' ') like '%8 words%');

  -- W. End to end: a template preview recording every drawn line.
  res := creative_begin_run(jsonb_build_object('client_id', co.id('c'), 'purpose', 'template_preview', 'template_id', co.got('realwork'),
    'strategy', 'source_photo', 'reason', 'preview', 'requested_via', 'worker',
    'brief', jsonb_build_object('schema', 'compass-creative-brief/1', 'n', 9),
    'brief_hash', 'sha256:' || encode(sha256(convert_to(jsonb_build_object('schema', 'compass-creative-brief/1', 'n', 9)::text, 'UTF8')), 'hex'),
    'renderer', 'creative-engine/1 resvg-wasm@2.6.2 opentype.js@1.3.4'));
  v_run := (res->>'run_id')::uuid;
  res := creative_write(jsonb_build_object('run_id', v_run,
    'asset', jsonb_build_object('content_hash', co.h('render9'), 'format', 'png', 'width', 1200, 'height', 900, 'size_bytes', 70000,
      'alt_text', 'Overlay Roofing project photo graphic: Roof Replacement.',
      'overlay', lines - 8 || jsonb_build_array(co.line('template_label', 'Our work', co.got('realwork')))),
    'sources', jsonb_build_array(
      jsonb_build_object('brand_asset_id', co.id('p1'), 'role', 'photo', 'source_content_hash', co.h('p1'),
                         'crop', jsonb_build_object('x', 0, 'y', 100, 'w', 1536, 'h', 1152), 'focal', jsonb_build_object('x', 0.5, 'y', 0.33)),
      jsonb_build_object('brand_asset_id', co.id('l1'), 'role', 'logo', 'source_content_hash', co.h('l1')))));
  perform co.put('asset9', (res->>'creative_asset_id')::uuid);
  perform co.ok('W1 a preview recording all nine drawn lines (phone, website, segment, label, claims) is written and proposed',
    (res->>'preview')::boolean
    and (select jsonb_array_length(overlay) = 9 from creative_assets where id = co.got('asset9'))
    and (select status = 'proposed' from client_creative_templates where client_id = co.id('c') and template_id = co.got('realwork'))
    and (select count(*) = 2 from creative_asset_sources where creative_asset_id = co.got('asset9')), res::text);

  res := creative_begin_run(jsonb_build_object('client_id', co.id('c'), 'purpose', 'template_preview', 'template_id', co.got('realwork'),
    'strategy', 'source_photo', 'reason', 'preview', 'requested_via', 'worker',
    'brief', jsonb_build_object('schema', 'compass-creative-brief/1', 'n', 13),
    'brief_hash', 'sha256:' || encode(sha256(convert_to(jsonb_build_object('schema', 'compass-creative-brief/1', 'n', 13)::text, 'UTF8')), 'hex'),
    'renderer', 'creative-engine/1 resvg-wasm@2.6.2 opentype.js@1.3.4'));
  v_run := (res->>'run_id')::uuid;
  st := co.try(format('select creative_write(%L)', jsonb_build_object('run_id', v_run,
    'asset', jsonb_build_object('content_hash', co.h('render13'), 'format', 'png', 'width', 1200, 'height', 900, 'size_bytes', 70000,
      'alt_text', 'x', 'overlay', lines || jsonb_build_array(co.line('phone', '(555) 010-0000'), co.line('phone', '(555) 010-0000'),
        co.line('phone', '(555) 010-0000'), co.line('phone', '(555) 010-0000'))),
    'sources', jsonb_build_array(jsonb_build_object('brand_asset_id', co.id('p1'), 'role', 'photo', 'source_content_hash', co.h('p1'))))));
  perform co.ok('W2 thirteen lines are refused at the write, and nothing is recorded',
    st like '23514: overlay_ungoverned%twelve%' and not exists (select 1 from creative_assets where content_hash = co.h('render13')), st);
end $$;
reset role;
\c - postgres

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from co.results group by status order by status;
select n, status, name, detail from co.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from co.results where status = 'fail';
  if f > 0 then raise exception '% creative overlay check(s) failed', f; end if;
end $$;
