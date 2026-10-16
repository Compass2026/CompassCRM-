-- Tests for 20261015210000 (blog hero images), run by
-- scripts/test-portal-sandbox.sh after content_drafts.test.sql (its cd
-- harness and fictional clients a / b) and blog_publication.test.sql.
--
--   H1-H3   the drafter sets a hero with its submit (one transaction), only
--           its own client's stored, hashed photo / social graphic
--   H4-H8   a teammate changes it like content: not in review, not approved,
--           every change bumps the version
--   H9-H12  approval pins asset, hash and alt; reopening and changing the
--           hero clears the approval; hero-less approvals carry no hero key
--   H13     a release whose hero file changed is blocked

\set team '00000000-0000-4000-a000-000000000001'
\set pa   '00000000-0000-4000-a000-000000000011'

\c - supabase_admin
\o /dev/null
-- A hash is recorded with its time and measurement (brand_assets_hash_recorded).
insert into brand_assets (id, client_id, kind, label, source, storage_path, mime_type, width, height, size_bytes,
                          content_hash, content_hashed_at, content_measurement, notes) values
  (cd.id('hero-graphic'), cd.id('a'), 'social_post', 'Blog hero (illustrative)', 'upload', 'a/hero-graphic.png', 'image/png', 1730, 909, 2048,
   repeat('1', 64), now(), '{}', 'Generated / non-evidentiary visual.'),
  (cd.id('hero-photo'), cd.id('a'), 'photo', 'Crew on a roof', 'upload', 'a/hero-photo.jpg', 'image/jpeg', 1600, 900, 4096, repeat('2', 64), now(), '{}', null),
  (cd.id('hero-unhashed'), cd.id('a'), 'photo', 'Unhashed photo', 'upload', 'a/unhashed.jpg', 'image/jpeg', 1600, 900, 4096, null, null, null, null),
  (cd.id('hero-logo'), cd.id('a'), 'logo_primary', 'Logo', 'upload', 'a/logo.png', 'image/png', 400, 400, 512, repeat('3', 64), now(), '{}', null),
  (cd.id('hero-b'), cd.id('b'), 'social_post', 'Other client graphic', 'upload', 'b/graphic.png', 'image/png', 1200, 630, 1024, repeat('4', 64), now(), '{}', null);
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date) values
  (cd.id('i-hero'), cd.id('a'), date '2026-10-12', 'blog', null, 'educational', 'When to replace a roof', 'informational', cd.id('kw'), cd.id('svc'), null);
\o

-- ── The drafter ─────────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('hero', content_draft_request(cd.id('i-hero'))->>'draft_id');
select cd.ok('H0 a teammate cannot call the drafter''s hero write',
  cd.try(format('select content_draft_write_with_hero(%L::jsonb)',
    jsonb_set(cd.payload(cd.get('hero')::uuid, 320, array[cd.id('c-sourced')]), '{content,hero}',
      jsonb_build_object('asset_id', cd.id('hero-graphic'), 'alt', 'x')))) like '42501%');
\o
reset role;

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d uuid := cd.get('hero')::uuid; p jsonb := cd.payload(cd.get('hero')::uuid, 320, array[cd.id('c-sourced')]); e text; r jsonb;
begin
  e := cd.try(format('select content_draft_write_with_hero(%L::jsonb)',
    jsonb_set(p, '{content,hero}', jsonb_build_object('asset_id', cd.id('hero-b'), 'alt', 'Another client''s graphic'))));
  perform cd.ok('H1 another client''s asset is refused and nothing is written', e like '23%'
    and (select status = 'requested' and hero_asset_id is null and title is null from content_drafts where id = d), e);
  e := cd.try(format('select content_draft_write_with_hero(%L::jsonb)',
    jsonb_set(p, '{content,hero}', jsonb_build_object('asset_id', cd.id('hero-unhashed'), 'alt', 'A roof'))));
  perform cd.ok('H2 an unhashed file and a logo are refused',
    e like '23514%stored, hashed%'
    and cd.try(format('select content_draft_write_with_hero(%L::jsonb)',
      jsonb_set(p, '{content,hero}', jsonb_build_object('asset_id', cd.id('hero-logo'), 'alt', 'Logo')))) like '23514%photo or a social graphic%', e);
  r := content_draft_write_with_hero(jsonb_set(p, '{content,hero}',
    jsonb_build_object('asset_id', cd.id('hero-graphic'), 'alt', '  Homeowner reviewing a utility bill  ')));
  perform cd.ok('H3 the drafter''s hero and content land together, alt trimmed',
    (select status = 'in_review' and hero_asset_id = cd.id('hero-graphic') and hero_alt = 'Homeowner reviewing a utility bill'
            and version = (r->>'version')::int and title is not null from content_drafts where id = d));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── A teammate ──────────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare d content_drafts; v int; e text; a jsonb;
