-- 20261030180000: the weekly delivery standard. Fictional clients only;
-- everything is rolled back. "Today" is pinned with compass.delivery_today
-- (honoured for a superuser session only), so the suite does not depend on
-- the machine's date.
--   W1  single site, one GBP location, starts Mon Nov 2 2026; carries v1
--       November slots and two "pilot" posts published Oct 29 from Nov 3 slots
--   W2  single site, two GBP locations, start date Wed Nov 4 → first week Nov 9
--   W3  three brand sites sharing ONE GBP location (the multi-brand shape), starts Nov 2
--   W4  monthly standard only: must behave exactly as before
--   W5  single site, starts Nov 2, first planned on Wed Nov 4 (no catch-up)
--   W6  single site, starts Nov 2: the DST weeks
-- Q1–Q3 swap in a stand-in for social_slot_readiness inside a savepoint
-- (keyword eligibility is not under test there, the queue's horizon is).
begin;
create schema wd;
create function wd.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function wd.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function wd.id(k text) returns uuid language sql immutable as $$ select md5('wd:' || k)::uuid $$;
create function wd.today(d date) returns void language sql as $$ select set_config('compass.delivery_today', d::text, true) $$;
-- Weekly slots of a client / deliverable / week.
create function wd.slots(c text, dk text, w date) returns setof content_plan_items language sql as $$
  select * from content_plan_items where client_id = wd.id(c) and standard_key = dk and standard_week = w order by planned_date, id $$;
create function wd.m(c text, m date, unit text, dk text, f text) returns int language sql as $$
  select case f when 'target' then x.target when 'completed' then x.completed when 'planned' then x.planned
                when 'remaining' then x.remaining when 'version' then x.standard_version end
  from delivery_targets(wd.id(c), m) x where x.unit_name = unit and x.deliverable = dk $$;
create function wd.ready(c text, w date) returns table (id uuid, bid uuid, d date, loc uuid, reason text) language sql as $$
  select r.plan_item_id, r.brand_workspace_id, r.planned_date, r.social_account_id, coalesce(r.reason, 'ready')
  from social_slot_readiness(wd.id(c), w, w + 6) r where r.deliverable = 'gbp_posts' $$;
-- A write and the checks on it go in separate statements (a statement's
-- subqueries do not see what a function it calls wrote).
create table wd.r (k text primary key, v text);
create function wd.keep(k text, v anyelement) returns void language sql as $$
  insert into wd.r values (k, v::text) on conflict (k) do update set v = excluded.v $$;
create function wd.got(k text) returns text language sql as $$ select v from wd.r where r.k = got.k $$;
select wd.today('2026-10-30');

select wd.ok('M1 the migration adopts nobody, opens no slot, and records standard 2 as weekly (3 / 5 / 5, 1 refresh a month, 1 GBP post per location per day)',
  not exists (select 1 from client_weekly_delivery_standards)
  and not exists (select 1 from content_plan_items where standard_week is not null or retired_at is not null)
  and exists (select 1 from delivery_standards where version = 2 and cadence = 'weekly' and blog_posts = 3 and facebook_posts = 5
              and gbp_posts = 5 and page_refreshes = 1 and gbp_daily_location_cap = 1)
  and (select cadence from delivery_standards where version = 1) = 'monthly'
  and exists (select 1 from cron.job where jobname = 'delivery-standard-week' and schedule = '0 10 * * 1'
              and command = 'select public.plan_delivery_weeks()'));

-- ── Fixtures (triggers off: they are not under test) ────────────────────────
set local session_replication_role = replica;
insert into clients (id, name, status, website_url)
select wd.id(c), 'WD ' || c, s::client_status, 'https://' || lower(c) || '.example.test'
from (values ('W1', 'active'), ('W2', 'active'), ('W3', 'active'), ('W4', 'active'), ('W5', 'launching'), ('W6', 'active')) v(c, s);
insert into brand_boards (client_id, status, approved_on)
select wd.id(c), 'approved', now() from unnest(array['W1', 'W2', 'W4', 'W5', 'W6']) c;
insert into services (id, client_id, name, status, page_url)
select wd.id('s' || c), wd.id(case when c like 'W3%' then 'W3' else c end), 'Service ' || c, 'approved', 'https://' || lower(c) || '.example.test/service'
from unnest(array['W1', 'W2', 'W3a', 'W3b', 'W3c', 'W4', 'W5', 'W6']) c;
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id,
                             publish_page_id, publish_verified_at, publish_enabled)
select wd.id(k), wd.id(c), p::social_platform, k, ext, 'zernio', left(md5(k), 24), ext, now() - (n || ' minutes')::interval, false
from (values ('gb.W1', 'W1', 'google_business', 'locations/101', 1), ('fb.W1', 'W1', 'facebook', '91010', 1),
             ('gb.W2a', 'W2', 'google_business', 'locations/201', 2), ('gb.W2b', 'W2', 'google_business', 'locations/202', 1),
             ('gb.W3', 'W3', 'google_business', 'locations/301', 1), ('gb.W4', 'W4', 'google_business', 'locations/401', 1),
             ('gb.W5', 'W5', 'google_business', 'locations/501', 1), ('gb.W6', 'W6', 'google_business', 'locations/601', 1)) v(k, c, p, ext, n);
insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind)
select wd.id(c), 'zernio', 'publisher' from unnest(array['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) c;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at)
select wd.id(b), wd.id('W3'), lower(b), 'WD Site ' || b, 'https://' || lower(b) || '.example.test', '5555555555',
       array[wd.id('s' || b)], 'approved', (select id from team_members limit 1), now()
from unnest(array['W3a', 'W3b', 'W3c']) b;

-- W1's v1 November plan, as production has it, and the work attached to it.
insert into social_posts (id, client_id, platform, search_intent, service_id, review_status, publish_status, created_at, scheduled_at,
  reviewed_by, reviewed_at, approved_snapshot, approved_hash, published_url, published_at, social_account_id, external_post_id) values
  -- the pilots: published Oct 29 from Nov 3 slots
  (wd.id('p.fb'), wd.id('W1'), 'facebook', 'informational', wd.id('sW1'), 'approved', 'published', '2026-10-29 18:00+00',
   '2026-10-29 18:58+00', (select id from team_members limit 1), now(), '{}', 'h', 'https://fb.example.test/p1', '2026-10-29 19:00+00', wd.id('fb.W1'), null),
  (wd.id('p.gb'), wd.id('W1'), 'google_business', 'informational', wd.id('sW1'), 'approved', 'published', '2026-10-29 18:00+00',
   '2026-10-29 19:02+00', (select id from team_members limit 1), now(), '{}', 'h', 'https://gbp.example.test/p2', '2026-10-29 19:05+00', wd.id('gb.W1'), 'gbp-ext-1'),
  -- a draft in review on a Nov 12 slot
  (wd.id('p.review'), wd.id('W1'), 'facebook', 'informational', wd.id('sW1'), 'in_review', 'not_scheduled', '2026-10-28 15:00+00',
   null, null, null, null, null, null, null, wd.id('fb.W1'), null);
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, planned_date, social_post_id,
                                hold, hold_reason, standard_key, standard_month, standard_seq) values
  (wd.id('v1.fb.oct28'), wd.id('W1'), '2026-10-26', 'social', 'facebook', 'educational', 'v1 fb', '2026-10-28', null, null, null, 'facebook_posts', '2026-10-01', 7),
  (wd.id('v1.fb.nov3'), wd.id('W1'), '2026-11-02', 'social', 'facebook', 'educational', 'v1 fb', '2026-11-03', wd.id('p.fb'), null, null, 'facebook_posts', '2026-11-01', 1),
  (wd.id('v1.gb.nov3'), wd.id('W1'), '2026-11-02', 'gbp', 'google_business', 'service', 'v1 gbp', '2026-11-03', wd.id('p.gb'), null, null, 'gbp_posts', '2026-11-01', 1),
  (wd.id('v1.fb.nov5'), wd.id('W1'), '2026-11-02', 'social', 'facebook', 'educational', 'v1 fb', '2026-11-05', null, null, null, 'facebook_posts', '2026-11-01', 2),
  (wd.id('v1.fb.nov12'), wd.id('W1'), '2026-11-09', 'social', 'facebook', 'educational', 'v1 fb', '2026-11-12', wd.id('p.review'), null, null, 'facebook_posts', '2026-11-01', 3),
  (wd.id('v1.fb.nov17'), wd.id('W1'), '2026-11-16', 'social', 'facebook', 'educational', 'v1 fb', '2026-11-17', null, null, null, 'facebook_posts', '2026-11-01', 4),
  (wd.id('v1.gb.nov19'), wd.id('W1'), '2026-11-16', 'gbp', 'google_business', 'service', 'v1 gbp', '2026-11-19', null, 'delivered', null, 'gbp_posts', '2026-11-01', 2),
  (wd.id('v1.blog.nov4'), wd.id('W1'), '2026-11-02', 'blog', null, 'educational', 'v1 blog', '2026-11-04', null, 'blocked', 'Waiting on photos.', 'blog_posts', '2026-11-01', 1),
  (wd.id('v1.blog.nov6'), wd.id('W1'), '2026-11-02', 'blog', null, 'educational', 'v1 blog', '2026-11-06', null, null, null, 'blog_posts', '2026-11-01', 2),
  (wd.id('v1.ref.nov10'), wd.id('W1'), '2026-11-09', 'web_page', null, 'service', 'v1 refresh', '2026-11-10', null, null, null, 'page_refreshes', '2026-11-01', 1);
insert into content_drafts (client_id, plan_item_id, deliverable, topic) values (wd.id('W1'), wd.id('v1.blog.nov6'), 'blog', 'draft on a v1 slot');
insert into tasks (id, client_id, title, owner, status, key, due_date, notes)
values (wd.id('t.nov17'), wd.id('W1'), 'queued', 'CLAUDE', 'open', 'social_slot:' || wd.id('v1.fb.nov17'), '2026-11-17', 'plan_item:' || wd.id('v1.fb.nov17'));

-- W4 (monthly only): two GBP slots on one day at its one location.
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, planned_date, standard_key, standard_month, standard_seq)
values (wd.id('w4.a'), wd.id('W4'), '2026-11-09', 'gbp', 'google_business', 'service', 'w4 a', '2026-11-10', 'gbp_posts', '2026-11-01', 1),
       (wd.id('w4.b'), wd.id('W4'), '2026-11-09', 'gbp', 'google_business', 'service', 'w4 b', '2026-11-10', 'gbp_posts', '2026-11-01', 2);

-- W6: posts either side of local midnight on the DST weekends.
insert into social_posts (id, client_id, platform, search_intent, service_id, review_status, publish_status, created_at,
  reviewed_by, reviewed_at, approved_snapshot, approved_hash, published_url, published_at, social_account_id)
select wd.id(k), wd.id('W6'), 'facebook', 'informational', wd.id('sW6'), 'approved', 'published', ts - interval '1 day',
       (select id from team_members limit 1), now(), '{}', 'h', 'https://fb.example.test/' || k, ts, null
from (values ('dst.sun', timestamptz '2026-11-02 05:30+00'),   -- Sun Nov 1 23:30 CST
             ('dst.mon', timestamptz '2026-11-02 06:00+00'),   -- Mon Nov 2 00:00 CST
             ('dst.spring', timestamptz '2027-03-15 05:30+00') -- Mon Mar 15 00:30 CDT (Sun 23:30 if read as CST)
     ) v(k, ts);
set local session_replication_role = origin;

