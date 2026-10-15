-- 20261015150000: the monthly delivery standard. Fictional clients only;
-- everything is rolled back. Fixtures are written with triggers off (they are
-- not under test); the standard's own guard is exercised with triggers on.
begin;
create schema ds_test;
create function ds_test.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ds_test.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function ds_test.why(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ds_test.v(c uuid, m date, unit text, d text, f text) returns int
language sql as $$ select case f when 'target' then x.target when 'completed' then x.completed when 'planned' then x.planned
  when 'used' then x.used when 'unverified' then x.unverified else x.remaining end from delivery_targets(c, m) x where x.unit_name = unit and x.deliverable = d $$;
grant usage on schema ds_test to anon, authenticated, service_role;
grant execute on all functions in schema ds_test to anon, authenticated, service_role;

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
insert into sites (id, client_id, url) values
  ('00000000-0000-4000-d503-00000000000a', '00000000-0000-4000-d500-00000000000a', 'https://a.example.test'),
  ('00000000-0000-4000-d503-00000000000b', '00000000-0000-4000-d500-00000000000a', 'https://b.example.test'),
  ('00000000-0000-4000-d503-00000000000c', '00000000-0000-4000-d500-00000000000a', 'https://c.example.test');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, blog_site_id) values
  ('00000000-0000-4000-d504-00000000000a', '00000000-0000-4000-d500-00000000000a', 'a', 'Brand A', 'https://a.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000a']::uuid[], '00000000-0000-4000-d503-00000000000a'),
  ('00000000-0000-4000-d504-00000000000b', '00000000-0000-4000-d500-00000000000a', 'b', 'Brand B', 'https://b.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000b']::uuid[], '00000000-0000-4000-d503-00000000000b'),
  ('00000000-0000-4000-d504-00000000000c', '00000000-0000-4000-d500-00000000000a', 'c', 'Brand C', 'https://c.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000c']::uuid[], '00000000-0000-4000-d503-00000000000c');

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

-- Refreshes. A: a live receipt recorded twice (one refresh) and a refresh
-- slot for it; vetoed, proposed and new pages beside it. B: approved with no
-- receipt, and approved with a failed check. C: approved in October, its live
-- check on November 2; and a November receipt later reverted.
insert into change_log (client_id, change_type, object_type, object_id, status, created_at, after) values
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'approved', '2026-11-04 15:00+00',
   '{"url": "/services/a", "commit": "https://github.example/x/commit/abc1234", "verified_at": "2026-11-04T15:05:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'approved', '2026-11-04 15:06+00',
   '{"url": "/services/A", "commit": "https://github.example/x/commit/abc1234", "verified_at": "2026-11-04T15:06:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'vetoed', '2026-11-04 15:00+00',
   '{"url": "/x", "commit": "x1", "verified_at": "2026-11-04T15:05:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000a', 'proposed', '2026-11-04 15:00+00', '{"url": "/y"}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_added', 'site', '00000000-0000-4000-d503-00000000000a', 'approved', '2026-11-04 15:00+00',
   '{"url": "/new", "commit": "n1", "verified_at": "2026-11-04T15:05:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000b', 'approved', '2026-11-06 15:00+00',
   '{"url": "/b", "commit": "bbb1111"}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000b', 'approved', '2026-11-07 15:00+00',
   '{"url": "/b2", "commit": "bbb2222", "verified_at": "2026-11-07T15:05:00Z", "http_status": 500}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000c', 'approved', '2026-10-20 15:00+00',
   '{"url": "/c", "commit": "ccc1111", "verified_at": "2026-11-02T16:00:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'page_rewrite', 'site', '00000000-0000-4000-d503-00000000000c', 'approved', '2026-11-10 15:00+00',
   '{"url": "/c2", "commit": "https://github.example/x/commit/def5678", "verified_at": "2026-11-10T15:05:00Z", "http_status": 200}'),
  ('00000000-0000-4000-d500-00000000000a', 'revert', 'site', null, 'approved', '2026-11-10 16:00+00',
   '{"commit": "https://github.example/x/commit/rev0001", "reverted": "def5678"}');
insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, service_id, planned_date, standard_key, standard_month) values
  ('00000000-0000-4000-d500-00000000000a', '2026-11-02', 'web_page', 'service', 'refresh a', '00000000-0000-4000-d501-00000000000a',
   '2026-11-05', 'page_refreshes', '2026-11-01');
