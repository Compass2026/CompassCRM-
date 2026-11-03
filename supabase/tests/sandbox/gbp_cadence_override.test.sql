-- 20261103170000: the Business Profile cadence override. Fictional clients
-- only; everything is rolled back. "Today" is pinned with
-- compass.delivery_today (a superuser session only) to Fri Nov 6 2026.
--   OV  three brand sites on ONE Business Profile location, weekly from
--       Mon Nov 9, override: 7 GBP posts a week, round robin. Its sites'
--       names sort the opposite way to their slugs, so the rotation is
--       shown to follow the slug.
--   NO  the same shape, no override (the control: 15 wanted, 8 over capacity).
--   SG  one website, one location, no override.
--   LT  two sites on one location, override 7 a week, first planned late
--       (Wed Nov 11): no catch-up.
-- N1 runs the rollback inside a savepoint, plans and reads NO, SG and OV
-- with the previous definitions, keeps the results in psql variables, then
-- compares them with the new definitions byte for byte.
begin;
create schema ov;
create function ov.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ov.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ov.id(k text) returns uuid language sql immutable as $$ select md5('ov:' || k)::uuid $$;
create function ov.today(d date) returns void language sql as $$ select set_config('compass.delivery_today', d::text, true) $$;
-- The client's open (not retired) weekly GBP slots of a week, by date.
create function ov.gbp(c text, w date) returns setof content_plan_items language sql as $$
  select * from content_plan_items where client_id = ov.id(c) and standard_key = 'gbp_posts' and standard_week = w
    and retired_at is null order by planned_date, id $$;
-- The site letter of each of those slots in date order ('abcabca').
create function ov.rr(c text, w date) returns text language sql as $$
  select string_agg(right(b.slug, 1), '' order by g.planned_date, g.id) from ov.gbp(c, w) g
  join client_brand_workspaces b on b.id = g.brand_workspace_id $$;
-- Slots per site, slug order ('3/2/2').
create function ov.share(c text, w date) returns text language sql as $$
  select string_agg(n::text, '/' order by slug) from (
    select b.slug, (select count(*) from ov.gbp(c, w) g where g.brand_workspace_id = b.id) n
    from client_brand_workspaces b where b.client_id = ov.id(c)) x $$;
-- Report / targets per site for one deliverable, slug order.
create function ov.wk(c text, w date, dk text, f text) returns text language sql as $$
  select string_agg(case f when 'target' then r.target when 'over_capacity' then r.over_capacity when 'remaining' then r.remaining
                           when 'over_target' then r.over_target when 'open_slots' then r.open_slots when 'v1_retired' then r.v1_retired
                           when 'gbp_overflow' then r.gbp_overflow end::text, '/' order by b.slug)
  from delivery_week_report(ov.id(c), w, w) r join client_brand_workspaces b on b.id = r.brand_workspace_id
  where r.deliverable = dk $$;
create function ov.mt(c text, m date, dk text, f text) returns text language sql as $$
  select string_agg(case f when 'target' then t.target when 'planned' then t.planned when 'remaining' then t.remaining end::text,
                    '/' order by b.slug)
  from delivery_targets(ov.id(c), m) t join client_brand_workspaces b on b.id = t.brand_workspace_id
  where t.deliverable = dk $$;
create table ov.r (k text primary key, v text);
create function ov.keep(k text, v anyelement) returns void language sql as $$
  insert into ov.r values (k, v::text) on conflict (k) do update set v = excluded.v $$;
create function ov.got(k text) returns text language sql as $$ select v from ov.r where r.k = got.k $$;
create function ov.override(c text, alloc text, total int, w date) returns text language sql as $$
  select ov.err(format('insert into client_delivery_overrides (client_id, deliverable, allocation, weekly_total, effective_week, source_ref) values (%L, %L, %L, %L, %L, %L)',
                       ov.id(c), 'gbp_posts', alloc, total, w, 'test')) $$;
select ov.today('2026-11-06');

select ov.ok('M1 the migration records no override and opens no slot',
  not exists (select 1 from client_delivery_overrides)
  and not exists (select 1 from content_plan_items where delivery_override_id is not null));

-- ── Fixtures (triggers off: they are not under test) ────────────────────────
set local session_replication_role = replica;
insert into clients (id, name, status, website_url)
select ov.id(c), 'OVT ' || c, 'active', 'https://' || lower(c) || '.example.test' from unnest(array['OV', 'NO', 'SG', 'LT']) c;
insert into brand_boards (client_id, status, approved_on) values (ov.id('SG'), 'approved', now());
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id,
                             publish_page_id, publish_verified_at, publish_enabled)