-- Monthly adoptions (v1), with the guards on.
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select wd.id(c), (select id from delivery_standards where version = 1), '2026-10-01', 'test'
from unnest(array['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) c;

-- ── Adoption ────────────────────────────────────────────────────────────────
create function wd.adopt(c text, start date) returns text language sql as $$
  select wd.err(format('insert into client_weekly_delivery_standards (client_id, standard_id, start_date, source_ref) values (%L, %L, %L, %L)',
                       wd.id(c), (select id from delivery_standards where version = 2), start, 'test')) $$;
select wd.ok('A1 the weekly start may not be in the past, names a weekly standard, needs the monthly adoption, and a monthly adoption cannot name the weekly standard',
  wd.adopt('W1', '2026-10-29') like '23514:%no retroactive%'
  and wd.err(format('insert into client_weekly_delivery_standards (client_id, standard_id, start_date, source_ref) values (%L, %L, %L, %L)',
                    wd.id('W1'), (select id from delivery_standards where version = 1), '2026-11-02', 'test')) like '23514:%weekly standard%'
  and wd.err(format('insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref) values (%L, %L, %L, %L)',
                    wd.id('W1'), (select id from delivery_standards where version = 2), '2026-12-01', 'test')) like '23514:%monthly standard%');
select wd.keep('a2.W2', wd.adopt('W2', '2026-11-04')), wd.keep('a2.W1', wd.adopt('W1', '2026-11-02'));
select wd.ok('A2 partial first week: a Wednesday start (Nov 4) takes effect the next Monday (Nov 9); a Monday start is that week',
  wd.got('a2.W2') = 'accepted' and wd.got('a2.W1') = 'accepted'
  and (select effective_week from client_weekly_delivery_standards where client_id = wd.id('W2')) = '2026-11-09'
  and (select effective_week from client_weekly_delivery_standards where client_id = wd.id('W1')) = '2026-11-02'
  and (client_weekly_delivery_standard(wd.id('W2'), '2026-11-08')).id is null
  and (client_weekly_delivery_standard(wd.id('W2'), '2026-11-09')).version = 2);
select wd.keep('a2b.' || c, wd.adopt(c, '2026-11-02')) from unnest(array['W3', 'W5', 'W6']) c;
select wd.ok('A2b W3, W5 and W6 start Monday Nov 2', (select bool_and(v = 'accepted') from wd.r where k like 'a2b.%')
  and (select count(*) from client_weekly_delivery_standards where effective_week = '2026-11-02') = 4);
select wd.ok('A3 adoptions are history: no update, no delete',
  wd.err(format('update client_weekly_delivery_standards set start_date = %L where client_id = %L', '2026-11-16', wd.id('W1'))) like '23514:%'
  and wd.err(format('delete from client_weekly_delivery_standards where client_id = %L', wd.id('W1'))) like '23514:%');

-- ── Reconciliation, read-only, before any planning ──────────────────────────
create temp table pre as select * from delivery_week_report(wd.id('W1'), '2026-10-26', '2026-11-30');
select wd.ok('R1 the report credits the Oct 29 pilots in the week of Oct 26 (before weekly, target 0), not in November',
  (select credited from pre where week_start = '2026-10-26' and deliverable = 'facebook_posts') = 1
  and (select credited from pre where week_start = '2026-10-26' and deliverable = 'gbp_posts') = 1
  and (select standard from pre where week_start = '2026-10-26' and deliverable = 'facebook_posts') = 'before weekly'
  and (select target from pre where week_start = '2026-10-26' and deliverable = 'facebook_posts') = 0
  and (select credited from pre where week_start = '2026-11-02' and deliverable = 'facebook_posts') = 0
  and (select credited from pre where week_start = '2026-11-02' and deliverable = 'gbp_posts') = 0);
select wd.ok('R2 the report lists the v1 slots the planner will retire (unattached, from the first weekly week) and keeps the rest',
  (select v1_retiring from pre where week_start = '2026-11-02' and deliverable = 'facebook_posts') = 1      -- Nov 5
  and (select v1_retiring from pre where week_start = '2026-11-02' and deliverable = 'blog_posts') = 1      -- Nov 4 (blocked)
  and (select open_slots from pre where week_start = '2026-11-02' and deliverable = 'blog_posts') = 1       -- Nov 6 has a draft
  and (select v1_retiring from pre where week_start = '2026-11-16' and deliverable = 'facebook_posts') = 0  -- Nov 17 has an open task
  and (select open_slots from pre where week_start = '2026-11-16' and deliverable = 'facebook_posts') = 1
  and (select credited from pre where week_start = '2026-11-16' and deliverable = 'gbp_posts') = 1         -- delivered
  and (select credited from pre where week_start = '2026-11-09' and deliverable = 'facebook_posts') = 1    -- in review
  and (select open_slots from pre where week_start = '2026-10-26' and deliverable = 'facebook_posts') = 1  -- Oct 28: before weekly, kept
  and (select sum(target) from pre where week_start = '2026-11-02') = 13
  and (select remaining from pre where week_start = '2026-11-02' and deliverable = 'blog_posts') = 2);
select wd.ok('R3 the report is read-only and a preview start week works for a client without a weekly adoption',
  not exists (select 1 from content_plan_items where retired_at is not null or standard_week is not null)
  and (select sum(target) from delivery_week_report(wd.id('W4'), '2026-11-09', '2026-11-09')) = 0
  and (select bool_and(standard = 'monthly') from delivery_week_report(wd.id('W4'), '2026-11-09', '2026-11-09'))
  and (select sum(target) from delivery_week_report(wd.id('W4'), '2026-11-09', '2026-11-09', '2026-11-04')) = 13
  and (select bool_and(standard = 'preview v2') from delivery_week_report(wd.id('W4'), '2026-11-09', '2026-11-09', '2026-11-04'))
  and (select sum(v1_retiring) from delivery_week_report(wd.id('W4'), '2026-11-09', '2026-11-09', '2026-11-04')) = 2);

-- ── Planning: a 5-week month, the month boundary, reconciliation ───────────
select wd.keep('p1', plan_delivery_month(wd.id('W1'), '2026-11-01'));
select wd.ok('P1 planning W1''s November opens its five weeks (Mondays Nov 2 – Nov 30): 25 Facebook slots minus the work already dated in them',
  wd.got('p1')::int = 61
  and (select array_agg(distinct standard_week order by standard_week) from content_plan_items where client_id = wd.id('W1') and standard_week is not null)
      = array['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']::date[]
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and standard_key = 'facebook_posts' and standard_week is not null) = 23
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and standard_key = 'gbp_posts' and standard_week is not null) = 24
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and standard_key = 'blog_posts' and standard_week is not null) = 14
  and not exists (select 1 from content_plan_items where client_id = wd.id('W1') and standard_key = 'page_refreshes' and standard_week is not null));