set local session_replication_role = origin;

-- Adoption from October, as the proposed data script does (rerun-safe).
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, (select id from delivery_standards where version = 1), '2026-10-01', 'test'
from unnest(array['00000000-0000-4000-d500-00000000000a', '00000000-0000-4000-d500-00000000000b']::uuid[]) c
on conflict (client_id, effective_month) do nothing;
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, (select id from delivery_standards where version = 1), '2026-10-01', 'test'
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
  perform ds_test.ok('DS9a refresh: a live receipt recorded twice counts once, and its slot is not counted again',
    ds_test.v(m, nov, 'Brand A', 'page_refreshes', 'completed') = 1 and ds_test.v(m, nov, 'Brand A', 'page_refreshes', 'planned') = 0
    and ds_test.v(m, nov, 'Brand A', 'page_refreshes', 'unverified') = 0);
  perform ds_test.ok('DS9b refresh: approval without a receipt, and a failed check, stay planned and unverified',
    ds_test.v(m, nov, 'Brand B', 'page_refreshes', 'completed') = 0 and ds_test.v(m, nov, 'Brand B', 'page_refreshes', 'planned') = 2
    and ds_test.v(m, nov, 'Brand B', 'page_refreshes', 'unverified') = 2);
  perform ds_test.ok('DS9c refresh: counted in the month of its live check, not its approval; a reverted receipt is not done',
    ds_test.v(m, nov, 'Brand C', 'page_refreshes', 'completed') = 1 and ds_test.v(m, nov, 'Brand C', 'page_refreshes', 'unverified') = 1
    and ds_test.v(m, '2026-10-15', 'Brand C', 'page_refreshes', 'used') = 0);
  perform ds_test.ok('DS9d refresh: vetoed, proposed and new pages are not counted',
    (select sum(used) from delivery_targets(m, nov) where deliverable = 'page_refreshes') = 5);
  perform ds_test.ok('DS10 October adoption counts October work in October, with no proration; a client without adoption has none',
    ds_test.v(m, '2026-10-15', 'Brand A', 'blog_posts', 'completed') = 1 and ds_test.v(m, '2026-10-15', 'Brand A', 'blog_posts', 'target') = 8
    and ds_test.v(m, '2026-10-15', 'Brand A', 'facebook_posts', 'completed') = 1
    and not exists (select 1 from delivery_targets(m, '2026-09-15'))
    and not exists (select 1 from delivery_targets(l, nov)));
  perform ds_test.ok('DS10b destinations come only from verified bindings',
    (select bool_and(destination is null) from delivery_targets(m, nov) where deliverable in ('gbp_posts', 'facebook_posts')));
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

-- ── Planning (months relative to today, so the run date never matters) ──────
-- P: two brand sites; P1 has a verified Facebook Page, P2 none; the client
-- has one verified Business Profile location.
set local session_replication_role = replica;
insert into clients (id, name, status) values ('00000000-0000-4000-d500-00000000000d', 'DS Plan', 'active');
insert into services (id, client_id, name) values
  ('00000000-0000-4000-d501-00000000000e', '00000000-0000-4000-d500-00000000000d', 'Service P1'),
  ('00000000-0000-4000-d501-00000000000f', '00000000-0000-4000-d500-00000000000d', 'Service P2');
insert into keywords (id, client_id, keyword, service_id, is_active) values
  ('00000000-0000-4000-d502-00000000000e', '00000000-0000-4000-d500-00000000000d', 'kw p1', '00000000-0000-4000-d501-00000000000e', true),
  ('00000000-0000-4000-d502-00000000000f', '00000000-0000-4000-d500-00000000000d', 'kw p2', '00000000-0000-4000-d501-00000000000f', true);
