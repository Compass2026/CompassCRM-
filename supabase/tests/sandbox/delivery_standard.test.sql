-- 20261015040000: the monthly delivery standard. Fictional clients only;
-- everything is rolled back. Fixtures are written with triggers off (they are
-- not under test); the standard's own guard is exercised with triggers on.
begin;
create schema ds_test;
create function ds_test.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ds_test.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
grant usage on schema ds_test to anon, authenticated;
grant execute on all functions in schema ds_test to anon, authenticated;
create function ds_test.v(c uuid, m date, unit text, d text, f text) returns int
language sql as $$ select case f when 'target' then x.target when 'completed' then x.completed when 'planned' then x.planned
  when 'used' then x.used else x.remaining end from delivery_targets(c, m) x where x.unit_name = unit and x.deliverable = d $$;

set local session_replication_role = replica;
-- M: three brand sites. S: a single-site client. L: not on a standard.
insert into clients (id, name, status) values
  ('00000000-0000-4000-d500-00000000000a', 'DS Multi', 'active'),
  ('00000000-0000-4000-d500-00000000000b', 'DS Single', 'launching'),
  ('00000000-0000-4000-d500-00000000000c', 'DS Legacy', 'active');
insert into services (id, client_id, name) values
  ('00000000-0000-4000-d501-00000000000a', '00000000-0000-4000-d500-00000000000a', 'Service A'),
  ('00000000-0000-4000-d501-00000000000b', '00000000-0000-4000-d500-00000000000a', 'Service B'),
  ('00000000-0000-4000-d501-00000000000c', '00000000-0000-4000-d500-00000000000a', 'Service C'),
  ('00000000-0000-4000-d501-00000000000d', '00000000-0000-4000-d500-00000000000b', 'Service S');
insert into keywords (id, client_id, keyword, service_id) values
  ('00000000-0000-4000-d502-00000000000a', '00000000-0000-4000-d500-00000000000a', 'kw a', '00000000-0000-4000-d501-00000000000a'),
  ('00000000-0000-4000-d502-00000000000b', '00000000-0000-4000-d500-00000000000a', 'kw b', '00000000-0000-4000-d501-00000000000b'),
  ('00000000-0000-4000-d502-00000000000c', '00000000-0000-4000-d500-00000000000a', 'kw c', '00000000-0000-4000-d501-00000000000c'),
  ('00000000-0000-4000-d502-00000000000d', '00000000-0000-4000-d500-00000000000b', 'kw s', '00000000-0000-4000-d501-00000000000d');
insert into sites (id, client_id, url) values ('00000000-0000-4000-d503-00000000000a', '00000000-0000-4000-d500-00000000000a', 'https://a.example.test');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, blog_site_id) values
  ('00000000-0000-4000-d504-00000000000a', '00000000-0000-4000-d500-00000000000a', 'a', 'Brand A', 'https://a.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000a']::uuid[], '00000000-0000-4000-d503-00000000000a'),
  ('00000000-0000-4000-d504-00000000000b', '00000000-0000-4000-d500-00000000000a', 'b', 'Brand B', 'https://b.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000b']::uuid[], null),
  ('00000000-0000-4000-d504-00000000000c', '00000000-0000-4000-d500-00000000000a', 'c', 'Brand C', 'https://c.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000c']::uuid[], null);

-- November 2026 (America/Chicago) work for M.
insert into content_posts (client_id, title, status, origin, keyword_id, published_at, due_date) values
  ('00000000-0000-4000-d500-00000000000a', 'A1', 'published', 'compass', '00000000-0000-4000-d502-00000000000a', '2026-11-02', null),
  ('00000000-0000-4000-d500-00000000000a', 'A2', 'published', 'compass', '00000000-0000-4000-d502-00000000000a', '2026-11-30', null),
  ('00000000-0000-4000-d500-00000000000a', 'B1', 'draft', 'compass', '00000000-0000-4000-d502-00000000000b', null, '2026-11-20'),
  ('00000000-0000-4000-d500-00000000000a', 'A-Oct', 'published', 'compass', '00000000-0000-4000-d502-00000000000a', '2026-10-31', null),
  ('00000000-0000-4000-d500-00000000000a', 'A-Dec', 'published', 'compass', '00000000-0000-4000-d502-00000000000a', '2026-12-01', null),
  ('00000000-0000-4000-d500-00000000000a', 'Inventory', 'published', 'site_inventory', '00000000-0000-4000-d502-00000000000a', '2026-11-03', null),
  ('00000000-0000-4000-d500-00000000000b', 'S1', 'published', 'compass', '00000000-0000-4000-d502-00000000000d', '2026-11-05', null);