select ov.id('gb.' || c), ov.id(c), 'google_business', 'gb.' || c, 'locations/9' || n, 'zernio', left(md5(c), 24),
       'locations/9' || n, now(), false
from (values ('OV', 1), ('NO', 2), ('SG', 3), ('LT', 4)) v(c, n);
insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind)
select ov.id(c), 'zernio', 'publisher' from unnest(array['OV', 'NO', 'SG', 'LT']) c;
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, status, approved_by, approved_at)
select ov.id(c || s), ov.id(c), 'site-' || s, c || ' ' || nm, 'https://' || lower(c) || s || '.example.test', '5555555555',
       '{}', 'approved', (select id from team_members limit 1), now()
from (values ('OV', 'a', 'Zulu'), ('OV', 'b', 'Yankee'), ('OV', 'c', 'Xray'),
             ('NO', 'a', 'Zulu'), ('NO', 'b', 'Yankee'), ('NO', 'c', 'Xray'),
             ('LT', 'a', 'Alpha'), ('LT', 'b', 'Bravo')) v(c, s, nm);
set local session_replication_role = origin;
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select ov.id(c), (select id from delivery_standards where version = 1), '2026-10-01', 'test' from unnest(array['OV', 'NO', 'SG', 'LT']) c;
insert into client_weekly_delivery_standards (client_id, standard_id, start_date, source_ref)
select ov.id(c), (select id from delivery_standards where version = 2), '2026-11-09', 'test' from unnest(array['OV', 'NO', 'SG', 'LT']) c;

-- Planning shared by both halves of N1: NO and SG for five weeks, OV's
-- Dec 7 week (planned under the standard before the override exists), then
-- OV's November weeks and Dec 7 again.
create function ov.plan_others() returns text language sql as $$
  select string_agg(n, ',') from (
  select plan_delivery_week(ov.id(c), w)::text n
  from unnest(array['NO', 'SG']) c, unnest(array['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']::date[]) w
  union all select plan_delivery_week(ov.id('OV'), '2026-12-07')::text) x $$;
create function ov.plan_ov() returns text language sql as $$
  select string_agg(plan_delivery_week(ov.id('OV'), w)::text, ',' order by w)
  from unnest(array['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']::date[]) w $$;
-- Everything the planner wrote for NO and SG, and OV's Facebook and blog slots.
create function ov.snap_slots() returns text language sql as $$
  select string_agg(x, E'\n' order by x) from (
    select concat_ws('|', client_id, brand_workspace_id, week_start, deliverable, channel, purpose, topic, planned_date, notes, hold,
                     hold_reason, standard_key, standard_month, standard_week, standard_week_seq, gbp_location_id, retired_at is not null) x
    from content_plan_items
    where client_id in (ov.id('NO'), ov.id('SG')) or (client_id = ov.id('OV') and standard_key in ('facebook_posts', 'blog_posts'))) s $$;
-- What the week report and the month targets say about them.
create function ov.snap_reads() returns text language sql as $$
  select string_agg(x, E'\n' order by x) from (
    select r::text x from unnest(array['NO', 'SG', 'OV']) c
      cross join lateral delivery_week_report(ov.id(c), '2026-11-02', '2026-12-14') r
     where c <> 'OV' or r.deliverable <> 'gbp_posts'
    union all
    select t::text from unnest(array['NO', 'SG', 'OV']) c
      cross join unnest(array['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']::date[]) m
      cross join lateral delivery_targets(ov.id(c), m) t
     where c <> 'OV' or t.deliverable <> 'gbp_posts') s $$;

-- ── N1, first half: the previous definitions (rolled back afterwards) ───────
savepoint before_override;
\ir ../../rollback/20261103170000_gbp_cadence_override.down.sql
select ov.ok('V0 with no override recorded the rollback removes everything and restores the three functions exactly',
  to_regclass('client_delivery_overrides') is null
  and to_regprocedure('delivery_override_allocation(uuid,text,date)') is null
  and not exists (select 1 from information_schema.columns where table_name = 'content_plan_items' and column_name = 'delivery_override_id')
  and md5(pg_get_functiondef('plan_delivery_week(uuid,date)'::regprocedure)) = '849de48f5843cfd2a64ccab09093fd4b'
  and md5(pg_get_functiondef('delivery_week_report(uuid,date,date,date)'::regprocedure)) = 'd1be320ef0de398b314b39c68fcaf724'
  and md5(pg_get_functiondef('delivery_targets(uuid,date)'::regprocedure)) = '82b6e7c31c83e498aa8a5861bd5a6a46');