insert into social_accounts (id, client_id, platform, display_name, publish_account_name, publish_verified_at) values
  ('00000000-0000-4000-d507-000000000001', '00000000-0000-4000-d500-00000000000d', 'facebook', 'P1 Page', 'P1 Page', now()),
  ('00000000-0000-4000-d507-000000000002', '00000000-0000-4000-d500-00000000000d', 'google_business', 'DS Plan GBP', 'DS Plan GBP', now());
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, facebook_account_id) values
  ('00000000-0000-4000-d504-00000000000d', '00000000-0000-4000-d500-00000000000d', 'p1', 'P1', 'https://p1.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000e']::uuid[], '00000000-0000-4000-d507-000000000001'),
  ('00000000-0000-4000-d504-00000000000e', '00000000-0000-4000-d500-00000000000d', 'p2', 'P2', 'https://p2.example.test', '5555555555',
   array['00000000-0000-4000-d501-00000000000f']::uuid[], null);
set local session_replication_role = origin;
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select '00000000-0000-4000-d500-00000000000d', id, (date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month')::date, 'test'
from delivery_standards where version = 1;
create function ds_test.nm(k int default 1) returns date language sql as
  $$ select (date_trunc('month', now() at time zone 'America/Chicago') + make_interval(months => k))::date $$;
-- One hand-planned P1 blog in next month, before planning: it is counted first.
insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, service_id, planned_date)
select '00000000-0000-4000-d500-00000000000d', d - (extract(isodow from d)::int - 1), 'blog', 'educational', 'hand blog',
  '00000000-0000-4000-d501-00000000000e', d
from (select min(x)::date d from generate_series(ds_test.nm(), ds_test.nm() + 6, interval '1 day') x where extract(isodow from x) < 6) y;

do $$
declare p constant uuid := '00000000-0000-4000-d500-00000000000d'; nm date := ds_test.nm();
  today date := (now() at time zone 'America/Chicago')::date; opened int; again int; moved uuid;
begin
  opened := plan_delivery_month(p, nm);
  perform ds_test.ok('PL1 next month opens every site''s missing slots, counting existing work first (2 × 25 − 1 hand slot)',
    opened = 49 and (select bool_and(remaining = 0 and planned = target) from delivery_targets(p, nm) where unit_kind = 'brand'));
  again := plan_delivery_month(p, nm);
  perform ds_test.ok('PL2 a rerun opens nothing',
    again = 0 and (select count(*) from content_plan_items where client_id = p and standard_month = nm and standard_seq is not null) = 49);
  perform ds_test.ok('PL3 slots are weekdays inside the month, on their own week, and no week takes more than its share (≤ 2 of 8)',
    (select bool_and(planned_date >= nm and planned_date < ds_test.nm(2) and extract(isodow from planned_date) < 6
                     and week_start = planned_date - (extract(isodow from planned_date)::int - 1))
     from content_plan_items where client_id = p and standard_seq is not null and standard_month = nm)
    and (select max(n) from (select count(*) n from content_plan_items where client_id = p and standard_month = nm
                             and standard_key in ('blog_posts', 'facebook_posts', 'gbp_posts')
                             group by brand_workspace_id, standard_key, week_start) w) <= 2);
  perform ds_test.ok('PL4 each site has its own allocation: P1 7 new blog slots + 1 hand, P2 8',
    (select count(*) from content_plan_items where client_id = p and standard_month = nm and standard_key = 'blog_posts'
       and brand_workspace_id = '00000000-0000-4000-d504-00000000000d' and standard_seq is not null) = 7
    and (select count(*) from content_plan_items where client_id = p and standard_month = nm and standard_key = 'blog_posts'
       and brand_workspace_id = '00000000-0000-4000-d504-00000000000e') = 8);
  perform ds_test.ok('PL5 Facebook only, one refresh per site per month, no Instagram',
    not exists (select 1 from content_plan_items where client_id = p and channel::text = 'instagram')
    and (select count(*) from content_plan_items where client_id = p and standard_month = nm and standard_key = 'facebook_posts' and channel::text = 'facebook') = 16
    and (select count(*) from content_plan_items where client_id = p and standard_month = nm and standard_key = 'page_refreshes' and deliverable = 'web_page') = 2);
  perform ds_test.ok('PL6 a site with no verified Facebook Page gets blocked slots with the reason; recorded destinations are named',
    (select bool_and(hold = 'blocked' and hold_reason like 'No verified Facebook Page for P2%') from content_plan_items
      where client_id = p and standard_month = nm and standard_key = 'facebook_posts' and brand_workspace_id = '00000000-0000-4000-d504-00000000000e')
    and (select bool_and(hold is null) from content_plan_items
      where client_id = p and standard_month = nm and standard_key in ('facebook_posts', 'gbp_posts') and brand_workspace_id = '00000000-0000-4000-d504-00000000000d')
    and (select bool_and(destination = 'DS Plan GBP') from delivery_targets(p, nm) where deliverable = 'gbp_posts' and unit_kind = 'brand')
    and (select destination from delivery_targets(p, nm) where deliverable = 'facebook_posts' and unit_name = 'P1') = 'P1 Page'
    and (select destination from delivery_targets(p, nm) where deliverable = 'facebook_posts' and unit_name = 'P2') is null);
  perform ds_test.ok('PL7 a past month is never planned; the current month is planned from today on, never backdated',
    plan_delivery_month(p, ds_test.nm(-1)) = 0
    and plan_delivery_month(p, ds_test.nm(0)) >= 0
    and (select coalesce(bool_and(planned_date >= today), true) from content_plan_items where client_id = p and standard_seq is not null and standard_month = ds_test.nm(0)));
  select id into moved from content_plan_items where client_id = p and standard_month = nm and standard_key = 'blog_posts' and standard_seq is not null limit 1;
  update content_plan_items set week_start = ds_test.nm(2) - (extract(isodow from ds_test.nm(2))::int - 1) + 7,
    planned_date = ds_test.nm(2) - (extract(isodow from ds_test.nm(2))::int - 1) + 7 where id = moved;
  perform ds_test.ok('PL8 a slot moved to another month counts there as a hand-planned slot',
    (select standard_month = date_trunc('month', planned_date)::date and standard_seq is null from content_plan_items where id = moved));
  perform ds_test.ok('PL9 a slot named for one brand cannot carry another brand''s service; a changed service moves the slot to its brand',
    ds_test.err(format($q$insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, service_id, brand_workspace_id, planned_date)
      values (%L, %L, 'blog', 'educational', 'x', %L, %L, %L)$q$, p, nm - (extract(isodow from nm)::int - 1) + 7,
      '00000000-0000-4000-d501-00000000000f', '00000000-0000-4000-d504-00000000000d', nm - (extract(isodow from nm)::int - 1) + 7)) = '23514'
    and ds_test.err(format('update content_plan_items set service_id = %L where id = %L', '00000000-0000-4000-d501-00000000000f', moved)) = 'accepted');
  perform ds_test.ok('PL9b the changed service moved the slot to its brand',
    (select brand_workspace_id from content_plan_items where id = moved) = '00000000-0000-4000-d504-00000000000e');