-- Brand C: eight published, its month is full.
insert into content_posts (client_id, title, status, origin, keyword_id, published_at)
select '00000000-0000-4000-d500-00000000000a', 'C'||n, 'published', 'compass', '00000000-0000-4000-d502-00000000000c', '2026-11-10'
from generate_series(1, 8) n;

insert into social_posts (id, client_id, platform, search_intent, service_id, review_status, publish_status, created_at, scheduled_at,
  reviewed_by, reviewed_at, approved_snapshot, approved_hash, published_url, published_at, external_post_id, review_note) values
  -- facebook, brand A, published 23:30 Chicago on Nov 30 (Dec 1 in UTC): November
  ('00000000-0000-4000-d505-000000000001', '00000000-0000-4000-d500-00000000000a', 'facebook', 'informational', '00000000-0000-4000-d501-00000000000a',
   'approved', 'published', '2026-11-20', null, (select id from team_members limit 1), now(), '{}', 'h', 'https://fb.example.test/1',
   '2026-12-01 05:30+00', null, null),
  -- facebook, brand A, published 23:00 Chicago on Oct 31 (Nov 1 in UTC): October, not November
  ('00000000-0000-4000-d505-000000000002', '00000000-0000-4000-d500-00000000000a', 'facebook', 'informational', '00000000-0000-4000-d501-00000000000a',
   'approved', 'published', '2026-10-20', null, (select id from team_members limit 1), now(), '{}', 'h', 'https://fb.example.test/2',
   '2026-11-01 04:00+00', null, null),
  -- GBP, brand B, a draft created in November: planned
  ('00000000-0000-4000-d505-000000000003', '00000000-0000-4000-d500-00000000000a', 'google_business', 'informational', '00000000-0000-4000-d501-00000000000b',
   'draft', 'not_scheduled', '2026-11-12 15:00+00', null, null, null, null, null, null, null, null, null),
  -- GBP, brand C, rejected: not counted
  ('00000000-0000-4000-d505-000000000004', '00000000-0000-4000-d500-00000000000a', 'google_business', 'informational', '00000000-0000-4000-d501-00000000000c',
   'rejected', 'not_scheduled', '2026-11-12 15:00+00', null, (select id from team_members limit 1), now(), null, null, null, null, null, 'off brand'),
  -- Instagram, brand A: outside the standard
  ('00000000-0000-4000-d505-000000000005', '00000000-0000-4000-d500-00000000000a', 'instagram', 'informational', '00000000-0000-4000-d501-00000000000a',
   'draft', 'not_scheduled', '2026-11-12 15:00+00', null, null, null, null, null, null, null, null, null),
  -- facebook with no service: unattributed, never a brand's
  ('00000000-0000-4000-d505-000000000006', '00000000-0000-4000-d500-00000000000a', 'facebook', 'informational', null,
   'draft', 'not_scheduled', '2026-11-12 15:00+00', null, null, null, null, null, null, null, null, null);

insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, service_id, planned_date, social_post_id, hold, hold_reason) values
  -- unlinked blog slot, brand B: planned
  ('00000000-0000-4000-d506-000000000001', '00000000-0000-4000-d500-00000000000a', '2026-11-09', 'blog', null, 'educational', 'b slot', '00000000-0000-4000-d501-00000000000b', '2026-11-11', null, null, null),
  -- facebook slot linked to post 1: counted once, through the post
  ('00000000-0000-4000-d506-000000000002', '00000000-0000-4000-d500-00000000000a', '2026-11-16', 'social', 'facebook', 'educational', 'linked', '00000000-0000-4000-d501-00000000000a', null, '00000000-0000-4000-d505-000000000001', null, null),
  -- unlinked facebook slot, brand B, delivered by hand: completed
  ('00000000-0000-4000-d506-000000000003', '00000000-0000-4000-d500-00000000000a', '2026-11-16', 'social', 'facebook', 'educational', 'handmade', '00000000-0000-4000-d501-00000000000b', null, null, 'delivered', null),
  -- instagram slot: outside the standard
  ('00000000-0000-4000-d506-000000000004', '00000000-0000-4000-d500-00000000000a', '2026-11-16', 'social', 'instagram', 'educational', 'ig', '00000000-0000-4000-d501-00000000000a', null, null, null, null),
  -- web page slot: new page or refresh is not known, not counted
  ('00000000-0000-4000-d506-000000000005', '00000000-0000-4000-d500-00000000000a', '2026-11-16', 'web_page', null, 'service', 'page', '00000000-0000-4000-d501-00000000000a', null, null, null, null),
  -- blog slot whose generated draft already produced a post: counted through the post
  ('00000000-0000-4000-d506-000000000006', '00000000-0000-4000-d500-00000000000a', '2026-11-16', 'blog', null, 'educational', 'generated', '00000000-0000-4000-d501-00000000000a', null, null, null, null),
  -- December slot (week of Nov 30, dated Dec 2): December
  ('00000000-0000-4000-d506-000000000007', '00000000-0000-4000-d500-00000000000a', '2026-11-30', 'blog', null, 'educational', 'dec', '00000000-0000-4000-d501-00000000000a', '2026-12-02', null, null, null);