select ov.plan_others() as v0_others, ov.plan_ov() as v0_ov \gset
select ov.snap_slots() as v0_slots, ov.snap_reads() as v0_reads \gset
rollback to savepoint before_override;

-- ── N1, second half: the new definitions ────────────────────────────────────
select ov.keep('others', ov.plan_others());
select ov.ok('N1 without an override the planner opens what it opened before the migration (NO: three sites on one location, 15 GBP slots, 8 over capacity; SG: one site); N3 compares every row',
  ov.got('others') = :'v0_others'
  and (select count(*) from ov.gbp('NO', '2026-11-16')) = 15
  and ov.wk('NO', '2026-11-16', 'gbp_posts', 'over_capacity') is not null
  and (select sum(over_capacity) from delivery_week_report(ov.id('NO'), '2026-11-16', '2026-11-16') where deliverable = 'gbp_posts') = 8);

-- OV's Dec 7 week, planned under the standard: 15 GBP slots. One of them
-- (site b, Monday) gets an open drafting task, i.e. work attached.
select ov.ok('N2 before its override OV plans like NO: 15 GBP slots in the week of Dec 7, 8 over capacity',
  (select count(*) from ov.gbp('OV', '2026-12-07')) = 15
  and (select count(*) from ov.gbp('OV', '2026-12-07') g where gbp_slot_capacity_problem(g.id, g.gbp_location_id) is not null) = 8);
insert into tasks (id, client_id, title, owner, status, key, due_date)
select ov.id('t.dec7'), ov.id('OV'), 'queued', 'CLAUDE', 'open', 'social_slot:' || g.id, g.planned_date
from ov.gbp('OV', '2026-12-07') g where g.brand_workspace_id = ov.id('OVb') and g.planned_date = '2026-12-07'
order by g.standard_week_seq limit 1;

-- ── The record ──────────────────────────────────────────────────────────────
select ov.ok('O1 an override starts on a Monday, never in the past, is round_robin with 1–7 a week or standard with none, covers Business Profile posts only',
  ov.override('OV', 'round_robin', 7, '2026-11-02') like '23514:%no retroactive%'
  and ov.override('OV', 'round_robin', 7, '2026-11-10') like '23514:%'
  and ov.override('OV', 'round_robin', 8, '2026-11-09') like '23514:%'
  and ov.override('OV', 'round_robin', null, '2026-11-09') like '23514:%'
  and ov.override('OV', 'standard', 7, '2026-11-09') like '23514:%'
  and ov.err(format('insert into client_delivery_overrides (client_id, deliverable, allocation, weekly_total, effective_week, source_ref) values (%L, %L, %L, %L, %L, %L)',
                    ov.id('OV'), 'facebook_posts', 'round_robin', 5, '2026-11-09', 'test')) like '23514:%'
  and ov.err(format('insert into client_delivery_overrides (client_id, deliverable, allocation, weekly_total, effective_week, source_ref) values (%L, %L, %L, %L, %L, %L)',
                    ov.id('OV'), 'gbp_posts', 'round_robin', 7, '2026-11-09', ' ')) like '23514:%'
  and not exists (select 1 from client_delivery_overrides));
select ov.keep('o2', ov.override('OV', 'round_robin', 7, '2026-11-09')), ov.keep('o2.lt', ov.override('LT', 'round_robin', 7, '2026-11-09'));
select ov.ok('O2 the override is recorded as data and is history: one per week, no update, no delete',
  ov.got('o2') = 'accepted' and ov.got('o2.lt') = 'accepted'
  and ov.override('OV', 'round_robin', 6, '2026-11-09') like '23505:%'
  and ov.err(format('update client_delivery_overrides set weekly_total = 6 where client_id = %L', ov.id('OV'))) like '23514:%'
  and ov.err(format('delete from client_delivery_overrides where client_id = %L', ov.id('OV'))) like '23514:%'
  and (client_delivery_override(ov.id('OV'), 'gbp_posts', '2026-11-08')).id is null
  and (client_delivery_override(ov.id('OV'), 'gbp_posts', '2026-11-11')).weekly_total = 7
  and (client_delivery_override(ov.id('NO'), 'gbp_posts', '2026-11-11')).id is null);