select wd.ok('P2 standard days: Facebook and GBP Mon–Fri, blogs Mon/Wed/Fri; a day that already has the work is skipped',
  (select array_agg(planned_date) from wd.slots('W1', 'facebook_posts', '2026-11-23')) = array['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']::date[]
  and (select array_agg(planned_date) from wd.slots('W1', 'blog_posts', '2026-11-23')) = array['2026-11-23', '2026-11-25', '2026-11-27']::date[]
  and (select array_agg(planned_date) from wd.slots('W1', 'blog_posts', '2026-11-02')) = array['2026-11-02', '2026-11-04']::date[]   -- Fri Nov 6 holds the drafted v1 slot
  and (select array_agg(planned_date) from wd.slots('W1', 'facebook_posts', '2026-11-09')) = array['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-13']::date[]  -- Thu has the post in review
  and (select count(*) from wd.slots('W1', 'gbp_posts', '2026-11-16')) = 4                                                         -- Thu is delivered
  and (select bool_and(gbp_location_id = wd.id('gb.W1')) from content_plan_items where client_id = wd.id('W1') and standard_key = 'gbp_posts' and standard_week is not null));
select wd.ok('P3 the pilots do not occupy November: week Nov 2 gets all 5 Facebook and 5 GBP slots; Oct gets the credit once',
  (select count(*) from wd.slots('W1', 'facebook_posts', '2026-11-02')) = 5
  and (select count(*) from wd.slots('W1', 'gbp_posts', '2026-11-02')) = 5
  and wd.m('W1', '2026-10-01', 'WD W1', 'facebook_posts', 'completed') = 1
  and wd.m('W1', '2026-11-01', 'WD W1', 'facebook_posts', 'completed') = 0
  and (select credited from delivery_week_report(wd.id('W1'), '2026-10-26', '2026-10-26') where deliverable = 'facebook_posts') = 1
  and (select credited from delivery_week_report(wd.id('W1'), '2026-11-02', '2026-11-02') where deliverable = 'facebook_posts') = 0);
select wd.ok('P4 v1 slots: unattached ones from the first weekly week are retired (blocked with a reason, previous hold kept); attached, delivered, tasked, earlier and refresh slots stay',
  (select retired_at is not null and hold = 'blocked' and hold_reason like 'Retired: superseded by weekly delivery standard v2%' and retired_hold is null
     from content_plan_items where id = wd.id('v1.fb.nov5'))
  and (select retired_at is not null and retired_hold = 'blocked' and retired_hold_reason = 'Waiting on photos.' from content_plan_items where id = wd.id('v1.blog.nov4'))
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and retired_at is not null) = 2
  and (select bool_and(retired_at is null) from content_plan_items where id in
        (wd.id('v1.fb.oct28'), wd.id('v1.fb.nov3'), wd.id('v1.gb.nov3'), wd.id('v1.fb.nov12'), wd.id('v1.fb.nov17'),
         wd.id('v1.gb.nov19'), wd.id('v1.blog.nov6'), wd.id('v1.ref.nov10')))
  and (select count(*) from content_plan_items where client_id = wd.id('W1')) = 10 + 61);
select wd.ok('P5 a week crossing the month (Nov 30) splits by date: Mon in November, Tue–Fri in December',
  (select array_agg(planned_date) from wd.slots('W1', 'facebook_posts', '2026-11-30')) = array['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']::date[]
  and (select array_agg(distinct standard_month order by standard_month) from wd.slots('W1', 'facebook_posts', '2026-11-30')) = array['2026-11-01', '2026-12-01']::date[]);
select wd.ok('P6 November''s targets are the sum of its days'' share of each week (Facebook 21, GBP 21, blogs 13, refresh 1, v2), met exactly; December carries the rest of the Nov 30 week',
  wd.m('W1', '2026-11-01', 'WD W1', 'facebook_posts', 'target') = 21
  and wd.m('W1', '2026-11-01', 'WD W1', 'gbp_posts', 'target') = 21
  and wd.m('W1', '2026-11-01', 'WD W1', 'blog_posts', 'target') = 13
  and wd.m('W1', '2026-11-01', 'WD W1', 'page_refreshes', 'target') = 1
  and wd.m('W1', '2026-11-01', 'WD W1', 'facebook_posts', 'version') = 2
  and wd.m('W1', '2026-11-01', 'WD W1', 'facebook_posts', 'planned') = 21
  and wd.m('W1', '2026-11-01', 'WD W1', 'facebook_posts', 'remaining') = 0
  and wd.m('W1', '2026-11-01', 'WD W1', 'gbp_posts', 'completed') = 1                  -- the delivered Nov 19 slot
  and wd.m('W1', '2026-11-01', 'WD W1', 'gbp_posts', 'planned') = 20
  and wd.m('W1', '2026-11-01', 'WD W1', 'page_refreshes', 'planned') = 1
  and wd.m('W1', '2026-12-01', 'WD W1', 'facebook_posts', 'target') = 23
  and wd.m('W1', '2026-12-01', 'WD W1', 'facebook_posts', 'planned') = 4
  and wd.m('W1', '2026-12-01', 'WD W1', 'blog_posts', 'target') = 13);
select wd.ok('P7 reruns open nothing more (the week has no room; the slot index refuses a copy)',
  plan_delivery_month(wd.id('W1'), '2026-11-01') = 0 and plan_delivery_week(wd.id('W1'), '2026-11-09') = 0);
select wd.ok('P8 the blog gate reads the weekly month target (room while delivered < target)',
  blog_publication_has_room(wd.id('W1'), wd.id('sW1'), '2026-11-01')
  and blog_publication_has_room(wd.id('W1'), wd.id('sW1'), '2026-12-01'));

-- ── Partial first week, transition month ────────────────────────────────────
select wd.keep('f1', plan_delivery_month(wd.id('W2'), '2026-11-01'));
select wd.ok('F1 W2 (first week Nov 9) gets nothing before Nov 9 and full weeks from it: Nov 9, 16, 23, 30, plus the month''s page refresh',
  wd.got('f1')::int = 4 * 13 + 1
  and not exists (select 1 from content_plan_items where client_id = wd.id('W2') and planned_date < '2026-11-09')
  and (select array_agg(distinct standard_week order by standard_week) from content_plan_items where client_id = wd.id('W2') and standard_week is not null)
      = array['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']::date[]
  and (select count(*) from wd.slots('W2', 'facebook_posts', '2026-11-09')) = 5
  and (select count(*) from wd.slots('W2', 'blog_posts', '2026-11-09')) = 3);