end $$;

-- The weekly beat: on the standard, one task per blog slot dated this week,
-- naming the slot; rerun-safe. Off the standard, unchanged.
insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, service_id, planned_date, standard_key)
select '00000000-0000-4000-d500-00000000000d', w, 'blog', 'educational', 'this week''s blog', '00000000-0000-4000-d501-00000000000e', w + 2, 'blog_posts'
from (select date_trunc('week', now() at time zone 'America/Chicago')::date w) x;
select create_weekly_blog_tasks();
do $$
declare p constant uuid := '00000000-0000-4000-d500-00000000000d'; w date := date_trunc('week', now() at time zone 'America/Chicago')::date;
  before int;
begin
  perform ds_test.ok('WK1 every open standard blog slot this week has one task naming it and its brand',
    (select bool_and(exists (select 1 from tasks t where t.client_id = p and t.key = 'blog_post' and t.due_date = i.planned_date
                              and t.notes like '%plan_item:' || i.id || '%' and t.title like 'Blog slot for P_:%'))
     from content_plan_items i where i.client_id = p and i.standard_key = 'blog_posts' and i.planned_date between w and w + 6
       and i.hold is null and i.content_post_id is null));
  select count(*) into before from tasks where client_id = p and key = 'blog_post';
  perform create_weekly_blog_tasks();
  perform ds_test.ok('WK2 a rerun opens no second task', (select count(*) from tasks where client_id = p and key = 'blog_post') = before);
  perform ds_test.ok('WK3 a client off the standard keeps the agreement path (nothing agreed → skipped as not_in_agreement, no task)',
    exists (select 1 from automation_entitlement_log where client_id = '00000000-0000-4000-d500-00000000000c' and decision = 'skipped'
            and reason = 'not_in_agreement')
    and not exists (select 1 from tasks where client_id = '00000000-0000-4000-d500-00000000000c' and key = 'blog_post'));