-- ── Planning under the override ─────────────────────────────────────────────
select ov.keep('ov', ov.plan_ov());
select ov.ok('O3 a week opens exactly 7 GBP slots on 7 different days (Mon–Sun), one a day, 3 / 2 / 2 across the sites, all under the override at the one location; Facebook 5 and blogs 3 per site as before',
  split_part(ov.got('ov'), ',', 1) = (15 + 9 + 7)::text
  and (select count(*) from ov.gbp('OV', '2026-11-09')) = 7
  and (select array_agg(planned_date order by planned_date) from ov.gbp('OV', '2026-11-09'))
      = array['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']::date[]
  and ov.share('OV', '2026-11-09') = '3/2/2'
  and (select bool_and(delivery_override_id = (client_delivery_override(ov.id('OV'), 'gbp_posts', '2026-11-09')).id
                       and gbp_location_id = ov.id('gb.OV')) from ov.gbp('OV', '2026-11-09'))
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'facebook_posts' and standard_week = '2026-11-09') = 15
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'blog_posts' and standard_week = '2026-11-09') = 9);
select ov.ok('O4 the round robin is continuous: posts alternate a, b, c day after day across week boundaries, so the extra post leads with a, then b, then c, then a again',
  ov.rr('OV', '2026-11-09') = 'abcabca' and ov.rr('OV', '2026-11-16') = 'bcabcab'
  and ov.rr('OV', '2026-11-23') = 'cabcabc' and ov.rr('OV', '2026-11-30') = 'abcabca'
  and ov.share('OV', '2026-11-16') = '2/3/2' and ov.share('OV', '2026-11-23') = '2/2/3' and ov.share('OV', '2026-11-30') = '3/2/2'
  and (select string_agg(right(b.slug, 1), '' order by i.planned_date) from content_plan_items i
         join client_brand_workspaces b on b.id = i.brand_workspace_id
        where i.client_id = ov.id('OV') and i.standard_key = 'gbp_posts' and i.retired_at is null
          and i.planned_date between '2026-11-09' and '2026-11-29') = repeat('abc', 7)
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'gbp_posts'
         and standard_week between '2026-11-09' and '2026-11-23') = 21);
select ov.ok('O5 a week the standard planned before the override: its 14 unattached GBP slots are retired (kept, blocked, with the reason), the slot with work attached stays and holds its day, and the override fills the other six days',
  split_part(ov.got('ov'), ',', 5) = '6'
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'gbp_posts' and standard_week = '2026-12-07'
         and retired_at is not null and hold = 'blocked' and retired_hold is null
         and hold_reason like 'Retired: superseded by the Business Profile cadence override (7 a week%') = 14
  and (select count(*) from ov.gbp('OV', '2026-12-07')) = 7
  and (select count(distinct planned_date) from ov.gbp('OV', '2026-12-07')) = 7
  and ov.rr('OV', '2026-12-07') = 'bcabcab' and ov.share('OV', '2026-12-07') = '2/3/2'
  and (select delivery_override_id is null from content_plan_items where id = (select substr(key, 13)::uuid from tasks where id = ov.id('t.dec7')))
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'gbp_posts') = 7 * 5 + 14);
select ov.ok('N3 OV''s Facebook, blog and refresh slots, week-report rows and month-target rows are byte-for-byte what the previous definitions gave, as are NO''s and SG''s',
  ov.snap_slots() = :'v0_slots' and ov.snap_reads() = :'v0_reads');
select ov.ok('O6 reruns open nothing: every week again, and the month planner adds only its one page refresh per site',
  ov.plan_ov() = '0,0,0,0,0'
  and plan_delivery_month(ov.id('OV'), '2026-11-01') = 3 and plan_delivery_month(ov.id('OV'), '2026-11-01') = 0
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'gbp_posts') = 7 * 5 + 14);
select ov.ok('O7 no override slot is over capacity (the control NO has 8 a week)',
  not exists (select 1 from content_plan_items i where i.client_id = ov.id('OV') and i.standard_key = 'gbp_posts'
                and gbp_slot_capacity_problem(i.id, i.gbp_location_id) is not null)
  and not exists (select 1 from social_slot_readiness(ov.id('OV'), '2026-11-09', '2026-12-13') r where r.reason like 'Over capacity%'));