select wd.keep('f1b', plan_delivery_month(wd.id('W2'), '2026-11-01'));
select wd.ok('F1b a weekly client still gets one page-refresh slot per website per month (a fresh month with none), and a rerun opens no copy',
  wd.got('f1b')::int = 0
  and (select count(*) from content_plan_items where client_id = wd.id('W2') and standard_key = 'page_refreshes') = 1
  and (select standard_month = '2026-11-01' and standard_week is null and deliverable = 'web_page' and standard_seq = 1
         from content_plan_items where client_id = wd.id('W2') and standard_key = 'page_refreshes')
  and wd.m('W2', '2026-11-01', 'WD W2', 'page_refreshes', 'target') = 1
  and wd.m('W2', '2026-11-01', 'WD W2', 'page_refreshes', 'remaining') = 0);
select wd.keep('f1c', plan_delivery_month(wd.id('W1'), '2026-12-01')), wd.keep('f1c.again', plan_delivery_month(wd.id('W1'), '2026-12-01'));
select wd.ok('F1c W1''s December (no refresh slot yet): weeks Dec 7 – Dec 28 plus one refresh; the rerun opens nothing',
  wd.got('f1c')::int = 4 * 13 + 1 and wd.got('f1c.again')::int = 0
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and standard_key = 'page_refreshes' and standard_month = '2026-12-01') = 1
  and (select count(*) from content_plan_items where client_id = wd.id('W1') and standard_key = 'page_refreshes') = 2
  and wd.m('W1', '2026-12-01', 'WD W1', 'page_refreshes', 'remaining') = 0);
select wd.ok('F2 the transition month keeps v1 pro-rated for the days before the first week (8 × 5/21 weekdays = 2) plus the weekly days after (16 Facebook, 10 blogs)',
  wd.m('W2', '2026-11-01', 'WD W2', 'facebook_posts', 'target') = 18
  and wd.m('W2', '2026-11-01', 'WD W2', 'blog_posts', 'target') = 12
  and wd.m('W2', '2026-10-01', 'WD W2', 'facebook_posts', 'target') = 8
  and wd.m('W2', '2026-10-01', 'WD W2', 'facebook_posts', 'version') = 1);

-- ── Two locations, one website ──────────────────────────────────────────────
select wd.ok('L1 a website with two Business Profile locations still gets 5 GBP posts a week, split 3 / 2 across them on five different days, none over capacity',
  (select count(*) from wd.slots('W2', 'gbp_posts', '2026-11-16')) = 5
  and (select count(distinct planned_date) from wd.slots('W2', 'gbp_posts', '2026-11-16')) = 5
  and (select array_agg(n order by n) from (select count(*) n from wd.slots('W2', 'gbp_posts', '2026-11-16') group by gbp_location_id) x) = array[2, 3]::bigint[]
  and (select count(*) from content_plan_items where client_id = wd.id('W2') and standard_key = 'gbp_posts') = 20
  and (select array_agg(n order by n) from (select count(*) n from content_plan_items where client_id = wd.id('W2') and standard_key = 'gbp_posts'
                                            group by gbp_location_id) x) = array[10, 10]::bigint[]
  and not exists (select 1 from wd.ready('W2', '2026-11-09') where reason like 'Over capacity%')
  and not exists (select 1 from wd.ready('W2', '2026-11-16') where reason like 'Over capacity%'));

-- ── Three websites, one location ────────────────────────────────────────────
select wd.keep('b1', plan_delivery_week(wd.id('W3'), '2026-11-09'));
select wd.ok('B1 three sites on one location: 15 GBP slots opened (5 per site, none dropped), Facebook 5 and blogs 3 per site',
  wd.got('b1')::int = 15 + 15 + 9
  and (select array_agg(n) from (select count(*) n from wd.slots('W3', 'gbp_posts', '2026-11-09') group by brand_workspace_id) x) = array[5, 5, 5]::bigint[]
  and (select count(*) from wd.slots('W3', 'facebook_posts', '2026-11-09')) = 15
  and (select count(*) from wd.slots('W3', 'blog_posts', '2026-11-09')) = 9);
select wd.ok('B2 the collision rule: one GBP post per location per day — 7 slots fit (one a day, Mon–Sun), 8 are over capacity and readiness says so',
  (select count(*) from wd.ready('W3', '2026-11-09') where reason not like 'Over capacity%') = 7
  and (select count(*) from wd.ready('W3', '2026-11-09') where reason like 'Over capacity: gb.W3 already has 1 Business Profile post(s) planned on%') = 8
  and (select count(distinct d) from wd.ready('W3', '2026-11-09') where reason not like 'Over capacity%') = 7
  and (select min(n) from (select count(*) n from wd.ready('W3', '2026-11-09') where reason not like 'Over capacity%' group by bid) x) >= 2
  and (select over_capacity from delivery_week_report(wd.id('W3'), '2026-11-09', '2026-11-09') where deliverable = 'gbp_posts' and unit_name = 'WD Site W3a')
      + (select over_capacity from delivery_week_report(wd.id('W3'), '2026-11-09', '2026-11-09') where deliverable = 'gbp_posts' and unit_name = 'WD Site W3b')
      + (select over_capacity from delivery_week_report(wd.id('W3'), '2026-11-09', '2026-11-09') where deliverable = 'gbp_posts' and unit_name = 'WD Site W3c') = 8);
select wd.ok('B3 the report projects the overflow before planning (week Nov 16: 15 wanted, 7 cells)',
  (select bool_and(gbp_overflow = 8) from delivery_week_report(wd.id('W3'), '2026-11-16', '2026-11-16') where deliverable = 'gbp_posts' and unit_kind = 'brand'));
-- A post already scheduled at the location on Mon Nov 23 takes that day's cell.
set local session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, service_id, review_status, publish_status, created_at, scheduled_at, social_account_id)
values (wd.id('p.w3.manual'), wd.id('W3'), 'google_business', 'informational', wd.id('sW3a'), 'in_review', 'not_scheduled',
        '2026-10-30 12:00+00', '2026-11-23 15:00+00', wd.id('gb.W3'));