insert into content_drafts (client_id, deliverable, topic, plan_item_id, final_content_post_id, service_id)
values ('00000000-0000-4000-d500-00000000000a', 'blog', 'generated', '00000000-0000-4000-d506-000000000006',
  (select id from content_posts where title = 'A2'), '00000000-0000-4000-d501-00000000000a');

insert into change_log (client_id, change_type, object_type, object_id, status, created_at) values
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'approved', '2026-11-04 15:00+00'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'vetoed', '2026-11-04 15:00+00'),
  ('00000000-0000-4000-d500-00000000000a', 'page_added', 'site', '00000000-0000-4000-d503-00000000000a', 'approved', '2026-11-04 15:00+00');
set local session_replication_role = origin;

-- Adoption from November, as the proposed data script does (rerun-safe).
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, (select id from delivery_standards where version = 1), '2026-11-01', 'test'
from unnest(array['00000000-0000-4000-d500-00000000000a', '00000000-0000-4000-d500-00000000000b']::uuid[]) c
on conflict (client_id, effective_month) do nothing;
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, (select id from delivery_standards where version = 1), '2026-11-01', 'test'
from unnest(array['00000000-0000-4000-d500-00000000000a', '00000000-0000-4000-d500-00000000000b']::uuid[]) c
on conflict (client_id, effective_month) do nothing;

do $$
declare m constant uuid := '00000000-0000-4000-d500-00000000000a'; s constant uuid := '00000000-0000-4000-d500-00000000000b';
  l constant uuid := '00000000-0000-4000-d500-00000000000c'; nov constant date := '2026-11-17';