end $$;

-- The weekly draft fills the slot its task names, and refuses another brand's service for it.
select set_config('ds_test.task', (select t.id::text from tasks t join content_plan_items i on t.notes like '%plan_item:' || i.id || '%'
  where t.client_id = '00000000-0000-4000-d500-00000000000d' and t.key = 'blog_post'
    and i.brand_workspace_id = '00000000-0000-4000-d504-00000000000d' order by t.due_date, t.id limit 1), true);
set local session authorization authenticator;
set local role service_role;
do $$
declare t uuid := current_setting('ds_test.task')::uuid; slot uuid; r jsonb;
begin
  slot := substring((select notes from tasks where id = t) from 'plan_item:([0-9a-f-]{36})')::uuid;
  perform ds_test.ok('WK4 a draft for another brand''s service is refused for the named slot',
    ds_test.err(format('select content_draft_open_weekly(%L::jsonb)', jsonb_build_object('task_id', t, 'topic', 'Topic', 'search_intent', 'informational',
      'keyword_id', '00000000-0000-4000-d502-00000000000f', 'service_id', '00000000-0000-4000-d501-00000000000f'))) = '22023');
  r := content_draft_open_weekly(jsonb_build_object('task_id', t, 'topic', 'Topic', 'search_intent', 'informational',
      'keyword_id', '00000000-0000-4000-d502-00000000000e', 'service_id', '00000000-0000-4000-d501-00000000000e'));
  perform ds_test.ok('WK5 the brand''s own service fills the named slot', (r->>'plan_item_id')::uuid = slot);
end $$;
reset role;
reset session authorization;

-- ── Queueing never skips a slot (fixed dates; October 2026 starts on a Thursday) ──
-- Q: one site. Weekly runs are simulated by queue_standard_blog_tasks(Q, Sunday).
set local session_replication_role = replica;
insert into clients (id, name, status) values ('00000000-0000-4000-d500-00000000000e', 'DS Queue', 'active');
insert into services (id, client_id, name) values ('00000000-0000-4000-d501-000000000010', '00000000-0000-4000-d500-00000000000e', 'Service Q');
insert into keywords (id, client_id, keyword, service_id, is_active) values
  ('00000000-0000-4000-d502-000000000010', '00000000-0000-4000-d500-00000000000e', 'kw q', '00000000-0000-4000-d501-000000000010', true);
insert into content_posts (id, client_id, title, status, origin, keyword_id) values
  ('00000000-0000-4000-d508-000000000001', '00000000-0000-4000-d500-00000000000e', 'linked', 'draft', 'compass', '00000000-0000-4000-d502-000000000010');
set local session_replication_role = origin;
create function ds_test.slot(id uuid, d date, hold text default null) returns void language sql as $$
  insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, service_id, planned_date, standard_key, hold, hold_reason)
  values (id, '00000000-0000-4000-d500-00000000000e', d - (extract(isodow from d)::int - 1), 'blog', 'educational', 'q slot',
          '00000000-0000-4000-d501-000000000010', d, 'blog_posts', hold, case when hold = 'blocked' then 'waiting on photos' end) $$;
create function ds_test.task_for(slot uuid) returns uuid language sql as
  $$ select id from tasks where client_id = '00000000-0000-4000-d500-00000000000e' and key = 'blog_post' and notes like '%plan_item:' || slot || '%' $$;
-- Opened on Thu Oct 1, after the Wed Sep 30 run: the month's first two days.
select ds_test.slot('00000000-0000-4000-d509-000000000001', '2026-10-01');
select ds_test.slot('00000000-0000-4000-d509-000000000002', '2026-10-02');
select ds_test.slot('00000000-0000-4000-d509-000000000006', '2026-10-06', 'blocked');
do $$
declare n int;
begin
  n := queue_standard_blog_tasks('00000000-0000-4000-d500-00000000000e', '2026-10-11');   -- Wed Oct 7 run
  perform ds_test.ok('QU1 a month that starts after Wednesday: Oct 1 and 2 are queued on the next run, due on their own dates, still October slots',
    n = 2 and (select due_date from tasks where id = ds_test.task_for('00000000-0000-4000-d509-000000000001')) = '2026-10-01'
    and (select due_date from tasks where id = ds_test.task_for('00000000-0000-4000-d509-000000000002')) = '2026-10-02'
    and (select bool_and(standard_month = '2026-10-01' and planned_date in ('2026-10-01', '2026-10-02')) from content_plan_items
         where id in ('00000000-0000-4000-d509-000000000001', '00000000-0000-4000-d509-000000000002'))
    and ds_test.task_for('00000000-0000-4000-d509-000000000006') is null);