set local session_replication_role = origin;
select wd.keep('b4', plan_delivery_week(wd.id('W3'), '2026-11-23'));
select wd.ok('B4 an existing post counts against the cap: week Nov 23 places 6 slots on free days (none on Monday) and 8 site slots stay over capacity',
  wd.got('b4')::int = 15 + 14 + 9
  and (select count(*) from wd.ready('W3', '2026-11-23') where reason not like 'Over capacity%') = 6
  and not exists (select 1 from wd.ready('W3', '2026-11-23') where reason not like 'Over capacity%' and d = '2026-11-23')
  and (select count(*) from wd.ready('W3', '2026-11-23') where reason like 'Over capacity%') = 8);
select wd.keep('b5', queue_standard_social_tasks(wd.id('W3'), '2026-11-29'));
select wd.ok('B5 an over-capacity slot is never queued',
  wd.got('b5') is not null
  and not exists (select 1 from tasks t join content_plan_items i on t.key = 'social_slot:' || i.id::text
                   where i.client_id = wd.id('W3') and gbp_slot_capacity_problem(i.id, i.gbp_location_id) is not null));

-- ── No catch-up inside a week planned late ──────────────────────────────────
select wd.today('2026-11-04');
select wd.keep('c1', plan_delivery_week(wd.id('W5'), '2026-11-02')), wd.keep('c1.prev', plan_delivery_week(wd.id('W5'), '2026-10-26'));
select wd.ok('C1 a week first planned on its Wednesday gets the target of the days left (Facebook 3, GBP 3, blogs 2), nothing dated before today',
  wd.got('c1')::int = 8
  and (select array_agg(planned_date) from wd.slots('W5', 'facebook_posts', '2026-11-02')) = array['2026-11-04', '2026-11-05', '2026-11-06']::date[]
  and (select array_agg(planned_date) from wd.slots('W5', 'blog_posts', '2026-11-02')) = array['2026-11-04', '2026-11-06']::date[]
  and wd.got('c1.prev')::int = 0
  and not exists (select 1 from content_plan_items where client_id = wd.id('W5') and planned_date < '2026-11-04'));
create function wd.counts(c text, w date) returns int[] language sql as $$
  select array[(select count(*) from wd.slots(c, 'facebook_posts', w)), (select count(*) from wd.slots(c, 'gbp_posts', w)),
               (select count(*) from wd.slots(c, 'blog_posts', w))]::int[] $$;
select wd.keep('c2.same', plan_delivery_week(wd.id('W5'), '2026-11-02')), wd.keep('c2.month', plan_delivery_month(wd.id('W5'), '2026-11-01')),
       wd.keep('c2.w1', plan_delivery_week(wd.id('W1'), '2026-11-02'));
select wd.ok('C2 a second run the same Wednesday opens nothing in the week (Facebook stays 3, GBP 3, blogs 2), nor does the month planner (it opens only the later weeks), nor a rerun of a week planned before it began',
  wd.got('c2.same')::int = 0 and wd.got('c2.w1')::int = 0
  and wd.got('c2.month')::int = 4 * 13 + 1
  and wd.counts('W5', '2026-11-02') = array[3, 3, 2]);
select wd.today('2026-11-05');
-- Wednesday's slots are missed (removed) before Thursday's run.
delete from content_plan_items where client_id = wd.id('W5') and standard_week = '2026-11-02' and planned_date = '2026-11-04';
select wd.keep('c3', plan_delivery_week(wd.id('W5'), '2026-11-02'));
select wd.today('2026-11-06');
select wd.keep('c3.fri', plan_delivery_week(wd.id('W5'), '2026-11-02'));
select wd.ok('C3 reruns on Thursday and Friday add nothing back: the missed Wednesday stays missed (Facebook 2, GBP 2, blogs 1)',
  wd.got('c3')::int = 0 and wd.got('c3.fri')::int = 0
  and wd.counts('W5', '2026-11-02') = array[2, 2, 1]
  and not exists (select 1 from content_plan_items where client_id = wd.id('W5') and planned_date = '2026-11-04'));
select wd.today('2026-10-30');

-- ── DST ─────────────────────────────────────────────────────────────────────
select wd.ok('D1 weeks follow Chicago dates across DST: 23:30 CST on Sun Nov 1 is the week of Oct 26, 00:00 CST on Mon Nov 2 the week of Nov 2, 00:30 CDT on Mon Mar 15 2027 the week of Mar 15',
  (select week_start from delivery_items(wd.id('W6'), '2026-10-01', '2027-12-31') where social_post_id = wd.id('dst.sun')) = '2026-10-26'
  and (select item_date from delivery_items(wd.id('W6'), '2026-10-01', '2027-12-31') where social_post_id = wd.id('dst.sun')) = '2026-11-01'
  and (select week_start from delivery_items(wd.id('W6'), '2026-10-01', '2027-12-31') where social_post_id = wd.id('dst.mon')) = '2026-11-02'
  and (select week_start from delivery_items(wd.id('W6'), '2026-10-01', '2027-12-31') where social_post_id = wd.id('dst.spring')) = '2027-03-15'
  and delivery_week_start('2026-11-01') = '2026-10-26' and delivery_week_start('2027-03-14') = '2027-03-08');
select wd.keep('d2.prev', plan_delivery_week(wd.id('W6'), '2026-10-26')), wd.keep('d2', plan_delivery_week(wd.id('W6'), '2026-11-02'));
select wd.ok('D2 the DST-end week before the start carries no target; the Monday post fills one of week Nov 2''s five Facebook days',
  wd.got('d2.prev')::int = 0 and wd.got('d2')::int = 4 + 5 + 3
  and (select array_agg(planned_date) from wd.slots('W6', 'facebook_posts', '2026-11-02')) = array['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']::date[]
  and (select credited from delivery_week_report(wd.id('W6'), '2026-10-26', '2026-10-26') where deliverable = 'facebook_posts') = 1
  and (select target from delivery_week_report(wd.id('W6'), '2026-10-26', '2026-10-26') where deliverable = 'facebook_posts') = 0
  and (select credited from delivery_week_report(wd.id('W6'), '2026-11-02', '2026-11-02') where deliverable = 'facebook_posts') = 1);