begin
  perform ds_test.ok('DS1 standard 1 is Tom''s decision: 8 / 8 / 8 / 1, Instagram and new pages excluded',
    (select blog_posts = 8 and facebook_posts = 8 and gbp_posts = 8 and page_refreshes = 1
       and exclusions @> array['instagram', 'new_pages'] and source_ref like '%7251fd3a-1326-4a79-81c0-1b13afa69c0c%'
     from delivery_standards where version = 1));
  perform ds_test.ok('DS2 adoption is idempotent', (select count(*) from client_delivery_standards where source_ref = 'test') = 2);
  perform ds_test.ok('DS3 each brand site gets the full standard; unattributed has none',
    (select bool_and(target = case deliverable when 'page_refreshes' then 1 else 8 end)
     from delivery_targets(m, nov) where unit_kind = 'brand')
    and (select count(distinct unit_name) from delivery_targets(m, nov) where unit_kind = 'brand') = 3
    and (select sum(target) from delivery_targets(m, nov) where deliverable = 'blog_posts') = 24
    and (select sum(target) from delivery_targets(m, nov) where deliverable = 'facebook_posts') = 24
    and (select sum(target) from delivery_targets(m, nov) where deliverable = 'gbp_posts') = 24
    and (select sum(target) from delivery_targets(m, nov) where deliverable = 'page_refreshes') = 3
    and (select bool_and(target = 0) from delivery_targets(m, nov) where unit_kind = 'unattributed'));
  perform ds_test.ok('DS4 a single-site client is one unit with no unattributed row',
    (select count(*) from delivery_targets(s, nov)) = 4
    and (select bool_and(unit_kind = 'client') from delivery_targets(s, nov))
    and ds_test.v(s, nov, 'DS Single', 'blog_posts', 'completed') = 1);
  perform ds_test.ok('DS5 blogs: published in the month, brand by keyword; site inventory and other months excluded; generated slot counted once',
    ds_test.v(m, nov, 'Brand A', 'blog_posts', 'completed') = 2 and ds_test.v(m, nov, 'Brand A', 'blog_posts', 'planned') = 0
    and ds_test.v(m, nov, 'Brand C', 'blog_posts', 'completed') = 8 and ds_test.v(m, nov, 'Brand C', 'blog_posts', 'remaining') = 0);
  perform ds_test.ok('DS6 blogs: a due draft and an unlinked slot are planned for their brand',
    ds_test.v(m, nov, 'Brand B', 'blog_posts', 'planned') = 2 and ds_test.v(m, nov, 'Brand B', 'blog_posts', 'completed') = 0);
  perform ds_test.ok('DS7 Facebook: month on the Chicago calendar, linked slot counted once, delivered slot completed, Instagram ignored',
    ds_test.v(m, nov, 'Brand A', 'facebook_posts', 'completed') = 1 and ds_test.v(m, nov, 'Brand A', 'facebook_posts', 'planned') = 0
    and ds_test.v(m, nov, 'Brand B', 'facebook_posts', 'completed') = 1
    and ds_test.v(m, nov, 'Unattributed', 'facebook_posts', 'planned') = 1);
  perform ds_test.ok('DS8 GBP on the shared profile: counted once for the brand of its service; rejected excluded',
    ds_test.v(m, nov, 'Brand B', 'gbp_posts', 'planned') = 1
    and (select sum(used) from delivery_targets(m, nov) where deliverable = 'gbp_posts') = 1);
  perform ds_test.ok('DS9 refreshes: page_rewrite by site; vetoed and new pages excluded',
    ds_test.v(m, nov, 'Brand A', 'page_refreshes', 'completed') = 1
    and (select sum(used) from delivery_targets(m, nov) where deliverable = 'page_refreshes') = 1);
  perform ds_test.ok('DS10 no backfill: October has no standard rows; a client without adoption has none',
    not exists (select 1 from delivery_targets(m, '2026-10-15'))
    and not exists (select 1 from delivery_targets(l, nov)));
  perform ds_test.ok('DS11 rereads are stable', (select count(*) from delivery_targets(m, nov)) = 16
    and (select array_agg(used order by unit_name, deliverable) from delivery_targets(m, nov))
      = (select array_agg(used order by unit_name, deliverable) from delivery_targets(m, nov)));
  perform ds_test.ok('DS12 Brand C is full; Brand A has room; an unattributed draft has none',
    not blog_publication_has_room(m, '00000000-0000-4000-d501-00000000000c', nov)
    and blog_publication_has_room(m, '00000000-0000-4000-d501-00000000000a', nov)
    and not blog_publication_has_room(m, null, nov));
  perform ds_test.ok('DS13 a client without a standard keeps the agreement allowance check unchanged',
    blog_publication_has_room(l, null) = exists(select 1 from client_quota_usage(l) q where q.service_key = 'blog_posts'
      and q.allocation > q.completed + (select count(*) from blog_publications x where x.client_id = l and x.status in ('publishing', 'uncertain'))));
  perform ds_test.ok('DS14 history is append-only',
    ds_test.err('update delivery_standards set blog_posts = 9') = '23514'
    and ds_test.err('delete from client_delivery_standards') = '23514'
    and ds_test.err($q$insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
      select '00000000-0000-4000-d500-00000000000a', id, '2026-11-15', 'mid-month' from delivery_standards where version = 1$q$) = '23514');
  perform ds_test.ok('DS15 the standard never touches agreement entitlements',
    not exists (select 1 from pg_proc p where p.proname in ('delivery_targets', 'client_delivery_standard', 'blog_publication_has_room')
      and regexp_replace(pg_get_functiondef(p.oid), 'client_quota_usage[^;]*;', '', 'g')
          ~ '(entitlement|package|\mplans\M|agreement|stripe|subscription|invoice)'));
end $$;

-- Permission boundary: anon cannot call it; a signed-in stranger sees nothing.
set local role anon;
do $$ begin perform ds_test.ok('DS16 anon is refused', ds_test.err($q$select * from delivery_targets()$q$) = '42501'); end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-d5ff-000000000001', true);
do $$ begin perform ds_test.ok('DS17 a non-team sign-in sees no standard or targets',
  not exists (select 1 from delivery_standards) and not exists (select 1 from delivery_targets(null, '2026-11-17'))); end $$;
reset role;
rollback;