end $$;
-- The blocked Oct 6 slot is released after its week.
update content_plan_items set hold = null, hold_reason = null where id = '00000000-0000-4000-d509-000000000006';
do $$
declare n int;
begin
  n := queue_standard_blog_tasks('00000000-0000-4000-d500-00000000000e', '2026-10-18');   -- Wed Oct 14 run
  perform ds_test.ok('QU2 a slot unblocked after its week is queued, due on its own date',
    n = 1 and (select due_date from tasks where id = ds_test.task_for('00000000-0000-4000-d509-000000000006')) = '2026-10-06');
end $$;
-- Opened on Thu Oct 15, after the Wed Oct 14 run (the reviewer's case), plus
-- a delivered slot and one that already has a draft.
select ds_test.slot('00000000-0000-4000-d509-000000000016', '2026-10-16');
select ds_test.slot('00000000-0000-4000-d509-000000000020', '2026-10-20');
select ds_test.slot('00000000-0000-4000-d509-000000000022', '2026-10-22');
select ds_test.slot('00000000-0000-4000-d509-000000000021', '2026-10-21', 'delivered');
select ds_test.slot('00000000-0000-4000-d509-000000000023', '2026-10-23');
set local session_replication_role = replica;
insert into content_drafts (client_id, deliverable, topic, plan_item_id) values
  ('00000000-0000-4000-d500-00000000000e', 'blog', 'drafted already', '00000000-0000-4000-d509-000000000023');
set local session_replication_role = origin;
do $$
declare n int; again int;
begin
  n := queue_standard_blog_tasks('00000000-0000-4000-d500-00000000000e', '2026-10-25');   -- Wed Oct 21 run
  perform ds_test.ok('QU3 a slot opened after the weekly run (Fri Oct 16) is queued next run, not skipped; this week''s slots too',
    n = 3 and ds_test.task_for('00000000-0000-4000-d509-000000000016') is not null
    and ds_test.task_for('00000000-0000-4000-d509-000000000020') is not null and ds_test.task_for('00000000-0000-4000-d509-000000000022') is not null);
  perform ds_test.ok('QU4 delivered and already-drafted slots get no task',
    ds_test.task_for('00000000-0000-4000-d509-000000000021') is null and ds_test.task_for('00000000-0000-4000-d509-000000000023') is null);
  again := queue_standard_blog_tasks('00000000-0000-4000-d500-00000000000e', '2026-10-25');
  perform ds_test.ok('QU5 reruns add nothing: one task per slot',
    again = 0 and (select count(*) from tasks where client_id = '00000000-0000-4000-d500-00000000000e' and key = 'blog_post') = 6
    and (select count(distinct notes) from tasks where client_id = '00000000-0000-4000-d500-00000000000e' and key = 'blog_post') = 6);
end $$;

-- ── A named slot is used or refused, never substituted ──────────────────────
-- Tasks naming: a blocked slot, a delivered slot, a slot linked to a post, a
-- deleted slot, a slot already drafted (Oct 23), and two tasks naming one
-- free slot (Oct 20 has its task; a second task names it too).
select ds_test.slot('00000000-0000-4000-d509-000000000030', '2026-10-26', 'blocked');
select ds_test.slot('00000000-0000-4000-d509-000000000031', '2026-10-27', 'delivered');
select ds_test.slot('00000000-0000-4000-d509-000000000032', '2026-10-28');
update content_plan_items set content_post_id = '00000000-0000-4000-d508-000000000001' where id = '00000000-0000-4000-d509-000000000032';
select ds_test.slot('00000000-0000-4000-d509-000000000033', '2026-10-29');
insert into tasks (id, client_id, title, owner, status, key, due_date, notes)
select ('00000000-0000-4000-d50a-0000000000' || x.n)::uuid, '00000000-0000-4000-d500-00000000000e', 'named', 'CLAUDE', 'open', 'blog_post', '2026-10-26',
       'plan_item:' || x.slot
from (values ('30', '00000000-0000-4000-d509-000000000030'), ('31', '00000000-0000-4000-d509-000000000031'),
             ('32', '00000000-0000-4000-d509-000000000032'), ('33', '00000000-0000-4000-d509-000000000033'),
             ('23', '00000000-0000-4000-d509-000000000023'), ('20', '00000000-0000-4000-d509-000000000020')) x(n, slot);
delete from content_plan_items where id = '00000000-0000-4000-d509-000000000033';
select set_config('ds_test.drafts', (select count(*)::text from content_drafts where client_id = '00000000-0000-4000-d500-00000000000e'), true);
select set_config('ds_test.items', (select count(*)::text from content_plan_items where client_id = '00000000-0000-4000-d500-00000000000e'), true);
set local session authorization authenticator;
set local role service_role;
create temp table ds_open_result (label text, outcome text) on commit drop;
do $$
declare k text; r jsonb;
  args jsonb := jsonb_build_object('topic', 'Topic', 'search_intent', 'informational',
    'keyword_id', '00000000-0000-4000-d502-000000000010', 'service_id', '00000000-0000-4000-d501-000000000010');
begin
  foreach k in array array['30', '31', '32', '33', '23'] loop
    insert into ds_open_result values (k, ds_test.why(format('select content_draft_open_weekly(%L::jsonb)',
      args || jsonb_build_object('task_id', '00000000-0000-4000-d50a-0000000000' || k))));
  end loop;
  -- Two tasks for the Oct 20 slot: the slot's own task, then the second one.
  r := content_draft_open_weekly(args || jsonb_build_object('task_id', ds_test.task_for('00000000-0000-4000-d509-000000000020')));
  insert into ds_open_result values ('first', (r->>'plan_item_id'));
  insert into ds_open_result values ('second', ds_test.why(format('select content_draft_open_weekly(%L::jsonb)',
    args || jsonb_build_object('task_id', '00000000-0000-4000-d50a-000000000020'))));
end $$;
reset role;
reset session authorization;
do $$
begin
  perform ds_test.ok('NS1 blocked, delivered, linked, deleted and already-drafted named slots are each refused (22023) with their own reason',
    (select outcome from ds_open_result where label = '30') like '22023: %is blocked (waiting on photos)%'
    and (select outcome from ds_open_result where label = '31') like '22023: %already delivered or linked%'
    and (select outcome from ds_open_result where label = '32') like '22023: %already delivered or linked%'
    and (select outcome from ds_open_result where label = '33') like '22023: %no longer exists%'
    and (select outcome from ds_open_result where label = '23') like '22023: %already has a draft%');
  perform ds_test.ok('NS2 of two tasks naming one slot, the first fills it and the second is refused',
    (select outcome from ds_open_result where label = 'first') = '00000000-0000-4000-d509-000000000020'
    and (select outcome from ds_open_result where label = 'second') like '22023: %already has a draft%');
  perform ds_test.ok('NS3 refusals leave no extra draft or slot: one new draft in total, no new slot',
    (select count(*) from content_drafts where client_id = '00000000-0000-4000-d500-00000000000e') = current_setting('ds_test.drafts')::int + 1
    and (select count(*) from content_plan_items where client_id = '00000000-0000-4000-d500-00000000000e') = current_setting('ds_test.items')::int
    and (select count(*) from content_drafts where plan_item_id = '00000000-0000-4000-d509-000000000020') = 1);
end $$;

-- Permission boundary: anon cannot call it; a signed-in stranger sees nothing.
set local role anon;
do $$ begin perform ds_test.ok('DS16 anon is refused', ds_test.err($q$select * from delivery_targets()$q$) = '42501'
  and ds_test.err($q$select plan_delivery_month('00000000-0000-4000-d500-00000000000d')$q$) = '42501'); end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-d5ff-000000000001', true);
do $$ begin perform ds_test.ok('DS17 a non-team sign-in sees no standard or targets',
  not exists (select 1 from delivery_standards) and not exists (select 1 from delivery_targets(null, '2026-11-17'))
  and plan_delivery_month('00000000-0000-4000-d500-00000000000d', ds_test.nm()) = 0); end $$;
reset role;
rollback;