begin
  select * into d from content_drafts where id = cd.get('hero')::uuid;
  e := cd.try(format('update content_drafts set hero_alt = ''Changed'' where id = %L', d.id));
  perform cd.ok('H4 the hero of a draft in review is not changed in place', e like '23514%Withdraw%', e);
  update content_drafts set status = 'draft' where id = d.id;
  select version into v from content_drafts where id = d.id;
  e := cd.try(format('update content_drafts set hero_asset_id = %L where id = %L', cd.id('hero-b'), d.id));
  perform cd.ok('H5 a teammate cannot choose another client''s asset', e like '23%', e);
  perform cd.ok('H6 a hero needs alt text',
    cd.try(format('update content_drafts set hero_alt = '' '' where id = %L', d.id)) like '23%');
  update content_drafts set hero_asset_id = cd.id('hero-photo'), hero_alt = 'Crew replacing shingles' where id = d.id;
  perform cd.ok('H7 a hero change bumps the version by one',
    (select version = v + 1 and hero_asset_id = cd.id('hero-photo') from content_drafts where id = d.id));
  update content_drafts set status = 'in_review' where id = d.id;
  select * into d from content_drafts where id = d.id;
  perform cd.ok('H8 an approval of an older version is refused',
    cd.try(format('select content_draft_approve(%L, %s)', d.id, v)) like '40001%');

  perform content_draft_approve(d.id, d.version);
  select * into d from content_drafts where id = d.id;
  a := d.approved_snapshot->'hero';
  perform cd.ok('H9 approval pins the hero asset, its content hash and the alt text in the hashed snapshot',
    a->>'asset_id' = cd.id('hero-photo')::text and a->>'content_hash' = repeat('2', 64) and a->>'alt' = 'Crew replacing shingles'
    and (a->>'illustrative')::boolean = false and (a->>'width')::int = 1600
    and d.approved_hash = 'sha256:' || encode(sha256(convert_to(d.approved_snapshot::text, 'UTF8')), 'hex'));
  e := cd.try(format('update content_drafts set hero_asset_id = %L, hero_alt = ''x'' where id = %L', cd.id('hero-graphic'), d.id));
  perform cd.ok('H10 an approved draft''s hero is not changed in place', e like '23514%', e);

  update content_drafts set status = 'draft' where id = d.id;
  update content_drafts set hero_asset_id = cd.id('hero-graphic'), hero_alt = 'Homeowner reviewing a utility bill' where id = d.id;
  perform cd.ok('H11 reopening and changing the hero clears the approval',
    (select status = 'draft' and approved_hash is null and approved_snapshot is null and version > d.approved_version
       from content_drafts where id = d.id));
  update content_drafts set status = 'in_review' where id = d.id;
  select * into d from content_drafts where id = d.id;
  perform content_draft_approve(d.id, d.version);
  perform cd.ok('H11a the new approval carries the new hero, marked illustrative',
    (select approved_snapshot->'hero'->>'asset_id' = cd.id('hero-graphic')::text
            and (approved_snapshot->'hero'->>'illustrative')::boolean from content_drafts where id = d.id));

  update content_drafts set status = 'draft' where id = d.id;
  update content_drafts set hero_asset_id = null, hero_alt = null where id = d.id;
  update content_drafts set status = 'in_review' where id = d.id;
  select * into d from content_drafts where id = d.id;
  perform content_draft_approve(d.id, d.version);
  perform cd.ok('H12 a hero-less approval has no hero key',
    (select not (approved_snapshot ? 'hero') from content_drafts where id = d.id));

  -- Leave the draft approved WITH a hero for H13.
  update content_drafts set status = 'draft' where id = d.id;
  update content_drafts set hero_asset_id = cd.id('hero-graphic'), hero_alt = 'Homeowner reviewing a utility bill' where id = d.id;
  update content_drafts set status = 'in_review' where id = d.id;
  select * into d from content_drafts where id = d.id;
  perform content_draft_approve(d.id, d.version);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── A release re-checks the hero ────────────────────────────────────────────
\c - supabase_admin
\o /dev/null
select cd.save('h13-before', array_to_string(blog_publication_problems(d, d.approved_snapshot), ' '))
  from content_drafts d where id = cd.get('hero')::uuid;
update brand_assets set content_hash = repeat('5', 64) where id = cd.id('hero-graphic');
select cd.ok('H13 a release whose approved hero file changed is blocked',
  coalesce(cd.get('h13-before'), '') not like '%hero image%'
  and array_to_string(blog_publication_problems(d, d.approved_snapshot), ' ') like '%hero image changed%')
  from content_drafts d where id = cd.get('hero')::uuid;
update brand_assets set content_hash = repeat('1', 64) where id = cd.id('hero-graphic');
\o

-- ── The portal sees nothing ─────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'pa');
\o /dev/null
select cd.save('h14-seen', (select count(*) from content_drafts where id = cd.get('hero')::uuid)::text);
select cd.try(format('update content_drafts set hero_alt = ''Forged'' where id = %L', cd.get('hero')));
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
select cd.ok('H14 a portal user cannot read a draft or change its hero',
  cd.get('h14-seen') = '0' and (select hero_alt = 'Homeowner reviewing a utility bill' from content_drafts where id = cd.get('hero')::uuid));

\c - postgres
select status, count(*) from cd.results where name ~ '^H[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^H[0-9]' and status <> 'pass' order by n;
do $$ begin
  if exists (select 1 from cd.results where name ~ '^H[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^H[0-9]' and status = 'pass') <> 16 then
    raise exception 'Blog hero checks failed';
  end if;
end $$;