-- ── A client without a weekly adoption: exactly as before ───────────────────
create temp table w4_slots as select id from content_plan_items where client_id = wd.id('W4');
select wd.ok('U1 delivery_targets answers exactly the previous function''s rows for every monthly client (November, all clients; October, W4)',
  not exists ((select * from delivery_targets(null, '2026-11-01') where client_id not in (select client_id from client_weekly_delivery_standards))
              except all (select * from delivery_targets_monthly(null, '2026-11-01') where client_id not in (select client_id from client_weekly_delivery_standards)))
  and not exists ((select * from delivery_targets_monthly(null, '2026-11-01') where client_id not in (select client_id from client_weekly_delivery_standards))
              except all (select * from delivery_targets(null, '2026-11-01') where client_id not in (select client_id from client_weekly_delivery_standards)))
  and not exists ((select * from delivery_targets(wd.id('W4'), '2026-10-01')) except all (select * from delivery_targets_monthly(wd.id('W4'), '2026-10-01')))
  and (select count(*) from delivery_targets(wd.id('W4'), '2026-11-01')) = 4
  and wd.m('W4', '2026-11-01', 'WD W4', 'gbp_posts', 'target') = 8);
select wd.keep('u2.week', plan_delivery_week(wd.id('W4'), '2026-11-09')), wd.keep('u2.month', plan_delivery_month(wd.id('W4'), '2030-06-01'));
select wd.ok('U2 the weekly planner does nothing for it; the monthly planner still opens v1 slots (no week, no retirement)',
  wd.got('u2.week')::int = 0 and wd.got('u2.month')::int = 25
  and not exists (select 1 from content_plan_items where client_id = wd.id('W4') and (standard_week is not null or retired_at is not null))
  and (select count(*) from content_plan_items where client_id = wd.id('W4') and standard_seq is not null and standard_month = '2030-06-01') = 25);
select wd.ok('U3 readiness is unchanged for it: two GBP slots on one day at one location are not over capacity',
  (select count(*) from wd.ready('W4', '2026-11-09')) = 2
  and not exists (select 1 from wd.ready('W4', '2026-11-09') where reason like 'Over capacity%')
  and gbp_slot_capacity_problem(wd.id('w4.b'), wd.id('gb.W4')) is null);
select wd.keep('u4.w2', (select count(*) from content_plan_items where client_id = wd.id('W2')));
select wd.keep('u4', plan_delivery_weeks());
select wd.ok('U4 the Monday beat plans only clients with a weekly adoption whose first week is this week or next (W2 starts Nov 9: not yet)',
  wd.got('u4')::int > 0
  and (select count(*) from content_plan_items where client_id = wd.id('W4')) = (select count(*) from w4_slots) + 25
  and (select count(*) from content_plan_items where client_id = wd.id('W2'))::text = wd.got('u4.w2')
  and exists (select 1 from content_plan_items where client_id = wd.id('W3') and standard_week = '2026-11-02'));