-- ── Reporting ───────────────────────────────────────────────────────────────
select ov.ok('R1 delivery_week_report: the GBP target is the site''s share (7 a week in total, not 15); no over capacity, no overflow, nothing remaining or over target, the removed slots listed as retired',
  ov.wk('OV', '2026-11-09', 'gbp_posts', 'target') = '3/2/2' and ov.wk('OV', '2026-11-16', 'gbp_posts', 'target') = '2/3/2'
  and ov.wk('OV', '2026-11-23', 'gbp_posts', 'target') = '2/2/3' and ov.wk('OV', '2026-12-07', 'gbp_posts', 'target') = '2/3/2'
  and (select bool_and(s = 7) from (select sum(target) s from delivery_week_report(ov.id('OV'), '2026-11-09', '2026-12-07')
                                    where deliverable = 'gbp_posts' group by week_start) x)
  and (select sum(over_capacity) + sum(remaining) + sum(over_target) + max(gbp_overflow)
         from delivery_week_report(ov.id('OV'), '2026-11-09', '2026-12-07') where deliverable = 'gbp_posts') = 0
  and ov.wk('OV', '2026-12-07', 'gbp_posts', 'v1_retired') = '5/4/5'
  and ov.wk('NO', '2026-11-09', 'gbp_posts', 'target') = '5/5/5'
  and ov.wk('NO', '2026-11-09', 'gbp_posts', 'over_capacity') <> '0/0/0');
select ov.ok('R2 Facebook and blog targets are unchanged (5 and 3 per site a week)',
  ov.wk('OV', '2026-11-16', 'facebook_posts', 'target') = '5/5/5' and ov.wk('OV', '2026-11-16', 'blog_posts', 'target') = '3/3/3'
  and ov.mt('OV', '2026-11-01', 'facebook_posts', 'target') = '18/18/18' and ov.mt('OV', '2026-11-01', 'blog_posts', 'target') = '12/12/12'
  and ov.mt('OV', '2026-12-01', 'facebook_posts', 'target') = ov.mt('NO', '2026-12-01', 'facebook_posts', 'target')
  and ov.mt('OV', '2026-12-01', 'page_refreshes', 'target') = '1/1/1');
select ov.ok('R3 delivery_targets: a month''s GBP target is each site''s override days (one post a day, a continuous a/b/c rotation) plus the v1 days before the first week; November 10 / 9 / 9 (= 6 + 22 days), December 10 / 11 / 10 (31 days), January 31 days',
  ov.mt('OV', '2026-11-01', 'gbp_posts', 'target') = '10/9/9'
  and ov.mt('NO', '2026-11-01', 'gbp_posts', 'target') = '18/18/18'
  and ov.mt('OV', '2026-11-01', 'gbp_posts', 'planned') = '8/7/7'
  and ov.mt('OV', '2026-11-01', 'gbp_posts', 'remaining') = '2/2/2'
  and ov.mt('OV', '2026-12-01', 'gbp_posts', 'target') = '10/11/10'
  and (select sum(target) from delivery_targets(ov.id('OV'), '2027-01-01') where deliverable = 'gbp_posts') = 31
  and delivery_override_month_delta(ov.id('NO'), 'gbp_posts', '2026-12-01', ov.id('NOa')) = 0
  and delivery_override_month_delta(ov.id('OV'), 'facebook_posts', '2026-12-01', ov.id('OVa')) = 0);

-- ── No catch-up ─────────────────────────────────────────────────────────────
select ov.today('2026-11-11');
select ov.keep('lt', plan_delivery_week(ov.id('LT'), '2026-11-09'));
select ov.ok('C1 a week first planned on its Wednesday gets the override''s positions from today (Wed–Sun), alternating between two sites; Monday and Tuesday are not made up',
  ov.got('lt')::int = 6 + 4 + 5
  and (select array_agg(planned_date order by planned_date) from ov.gbp('LT', '2026-11-09'))
      = array['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']::date[]
  and ov.rr('LT', '2026-11-09') = 'ababa'
  and ov.wk('LT', '2026-11-09', 'gbp_posts', 'target') = '4/3'
  and plan_delivery_week(ov.id('LT'), '2026-11-09') = 0);