-- ── Drafting lead time ──────────────────────────────────────────────────────
-- Monday's content must be queued for drafting before Monday. Approved core
-- lists let the real blog queue run; social readiness is stood in for (all
-- open Facebook / GBP slots ready) so the test sees only the horizon.
savepoint lead_time;
set local session_replication_role = replica;
insert into core_keyword_lists (client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select wd.id(c), 1, 'approved', array[wd.id('kw.' || c)], 'test', (select id from team_members limit 1), now() from unnest(array['W1', 'W2', 'W4']) c;
set local session_replication_role = origin;
create or replace function social_slot_readiness(p_client_id uuid, p_from date, p_through date)
returns table (plan_item_id uuid, client_id uuid, brand_workspace_id uuid, deliverable text, channel text, planned_date date,
               social_account_id uuid, shared_same_day integer, core_list_id uuid, core_list_version integer, task_id uuid,
               ready boolean, reason text)
language sql stable set search_path = public, pg_temp as $$
  select i.id, i.client_id, i.brand_workspace_id, i.standard_key, i.channel::text, i.planned_date, coalesce(i.gbp_location_id, i.client_id),
         0, i.client_id, 1, (select t.id from tasks t where t.key = 'social_slot:' || i.id::text), true, null::text
  from content_plan_items i
  where i.client_id = p_client_id and i.standard_key in ('facebook_posts', 'gbp_posts') and i.planned_date between p_from and p_through
    and i.hold is null and i.social_post_id is null
  order by i.planned_date, i.id $$;
-- A slot's queued task, if any.
create function wd.queued(c text, d date, dk text) returns bigint language sql as $$
  select count(*) from content_plan_items i join tasks t on t.client_id = i.client_id
     and (t.key = 'social_slot:' || i.id::text or (t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%'))
   where i.client_id = wd.id(c) and i.planned_date = d and i.standard_key = dk $$;
select wd.today('2026-11-04');
select wd.keep('q1', create_weekly_blog_tasks());
select wd.ok('Q1 the Wednesday beat (Nov 4) queues a weekly client''s NEXT week too: Monday Nov 9''s Facebook, GBP and blog drafts are queued five days ahead, W2''s first Monday included; nothing after Sunday Nov 15',
  wd.queued('W1', '2026-11-09', 'facebook_posts') = 1 and wd.queued('W1', '2026-11-09', 'gbp_posts') = 1
  and wd.queued('W1', '2026-11-09', 'blog_posts') = 1
  and wd.queued('W1', '2026-11-10', 'facebook_posts') = 1
  and wd.queued('W2', '2026-11-09', 'facebook_posts') = 1 and wd.queued('W2', '2026-11-09', 'blog_posts') = 1
  and (select count(*) from tasks t join content_plan_items i on t.key = 'social_slot:' || i.id::text
        where i.client_id in (wd.id('W1'), wd.id('W2')) and i.planned_date > '2026-11-15' and t.id <> wd.id('t.nov17')) = 0  -- the fixture's own task
  and (select count(*) from tasks t where t.client_id in (wd.id('W1'), wd.id('W2')) and t.key = 'blog_post' and t.due_date > '2026-11-15') = 0
  and (select due_date from tasks t join content_plan_items i on t.key = 'social_slot:' || i.id::text
        where i.client_id = wd.id('W1') and i.standard_key = 'facebook_posts' and i.planned_date = '2026-11-09') = '2026-11-09');
select wd.ok('Q1b a client on the monthly standard keeps this week''s horizon: W4''s Tuesday Nov 10 GBP slots are not queued on Nov 4',
  wd.queued('W4', '2026-11-10', 'gbp_posts') = 0);
-- (Other suites' fixture clients are in the database too; only this suite's are counted.)
create function wd.ntasks() returns bigint language sql as $$
  select count(*) from tasks where client_id in (select wd.id(c) from unnest(array['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) c) $$;
select wd.keep('q2.tasks', wd.ntasks());
select wd.keep('q2', create_weekly_blog_tasks());
select wd.ok('Q2 a second Wednesday run queues nothing twice', wd.ntasks()::text = wd.got('q2.tasks'));
select wd.today('2026-11-16');
select wd.keep('q3', plan_delivery_weeks());
select wd.ok('Q3 the Monday beat (Nov 16, 04:00 Chicago) queues this week''s drafts for weekly clients whose first week has begun, so a week the Wednesday beat did not reach is not left until Wednesday; next week waits for its Wednesday',
  wd.queued('W1', '2026-11-16', 'facebook_posts') = 1 and wd.queued('W1', '2026-11-16', 'blog_posts') = 1
  and wd.queued('W2', '2026-11-16', 'facebook_posts') = 1
  and wd.queued('W1', '2026-11-23', 'facebook_posts') = 0
  and wd.queued('W4', '2026-11-16', 'gbp_posts') = 0);
rollback to savepoint lead_time;
select wd.today('2026-10-30');

-- ── Access ──────────────────────────────────────────────────────────────────
select wd.ok('S1 the beat and the guards are not callable by the API; readers are team-only; the clock override needs a superuser',
  not has_function_privilege('authenticated', 'plan_delivery_weeks()', 'execute')
  and not has_function_privilege('service_role', 'plan_delivery_weeks()', 'execute')
  and not has_function_privilege('anon', 'delivery_week_report(uuid, date, date, date)', 'execute')
  and not has_function_privilege('anon', 'plan_delivery_week(uuid, date)', 'execute')
  and not has_function_privilege('anon', 'delivery_items(uuid, date, date)', 'execute')
  and not has_function_privilege('authenticated', 'client_weekly_delivery_guard()', 'execute')
  and not has_function_privilege('authenticated', 'queue_delivery_week_drafts(uuid, date)', 'execute')
  and not has_function_privilege('anon', 'queue_delivery_week_drafts(uuid, date)', 'execute')
  and not has_table_privilege('anon', 'client_weekly_delivery_standards', 'select')
  and not has_table_privilege('authenticated', 'client_weekly_delivery_standards', 'delete')
  and exists (select 1 from pg_policies where tablename = 'client_weekly_delivery_standards' and qual like '%is_team()%'));
grant usage on schema wd to public;
grant execute on all functions in schema wd to public;
set local role authenticated;
select wd.ok('S2 a signed-out authenticated caller sees no adoption (RLS)', not exists (select 1 from client_weekly_delivery_standards));
reset role;
set local session authorization postgres;
select wd.ok('S3 a non-superuser cannot move the clock', delivery_today() = (now() at time zone 'America/Chicago')::date);
reset session authorization;

-- ── Rollback, with the weekly data present (confirmed) ──────────────────────
savepoint before_down;
select set_config('compass.weekly_rollback', 'confirmed', true);
\ir ../../rollback/20261030180000_weekly_delivery_standard.down.sql
select wd.ok('RB1 rollback with data: v1 holds restored, unattached weekly slots removed, attached and refresh slots kept, adoptions kept aside, functions exact, cron gone',
  (select hold is null from content_plan_items where id = wd.id('v1.fb.nov5'))
  and (select hold = 'blocked' and hold_reason = 'Waiting on photos.' from content_plan_items where id = wd.id('v1.blog.nov4'))
  and (select count(*) from content_plan_items where client_id = wd.id('W1')) = 11   -- the 10 v1 rows + December's refresh slot (monthly, kept)
  and to_regclass('client_weekly_delivery_standards_rolled_back') is not null
  and to_regclass('client_weekly_delivery_standards') is null
  and to_regprocedure('delivery_targets_monthly(uuid,date)') is null
  and md5(pg_get_functiondef('delivery_targets(uuid,date)'::regprocedure)) = '4d67bf3ff886339f6675c56a73bbf311'
  and md5(pg_get_functiondef('create_weekly_blog_tasks()'::regprocedure)) = 'fdddc0423cafc81c222fa4231938b6ad'
  and md5(pg_get_functiondef('plan_delivery_month(uuid,date)'::regprocedure)) = '4a6fc125878f692f756e88e13ea45a53'
  and not exists (select 1 from cron.job where jobname = 'delivery-standard-week'));
rollback to savepoint before_down;
select wd.ok('RB2 undone: the weekly standard is back', to_regclass('client_weekly_delivery_standards') is not null
  and strpos(pg_get_functiondef('social_slot_readiness(uuid,date,date)'::regprocedure), 'weekly_gbp_capacity_v1') > 0
  and strpos(pg_get_functiondef('create_weekly_blog_tasks()'::regprocedure), 'weekly_delivery_v1') > 0);

rollback;

-- Rollback with no weekly data at all: everything the migration added goes,
-- standard 2 and the cadence columns included.
begin;
\ir ../../rollback/20261030180000_weekly_delivery_standard.down.sql
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'delivery_standards' and column_name in ('cadence', 'gbp_daily_location_cap'))
     or exists (select 1 from delivery_standards where version = 2)
     or to_regclass('public.client_weekly_delivery_standards') is not null
     or to_regprocedure('public.delivery_week_report(uuid,date,date,date)') is not null
     or exists (select 1 from information_schema.columns where table_name = 'content_plan_items' and column_name in ('standard_week', 'retired_at')) then
    raise exception 'FAILED RB3 clean rollback left something behind';
  end if;
  raise notice 'ok RB3 clean rollback removes everything, standard 2 included, and restores the four functions exactly';
end $$;
rollback;