delete from content_plan_items where client_id = ov.id('LT') and standard_key = 'gbp_posts' and planned_date = '2026-11-11';
select ov.today('2026-11-12');
select ov.ok('C2 a rerun on Thursday adds nothing back for the missed Wednesday; the next week starts with b (the rotation runs on)',
  plan_delivery_week(ov.id('LT'), '2026-11-09') = 0
  and (select count(*) from ov.gbp('LT', '2026-11-09')) = 4
  and plan_delivery_week(ov.id('LT'), '2026-11-16') = 10 + 6 + 7
  and ov.rr('LT', '2026-11-16') = 'bababab');
select ov.today('2026-11-06');

-- ── Ending the override ─────────────────────────────────────────────────────
select ov.keep('end', ov.override('OV', 'standard', null, '2026-12-14'));
select ov.ok('E1 a later standard row ends the override from its week: the week of Dec 14 is planned and reported to the standard (5 a site, 8 over capacity again); earlier weeks keep the override',
  ov.got('end') = 'accepted'
  and plan_delivery_week(ov.id('OV'), '2026-12-14') = 15 + 15 + 9
  and ov.share('OV', '2026-12-14') = '5/5/5'
  and not exists (select 1 from ov.gbp('OV', '2026-12-14') where delivery_override_id is not null)
  and ov.wk('OV', '2026-12-14', 'gbp_posts', 'target') = '5/5/5'
  and ov.wk('OV', '2026-12-07', 'gbp_posts', 'target') = '2/3/2'
  and delivery_override_week_target(ov.id('OV'), 'gbp_posts', ov.id('OVa'), '2026-12-14') is null);

-- ── Access ──────────────────────────────────────────────────────────────────
select ov.ok('S1 team-only: no anon access, no update or delete for authenticated, the policy reads is_team(), the guard is not callable',
  not has_table_privilege('anon', 'client_delivery_overrides', 'select')
  and not has_table_privilege('authenticated', 'client_delivery_overrides', 'update')
  and not has_table_privilege('authenticated', 'client_delivery_overrides', 'delete')
  and has_table_privilege('authenticated', 'client_delivery_overrides', 'insert')
  and not has_function_privilege('anon', 'delivery_override_allocation(uuid, text, date)', 'execute')
  and not has_function_privilege('anon', 'delivery_override_month_delta(uuid, text, date, uuid)', 'execute')
  and not has_function_privilege('anon', 'client_delivery_override(uuid, text, date)', 'execute')
  and not has_function_privilege('authenticated', 'client_delivery_overrides_guard()', 'execute')
  and exists (select 1 from pg_policies where tablename = 'client_delivery_overrides'
                and qual like '%is_team()%' and with_check like '%is_team()%'));
grant usage on schema ov to public;
grant execute on all functions in schema ov to public;
set local role authenticated;
select ov.ok('S2 a signed-out authenticated caller sees no override (RLS)', not exists (select 1 from client_delivery_overrides));
reset role;

-- ── Rollback, with overrides recorded (confirmed) ───────────────────────────
savepoint before_down;
select set_config('compass.delivery_override_rollback', 'confirmed', true);
\ir ../../rollback/20261103170000_gbp_cadence_override.down.sql
select ov.ok('RB1 rollback with data: functions exact, overrides kept aside, column gone, nothing deleted (retired slots stay retired)',
  to_regclass('client_delivery_overrides') is null
  and (select count(*) from client_delivery_overrides_rolled_back) = 3
  and not exists (select 1 from information_schema.columns where table_name = 'content_plan_items' and column_name = 'delivery_override_id')
  and md5(pg_get_functiondef('plan_delivery_week(uuid,date)'::regprocedure)) = '849de48f5843cfd2a64ccab09093fd4b'
  and md5(pg_get_functiondef('delivery_week_report(uuid,date,date,date)'::regprocedure)) = 'd1be320ef0de398b314b39c68fcaf724'
  and md5(pg_get_functiondef('delivery_targets(uuid,date)'::regprocedure)) = '82b6e7c31c83e498aa8a5861bd5a6a46'
  and (select count(*) from content_plan_items where client_id = ov.id('OV') and standard_key = 'gbp_posts' and retired_at is not null) = 14
  and ov.wk('OV', '2026-11-09', 'gbp_posts', 'target') = '5/5/5');
rollback to savepoint before_down;
select ov.ok('RB2 undone: the override is back', to_regclass('client_delivery_overrides') is not null
  and strpos(pg_get_functiondef('plan_delivery_week(uuid,date)'::regprocedure), 'delivery_override_v1') > 0
  and ov.wk('OV', '2026-11-09', 'gbp_posts', 'target') = '3/2/2');

rollback;
