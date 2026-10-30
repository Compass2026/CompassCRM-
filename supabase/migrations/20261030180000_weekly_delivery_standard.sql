-- Weekly delivery standard (Tom, Oct 29 2026). Needs
-- 20261015150000_monthly_delivery_standard, 20261027190935_gbp_location_per_post,
-- 20261027191343_weekly_social_slots and 20261029030000 (readiness_scale).
-- Sandbox suite: supabase/tests/sandbox/weekly_delivery_standard.test.sql.
-- Rollback: supabase/rollback/20261030180000_weekly_delivery_standard.down.sql.
-- Design and the decisions left to Tom: docs/delivery-standard.md.
--
-- Per website, per week: 5 Facebook posts, 5 Business Profile posts, 3 blogs.
-- Per website, per month: 1 page refresh (unchanged). A cadence, not 20/20/12:
--
--   Week    Monday–Sunday, America/Chicago dates. An item counts in the week
--           of its own date: published → published_at; otherwise the date of
--           the plan slot it fills; otherwise its own scheduled / due /
--           created date. Timestamps are converted to Chicago dates first, so
--           the DST weeks (Nov 1 2026, Mar 14 2027) split at local midnight.
--   Start   client_weekly_delivery_standards: one row per client and
--           effective week, recorded as data (this migration adopts nobody
--           and opens no slot). start_date is the date Tom gives; the
--           effective week is the first Monday on or after it, and it may not
--           be in the past. FIRST WEEK: starts at the next Monday, never
--           pro-rated — a full week from its Monday; days before it carry no
--           weekly obligation and nothing is planned for them (no catch-up).
--           A weekly adoption needs the client's monthly adoption (v1), so
--           every existing reader that asks "is this client on a standard"
--           (the Wednesday beat, the 1st-of-month planner, the blog gate)
--           keeps answering yes without being rewritten.
--   Unit    each brand site of a multi-brand client, otherwise the client
--           (as v1). Business Profile locations are destinations, not units:
--           a site with two locations still gets 5 GBP posts a week, split
--           across them.
--   GBP     at most delivery_standards.gbp_daily_location_cap posts (v2: 1)
--           per Business Profile location per Chicago day, counting posts and
--           open slots. The planner spreads every site's GBP slots over the
--           week's free (location, day) cells, sites in rotating round-robin.
--           Slots that find no free cell are still opened (the target is not
--           silently dropped) and social_slot_readiness reports them
--           "Over capacity", so they are never queued or drafted. A three-site
--           client on one location: 15 wanted, 7 placed, 8 over capacity a week.
--   Month   delivery_targets(): for a month the weekly standard governs (its
--           first effective week starts before the month ends), the target
--           is the sum of each day's share of its week's target (the weekly
--           count's standard days in the order Mon, Wed, Fri, Tue, Thu, Sat,
--           Sun: 5 → Mon–Fri, 3 → Mon/Wed/Fri), so a week that crosses a
--           month splits by date and a year adds up to exactly 52/53 weeks.
--           Days of the transition month before the first effective week
--           keep v1's monthly count pro-rated by weekdays. Refreshes stay
--           monthly. Every other client gets the v1 rows byte for byte
--           (the previous function, renamed delivery_targets_monthly).
--   Gate    blog_publication_has_room is unchanged: it reads
--           delivery_targets(), so its month ceiling is now the sum of the
--           month's weekly blog targets for weekly clients.
--
-- Reconciliation of v1 data (no double credit):
--   * A slot with a post or article attached (draft, in review, approved,
--     scheduled, published) is kept and the work counts once, in the week of
--     its date. A published post counts on its publication date: the four
--     pilot posts published Oct 29 2026 from Nov 3 slots count in the week of
--     Oct 26 and their November slots carry no credit.
--   * v1 slots (opened by the monthly planner) dated on or after the first
--     effective week with nothing attached — no post, article, draft,
--     delivered mark or open task — are RETIRED when the weekly planner first
--     runs for the client: hold 'blocked' with a "Retired" reason (so every
--     existing gate already skips them), retired_at stamped, the previous
--     hold kept in retired_hold / retired_hold_reason. Never deleted.
--   * delivery_week_report() is the read-only reconciliation: per client,
--     site, week and deliverable the target, credited work, open slots, the
--     v1 slots that are / would be retired and GBP over-capacity, for adopted
--     clients or as a preview for a start week passed as a parameter.
--
-- Scheduling: one new pg_cron job, delivery-standard-week (Mondays 10:00 UTC,
-- 04:00/05:00 Chicago), runs plan_delivery_weeks(), which plans the current
-- and next week for clients with a weekly adoption only — none today. The
-- existing jobs keep their definitions: delivery-standard-month and
-- weekly-blog-posts call plan_delivery_month(), which for a weekly client's
-- month plans that month's weeks (Mondays in the month, from the current
-- week) instead of monthly slots; for everyone else it is unchanged.
-- Drafting stays behind the readiness gates (brand board / site guidance,
-- verified destination, approved core keyword list) and publishing behind
-- Tom's approval, the publisher switch and the holds, all untouched.

-- ── 1. Standards carry their cadence ───────────────────────────────────────
alter table delivery_standards
  add column cadence text not null default 'monthly' check (cadence in ('monthly', 'weekly')),
  add column gbp_daily_location_cap integer check (gbp_daily_location_cap between 1 and 10),
  add constraint delivery_standards_cadence_shape check ((cadence = 'weekly') = (gbp_daily_location_cap is not null));
comment on column delivery_standards.cadence is
  'monthly: blog_posts / facebook_posts / gbp_posts / page_refreshes per calendar month. weekly: blog_posts / facebook_posts / gbp_posts per Monday–Sunday week, page_refreshes still per month.';
comment on column delivery_standards.gbp_daily_location_cap is
  'Weekly standards: at most this many Business Profile posts per location per America/Chicago day.';

-- Standard 2: Tom's decision of Oct 29 2026 (work order "weekly delivery
-- calendar"). Recorded here as v1 was; no client adopts it here.
insert into delivery_standards (version, cadence, blog_posts, facebook_posts, gbp_posts, page_refreshes, gbp_daily_location_cap,
  exclusions, exclusion_reason, review_trigger, source_ref, decided_by, decided_at)
values (2, 'weekly', 3, 5, 5, 1, 1, array['instagram', 'new_pages', 'linkedin', 'x', 'tiktok'],
  'Social is Facebook only for now. New page creation is not in the standard; a refresh updates an existing page.',
  'Tom changes the cadence, the channel or deliverable standard, or the per-location daily cap.',
  'work_order:weekly-delivery-standard (Tom, Oct 29 2026: per website per week 5 Facebook, 5 GBP, 3 blogs; 1 refresh per month)',
  'Tom', '2026-10-29 12:00:00 America/Chicago');

-- A monthly adoption names a monthly standard.
create function client_delivery_standards_monthly() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (select cadence from delivery_standards where id = new.standard_id) is distinct from 'monthly' then
    raise exception 'A monthly adoption names a monthly standard; record a weekly one in client_weekly_delivery_standards.' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function client_delivery_standards_monthly() from public, anon, authenticated;
create trigger client_delivery_standards_monthly before insert on client_delivery_standards
  for each row execute function client_delivery_standards_monthly();

-- ── 2. Dates ────────────────────────────────────────────────────────────────
-- Today in America/Chicago. A superuser session (the sandbox) may pin it with
-- compass.delivery_today; nobody else can move the clock.
create function delivery_today() returns date
language sql stable set search_path = public, pg_catalog as $$
  select case when coalesce((select rolsuper from pg_roles where rolname = session_user), false)
                   and nullif(current_setting('compass.delivery_today', true), '') is not null
              then current_setting('compass.delivery_today', true)::date
              else (now() at time zone 'America/Chicago')::date end
$$;
revoke all on function delivery_today() from public, anon;
grant execute on function delivery_today() to authenticated, service_role;

create function delivery_week_start(p_date date) returns date
language sql immutable set search_path = pg_catalog as $$ select p_date - (extract(isodow from p_date)::int - 1) $$;
create function delivery_next_monday(p_date date) returns date
language sql immutable set search_path = pg_catalog as $$
  select p_date + ((8 - extract(isodow from p_date)::int) % 7) $$;
-- How many of a weekly count land on this date: the count's standard days in
-- the order Mon, Wed, Fri, Tue, Thu, Sat, Sun (5 → Mon–Fri, 3 → Mon/Wed/Fri),
-- cycling past seven.
create function delivery_daily_target(p_weekly integer, p_date date) returns integer
language sql immutable set search_path = pg_catalog as $$
  select count(*)::int from generate_series(1, greatest(coalesce(p_weekly, 0), 0)) k
  where (array[1, 3, 5, 2, 4, 6, 7])[((k - 1) % 7) + 1] = extract(isodow from p_date)::int
$$;
-- Rank of a weekday in that order (1 = Monday … 7 = Sunday).
create function delivery_day_rank(p_date date) returns integer
language sql immutable set search_path = pg_catalog as $$
  select array_position(array[1, 3, 5, 2, 4, 6, 7], extract(isodow from p_date)::int) $$;
revoke all on function delivery_week_start(date), delivery_next_monday(date), delivery_daily_target(integer, date),
  delivery_day_rank(date) from public, anon;
grant execute on function delivery_week_start(date), delivery_next_monday(date), delivery_daily_target(integer, date),
  delivery_day_rank(date) to authenticated, service_role;

-- ── 3. Weekly adoptions ─────────────────────────────────────────────────────
create table client_weekly_delivery_standards (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  standard_id uuid not null references delivery_standards(id),
  start_date date not null,
  effective_week date not null check (extract(isodow from effective_week) = 1),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 2000),
  recorded_by uuid references team_members(id),
  recorded_at timestamptz not null default now(),
  unique (client_id, effective_week)
);
comment on table client_weekly_delivery_standards is
  'Weekly delivery standard adoptions: from effective_week (the first Monday on or after start_date, never in the past) the client works to the weekly standard. Append-only.';
create index client_weekly_delivery_standards_standard_idx on client_weekly_delivery_standards(standard_id);
alter table client_weekly_delivery_standards enable row level security;
create policy "team client weekly delivery standards" on client_weekly_delivery_standards to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on client_weekly_delivery_standards from public, anon, authenticated;
grant select, insert on client_weekly_delivery_standards to authenticated, service_role;

create function client_weekly_delivery_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Weekly adoptions are history; record a new effective week.' using errcode = '23514';
  end if;
  if (select cadence from delivery_standards where id = new.standard_id) is distinct from 'weekly' then
    raise exception 'A weekly adoption names a weekly standard.' using errcode = '23514';
  end if;
  if new.start_date is null or new.start_date < delivery_today() then
    raise exception 'The weekly standard starts today or later (no retroactive weeks); % is in the past.', new.start_date
      using errcode = '23514';
  end if;
  -- The first week is a full week from its Monday: a mid-week start date
  -- waits for the next Monday.
  new.effective_week := delivery_next_monday(new.start_date);
  if not exists (select 1 from client_delivery_standards c where c.client_id = new.client_id
                  and c.effective_month <= date_trunc('month', new.effective_week)::date) then
    raise exception 'Adopt the monthly standard first (client_delivery_standards); the weekly standard replaces its targets from the effective week.'
      using errcode = '23514';
  end if;
  new.recorded_by := (select id from team_members where auth_user_id = auth.uid());
  new.recorded_at := now();
  return new;
end $$;
revoke all on function client_weekly_delivery_guard() from public, anon, authenticated;
create trigger client_weekly_delivery_guard before insert or update or delete on client_weekly_delivery_standards
  for each row execute function client_weekly_delivery_guard();

-- The weekly standard for the week containing p_date, or a row of nulls.
create function client_weekly_delivery_standard(p_client_id uuid, p_date date)
returns delivery_standards
language sql stable security invoker set search_path = public, pg_temp as $$
  select s.* from client_weekly_delivery_standards c join delivery_standards s on s.id = c.standard_id
  where c.client_id = p_client_id and c.effective_week <= delivery_week_start(p_date)
  order by c.effective_week desc limit 1
$$;
-- The client's first weekly week, or null.
create function client_weekly_first_week(p_client_id uuid) returns date
language sql stable security invoker set search_path = public, pg_temp as $$
  select min(effective_week) from client_weekly_delivery_standards where client_id = p_client_id
$$;
revoke all on function client_weekly_delivery_standard(uuid, date), client_weekly_first_week(uuid) from public, anon;
grant execute on function client_weekly_delivery_standard(uuid, date), client_weekly_first_week(uuid) to authenticated, service_role;

-- ── 4. Plan slots know their week; v1 slots can be retired ─────────────────
alter table content_plan_items
  add column standard_week date check (standard_week is null or extract(isodow from standard_week) = 1),
  add column standard_week_seq integer check (standard_week_seq is null or standard_week_seq > 0),
  add column retired_at timestamptz,
  add column retired_hold text,
  add column retired_hold_reason text,
  add constraint content_plan_items_standard_week_shape check (
    (standard_week is null or standard_key in ('blog_posts', 'facebook_posts', 'gbp_posts'))
    and (standard_week_seq is null or standard_week is not null)
    and (retired_at is null or hold = 'blocked'));
comment on column content_plan_items.standard_week is
  'Set on slots the weekly standard opened: the Monday of the slot''s week (follows planned_date). standard_week_seq numbers them per site, deliverable and week.';
comment on column content_plan_items.retired_at is
  'A monthly (v1) slot superseded by the weekly standard with nothing attached: held blocked with a Retired reason, kept as history. retired_hold / retired_hold_reason keep what it held before.';
create unique index content_plan_items_standard_week_slot on content_plan_items
  (client_id, coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), standard_key, standard_week, standard_week_seq)
  where standard_week_seq is not null;

-- After content_plan_items_standard (trigger names fire in order). A weekly
-- slot moved to another week or site becomes that week's hand-planned slot;
-- a retired slot whose hold a teammate clears counts again.
create function content_plan_items_standard_week() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare w date;
begin
  if new.standard_week is not null then
    w := delivery_week_start(coalesce(new.planned_date, new.week_start));
    if tg_op = 'UPDATE' and (old.standard_week, old.brand_workspace_id, old.standard_key)
                            is distinct from (w, new.brand_workspace_id, new.standard_key) then
      new.standard_week_seq := null;
    end if;
    new.standard_week := w;
  end if;
  if tg_op = 'UPDATE' and old.retired_at is not null and new.hold is distinct from 'blocked' then
    new.retired_at := null;
  end if;
  return new;
end $$;
revoke all on function content_plan_items_standard_week() from public, anon, authenticated;
create trigger content_plan_items_standard_week before insert or update on content_plan_items
  for each row execute function content_plan_items_standard_week();

-- A v1 slot the weekly standard may retire: opened by the monthly planner,
-- dated in or after p_first_week, and nothing attached — no post, article,
-- draft, delivered mark or unfinished task naming it.
create function delivery_v1_slot_retirable(p_plan_item_id uuid, p_first_week date) returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select exists (
    select 1 from content_plan_items i
    where i.id = p_plan_item_id and p_first_week is not null
      and i.standard_key in ('blog_posts', 'facebook_posts', 'gbp_posts')
      and i.standard_seq is not null and i.standard_week is null and i.retired_at is null
      and coalesce(i.planned_date, i.week_start) >= p_first_week
      and i.social_post_id is null and i.content_post_id is null and i.hold is distinct from 'delivered'
      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)
      and not exists (select 1 from tasks t where t.client_id = i.client_id and t.status <> 'done'
                        and (t.key = 'social_slot:' || i.id::text
                             or (t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%'))))
$$;
revoke all on function delivery_v1_slot_retirable(uuid, date) from public, anon;
grant execute on function delivery_v1_slot_retirable(uuid, date) to authenticated, service_role;

-- ── 5. Every item, dated ────────────────────────────────────────────────────
-- Blog, Facebook and Business Profile work of a client dated p_from..p_through
-- (America/Chicago), once each:
--   post          a Facebook / GBP post, not rejected. Date: published_at if
--                 published; else the slot it fills; else scheduled / created.
--   content_post  a Compass article. Date: published_at if published; else
--                 the slot it fills (directly or through its draft); else due.
--   slot          a blog / GBP / Facebook plan slot with nothing attached
--                 (a draft without a final article still leaves it a slot).
--                 done = held 'delivered'; retired = superseded v1 slot.
-- Unit: the brand site owning the item's service, else the slot's brand site.
create function delivery_items(p_client_id uuid, p_from date, p_through date)
returns table (
  client_id uuid, unit_kind text, brand_workspace_id uuid, deliverable text, item_date date, week_start date,
  done boolean, kind text, plan_item_id uuid, social_post_id uuid, content_post_id uuid,
  social_account_id uuid, blocked boolean, retired boolean, created_at timestamptz
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with owner as (
    select w.id as bid, unnest(w.service_ids) as service_id from client_brand_workspaces w where w.client_id = p_client_id
  ),
  raw as (
    select sp.service_id, i.brand_workspace_id as slot_bid,
           case sp.platform::text when 'facebook' then 'facebook_posts' else 'gbp_posts' end as deliverable,
           case when sp.publish_status = 'published'
                  then (coalesce(sp.published_at, sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date
                when i.id is not null then coalesce(i.planned_date, i.week_start)
                else (coalesce(sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date end as d,
           sp.publish_status = 'published' as done, 'post'::text as kind, i.id as plan_item_id, sp.id as social_post_id,
           null::uuid as content_post_id, sp.social_account_id, false as blocked, false as retired, sp.created_at
    from social_posts sp left join content_plan_items i on i.social_post_id = sp.id
    where sp.client_id = p_client_id and sp.platform::text in ('facebook', 'google_business') and sp.review_status <> 'rejected'
    union all
    select k.service_id, i.brand_workspace_id, 'blog_posts',
           case when cp.status = 'published' then coalesce(cp.published_at, cp.due_date)
                when i.id is not null then coalesce(i.planned_date, i.week_start)
                else coalesce(cp.due_date, cp.published_at) end,
           cp.status = 'published', 'content_post', i.id, null, cp.id, null, false, false, null::timestamptz
    from content_posts cp
    left join keywords k on k.id = cp.keyword_id
    left join lateral (
      select x.id, x.brand_workspace_id, x.planned_date, x.week_start from content_plan_items x where x.content_post_id = cp.id
      union all
      select x.id, x.brand_workspace_id, x.planned_date, x.week_start
      from content_drafts d join content_plan_items x on x.id = d.plan_item_id where d.final_content_post_id = cp.id
      limit 1) i on true
    where cp.client_id = p_client_id and cp.origin = 'compass'
    union all
    select pi.service_id, pi.brand_workspace_id,
           case pi.deliverable when 'blog' then 'blog_posts' when 'gbp' then 'gbp_posts' else 'facebook_posts' end,
           coalesce(pi.planned_date, pi.week_start), pi.hold is not distinct from 'delivered', 'slot', pi.id, null, null,
           pi.gbp_location_id, pi.hold is not distinct from 'blocked', pi.retired_at is not null, pi.created_at
    from content_plan_items pi
    where pi.client_id = p_client_id
      and (pi.deliverable in ('blog', 'gbp') or (pi.deliverable = 'social' and pi.channel::text = 'facebook'))
      and pi.social_post_id is null and pi.content_post_id is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = pi.id and d.final_content_post_id is not null)
  )
  select p_client_id,
         case when coalesce(o.bid, r.slot_bid) is not null then 'brand'
              when exists (select 1 from client_brand_workspaces w where w.client_id = p_client_id) then 'unattributed'
              else 'client' end,
         coalesce(o.bid, r.slot_bid), r.deliverable, r.d, delivery_week_start(r.d),
         r.done, r.kind, r.plan_item_id, r.social_post_id, r.content_post_id, r.social_account_id, r.blocked, r.retired, r.created_at
  from raw r left join owner o on o.service_id = r.service_id
  where r.d between p_from and p_through
$$;
revoke all on function delivery_items(uuid, date, date) from public, anon;
grant execute on function delivery_items(uuid, date, date) to authenticated, service_role;

-- The client's verified Business Profile destinations (drafter_write's and
-- social_slot_readiness's rule), in the order they were verified.
create function delivery_gbp_locations(p_client_id uuid) returns uuid[]
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(sa.id order by sa.publish_verified_at, sa.id), '{}') from social_accounts sa
  where sa.client_id = p_client_id and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
    and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
    and sa.publish_verified_at is not null
    and exists (select 1 from publisher_client_transports t where t.client_id = p_client_id and t.gbp_transport = 'zernio')
$$;
revoke all on function delivery_gbp_locations(uuid) from public, anon;
grant execute on function delivery_gbp_locations(uuid) to authenticated, service_role;

-- ── 6. The collision rule ───────────────────────────────────────────────────
-- null, or why this open GBP slot cannot go to p_account_id on its day: the
-- weekly standard allows gbp_daily_location_cap posts per location per day,
-- and the location's earlier occupants that day (posts first, then open
-- slots in the order they were opened) already fill it. Only weeks a weekly
-- adoption governs are judged; every other slot answers null.
create function gbp_slot_capacity_problem(p_plan_item_id uuid, p_account_id uuid) returns text
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare i content_plan_items; std delivery_standards; locs uuid[]; pos int; loc_name text;
begin
  select * into i from content_plan_items where id = p_plan_item_id;
  if i.id is null or i.deliverable <> 'gbp' or p_account_id is null or i.social_post_id is not null
     or i.hold is not null or i.planned_date is null then
    return null;
  end if;
  std := client_weekly_delivery_standard(i.client_id, i.planned_date);
  if std.id is null then return null; end if;
  locs := delivery_gbp_locations(i.client_id);
  select n into pos from (
    select x.plan_item_id, x.kind, row_number() over (
             order by (x.kind = 'slot'), x.created_at, (select s.standard_week_seq from content_plan_items s where s.id = x.plan_item_id),
                      coalesce(x.plan_item_id, x.social_post_id)) as n
    from delivery_items(i.client_id, i.planned_date, i.planned_date) x
    where x.deliverable = 'gbp_posts' and not x.retired
      and ((x.kind = 'post' and x.social_account_id = p_account_id)
        or (x.kind = 'slot' and not x.blocked
            and coalesce(x.social_account_id, case when cardinality(locs) = 1 then locs[1] end) = p_account_id))
  ) o where o.kind = 'slot' and o.plan_item_id = i.id;
  if pos is null or pos <= std.gbp_daily_location_cap then return null; end if;
  select coalesce(nullif(btrim(publish_account_name), ''), display_name, publish_page_id) into loc_name
    from social_accounts where id = p_account_id;
  return left(format('Over capacity: %s already has %s Business Profile post(s) planned on %s (weekly standard v%s: at most %s per location per day). Move it to a free day, add a location, or record a new standard.',
                     coalesce(loc_name, 'this location'), std.gbp_daily_location_cap, to_char(i.planned_date, 'Dy Mon FMDD'),
                     std.version, std.gbp_daily_location_cap), 300);
end $$;
revoke all on function gbp_slot_capacity_problem(uuid, uuid) from public, anon;
grant execute on function gbp_slot_capacity_problem(uuid, uuid) to authenticated, service_role;

-- Readiness reports it (after brand and destination, before the core list),
-- so an over-capacity slot is never queued, claimed or linked. A slot of a
-- client without a weekly adoption gets null: unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure);
  anchor text := $a$    when d.account_id is null then 'No verified Business Profile location is bound for this client.'
$a$;
  clause text := $c$    -- weekly_gbp_capacity_v1 (20261030180000): one post per location per day.
    when s.standard_key = 'gbp_posts' and gbp_slot_capacity_problem(s.id, d.account_id) is not null
      then gbp_slot_capacity_problem(s.id, d.account_id)
$c$;
begin
  if strpos(definition, 'weekly_gbp_capacity_v1') > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor)
     or strpos(definition, 'site_ok as materialized') = 0 then
    raise exception 'Unexpected social_slot_readiness definition; review before applying the weekly GBP capacity rule';
  end if;
  execute replace(definition, anchor, anchor || clause);
end;
$migration$;

-- ── 7. Monthly targets that understand the weekly standard ──────────────────
-- The previous function, unchanged, under a new name: every client the
-- weekly standard does not govern for the month is answered by it.
alter function delivery_targets(uuid, date) rename to delivery_targets_monthly;
comment on function delivery_targets_monthly(uuid, date) is
  'The v1 monthly computation (20261015150000, 20261027190935), unchanged. delivery_targets() answers with it for every client-month the weekly standard does not govern.';

-- A weekly client's month target for one deliverable and unit: each day's
-- share of its week's target from the first effective week on; v1's monthly
-- count pro-rated by weekdays for the days of the month before it.
create function delivery_weekly_month_target(p_client_id uuid, p_deliverable text, p_month date) returns integer
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  m date := date_trunc('month', p_month)::date;
  m_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  first_week date := client_weekly_first_week(p_client_id);
  v1 delivery_standards; std delivery_standards; d date; t int := 0; pre int; all_wd int; n int;
begin
  if first_week is null or first_week >= m_end then return null; end if;
  for d in select x::date from generate_series(greatest(m, first_week), m_end - 1, interval '1 day') x loop
    std := client_weekly_delivery_standard(p_client_id, d);
    n := case p_deliverable when 'blog_posts' then std.blog_posts when 'facebook_posts' then std.facebook_posts
                            when 'gbp_posts' then std.gbp_posts end;
    t := t + delivery_daily_target(n, d);
  end loop;
  if first_week > m then
    v1 := client_delivery_standard(p_client_id, m);
    select count(*) filter (where x < first_week), count(*) into pre, all_wd
      from generate_series(m, m_end - 1, interval '1 day') x where extract(isodow from x) < 6;
    n := case p_deliverable when 'blog_posts' then v1.blog_posts when 'facebook_posts' then v1.facebook_posts
                            when 'gbp_posts' then v1.gbp_posts end;
    t := t + coalesce(round(coalesce(n, 0)::numeric * pre / nullif(all_wd, 0))::int, 0);
  end if;
  return t;
end $$;
revoke all on function delivery_weekly_month_target(uuid, text, date) from public, anon;
grant execute on function delivery_weekly_month_target(uuid, text, date) to authenticated, service_role;

create function delivery_targets(p_client_id uuid default null, p_month date default null)
returns table (
  client_id uuid, month date, unit_kind text, brand_workspace_id uuid, unit_name text, deliverable text,
  target integer, completed integer, planned integer, used integer, remaining integer, over_target integer,
  unverified integer, destination text, standard_version integer, source_ref text
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with mon as (select * from delivery_targets_monthly(p_client_id, p_month)),
  b as (select m.month as m_start, (m.month + interval '1 month')::date as m_end from mon m limit 1),
  wk as (
    select c.client_id, s.version, s.source_ref, s.page_refreshes
    from (select distinct client_id from mon) c cross join b
    cross join lateral (select * from client_weekly_delivery_standard(c.client_id, b.m_end - 1)) s
    where s.id is not null and client_weekly_first_week(c.client_id) < b.m_end
  ),
  items as (
    select x.* from wk cross join b
    cross join lateral delivery_items(wk.client_id, b.m_start, b.m_end - 1) x
    where not x.retired
  ),
  counts as (
    select i.client_id, i.unit_kind, i.brand_workspace_id, i.deliverable,
           count(*) filter (where i.done)::int as completed, count(*) filter (where not i.done)::int as planned
    from items i group by 1, 2, 3, 4
  ),
  weekly as (
    select m.client_id, m.month, m.unit_kind, m.brand_workspace_id, m.unit_name, m.deliverable,
           case when m.unit_kind = 'unattributed' then 0
                when m.deliverable = 'page_refreshes' then wk.page_refreshes
                else delivery_weekly_month_target(m.client_id, m.deliverable, m.month) end as target,
           case when m.deliverable = 'page_refreshes' then m.completed else coalesce(c.completed, 0) end as completed,
           case when m.deliverable = 'page_refreshes' then m.planned else coalesce(c.planned, 0) end as planned,
           m.unverified, m.destination, wk.version, wk.source_ref
    from mon m join wk on wk.client_id = m.client_id
    left join counts c on c.client_id = m.client_id and c.deliverable = m.deliverable
      and c.unit_kind = m.unit_kind and c.brand_workspace_id is not distinct from m.brand_workspace_id
  )
  select m.* from mon m where m.client_id not in (select client_id from wk)
  union all
  select w.client_id, w.month, w.unit_kind, w.brand_workspace_id, w.unit_name, w.deliverable, w.target,
         w.completed, w.planned, w.completed + w.planned,
         greatest(w.target - w.completed - w.planned, 0), greatest(w.completed + w.planned - w.target, 0),
         w.unverified, w.destination, w.version, w.source_ref
  from weekly w
$$;
revoke all on function delivery_targets(uuid, date) from public, anon;
grant execute on function delivery_targets(uuid, date) to authenticated, service_role;
comment on function delivery_targets(uuid, date) is
  'Delivery standard per brand site (or client) and month. Clients the weekly standard governs that month: targets are the sum of the month''s days'' share of each week''s target (refresh monthly), work counted by item date. Everyone else: delivery_targets_monthly, unchanged. Operational only; never reads billing.';

-- ── 8. The weekly planner ───────────────────────────────────────────────────
-- Opens the week's missing slots for each site and deliverable: what the
-- week's target still has room for once the work and slots already dated in
-- the week are counted, never more than the target of the days left in the
-- week (today on; a past day is never planned, a past week never touched),
-- so there is no catch-up. Before that, the client's unattached v1 slots
-- from the first effective week on are retired (once). Blogs and Facebook
-- posts go to the standard days (Mon/Wed/Fri, Mon–Fri) a site has free;
-- Business Profile posts to free (location, day) cells, every site of the
-- client in rotating round-robin, locations balanced; a GBP slot with no
-- free cell is still opened on its site's least-used day and readiness
-- calls it over capacity. Reruns open nothing more. Nothing is drafted,
-- scheduled or published.
create function plan_delivery_week(p_client_id uuid, p_week date default null) returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  today date := delivery_today();
  w date := delivery_week_start(coalesce(p_week, delivery_today()));
  first_day date;
  first_week date := client_weekly_first_week(p_client_id);
  std delivery_standards;
  multi boolean;
  units uuid[]; names text[]; nu int; rot int;
  locs uuid[]; nl int; cap int;
  dk text; n int; label text; v_deliv text; v_channel social_platform; v_purpose text;
  room int[]; ucount int[]; occ int[]; lload int[];
  u int; r int; k int; k2 int; j int; best_d int; best_l int; best_key numeric; key numeric;
  existing int; dayroom int; nxt int; made int := 0; got int; d date;
begin
  if p_client_id is null then raise exception 'Choose a client' using errcode = '22023'; end if;
  std := client_weekly_delivery_standard(p_client_id, w);
  if std.id is null then return 0; end if;
  first_day := greatest(w, today);
  if first_day > w + 6 then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-plan:' || p_client_id::text || ':' || w::text, 0));

  -- Retire the unattached v1 slots the weekly standard supersedes.
  update content_plan_items i
     set retired_at = now(), retired_hold = i.hold, retired_hold_reason = i.hold_reason, hold = 'blocked',
         hold_reason = left('Retired: superseded by weekly delivery standard v' || std.version || ' from the week of '
                            || to_char(first_week, 'Mon FMDD, YYYY') || '. Kept as history; nothing was attached.', 500)
   where i.client_id = p_client_id and delivery_v1_slot_retirable(i.id, first_week);

  multi := exists (select 1 from client_brand_workspaces where client_id = p_client_id);
  if multi then
    select array_agg(x.id order by x.name, x.id), array_agg(x.name order by x.name, x.id) into units, names
      from client_brand_workspaces x where x.client_id = p_client_id;
  else
    units := array[null::uuid]; names := array[(select name from clients where id = p_client_id)];
  end if;
  nu := cardinality(units);
  rot := (extract(week from w)::int) % nu;   -- rotate who goes first, week by week

  for dk in select unnest(array['blog_posts', 'facebook_posts', 'gbp_posts']) loop
    n := case dk when 'blog_posts' then std.blog_posts when 'facebook_posts' then std.facebook_posts else std.gbp_posts end;
    continue when coalesce(n, 0) = 0;
    v_deliv := case dk when 'blog_posts' then 'blog' when 'facebook_posts' then 'social' else 'gbp' end;
    v_channel := case dk when 'facebook_posts' then 'facebook'::social_platform when 'gbp_posts' then 'google_business'::social_platform end;
    v_purpose := case dk when 'gbp_posts' then 'service' else 'educational' end;
    label := case dk when 'blog_posts' then 'Blog' when 'facebook_posts' then 'Facebook post' else 'Business Profile post' end;
    select sum(delivery_daily_target(n, x::date))::int into dayroom from generate_series(first_day, w + 6, interval '1 day') x;

    -- Room per site, and each site's items per weekday (index 1..7 = Mon..Sun).
    room := array_fill(0, array[nu]); ucount := array_fill(0, array[nu * 7]);
    for u in 1..nu loop
      select count(*) into existing from delivery_items(p_client_id, w, w + 6) x
       where x.deliverable = dk and not x.retired and x.brand_workspace_id is not distinct from units[u]
         and x.unit_kind <> 'unattributed';
      room[u] := greatest(0, least(n - existing, dayroom));
      for j in 1..7 loop
        ucount[(u - 1) * 7 + j] := (select count(*) from delivery_items(p_client_id, w + j - 1, w + j - 1) x
          where x.deliverable = dk and not x.retired and x.brand_workspace_id is not distinct from units[u]
            and x.unit_kind <> 'unattributed');
      end loop;
    end loop;
    continue when (select coalesce(sum(v), 0) from unnest(room) v) = 0;

    -- GBP cells: (location, day) occupancy from posts and open slots.
    if dk = 'gbp_posts' then
      locs := delivery_gbp_locations(p_client_id); nl := cardinality(locs); cap := std.gbp_daily_location_cap;
      if nl = 0 then locs := array[null::uuid]; nl := 1; cap := null; end if;
      occ := array_fill(0, array[nl * 7]); lload := array_fill(0, array[nl]);
      for k in 1..nl loop
        for j in 1..7 loop
          occ[(k - 1) * 7 + j] := (select count(*) from delivery_items(p_client_id, w + j - 1, w + j - 1) x
            where x.deliverable = 'gbp_posts' and not x.retired and not x.blocked
              and coalesce(x.social_account_id, case when nl = 1 then locs[1] end) is not distinct from locs[k]);
          lload[k] := lload[k] + occ[(k - 1) * 7 + j];
        end loop;
      end loop;
    end if;

    -- Round-robin: round r gives each site (rotated order) its r-th slot.
    for r in 1..(select max(v) from unnest(room) v) loop
      for k in 0..nu - 1 loop
        u := ((k + rot) % nu) + 1;
        continue when room[u] < r;
        best_d := null; best_l := 1; best_key := null;
        if dk = 'gbp_posts' then
          -- A free cell: the site's least-used day, standard-day order, then
          -- the least-loaded location.
          for j in 1..7 loop
            continue when w + j - 1 < first_day;
            for k2 in 1..nl loop
              continue when cap is not null and occ[(k2 - 1) * 7 + j] >= cap;
              key := ucount[(u - 1) * 7 + j] * 10000 + delivery_day_rank(w + j - 1) * 100
                     + lload[k2] * 10 + ((k2 - 1 + extract(week from w)::int) % nl);
              if best_key is null or key < best_key then best_key := key; best_d := j; best_l := k2; end if;
            end loop;
          end loop;
        end if;
        if best_d is null then
          -- Blogs and Facebook posts, or a GBP slot with no free cell (over
          -- capacity): the site's least-used day in standard-day order.
          for j in 1..7 loop
            continue when w + j - 1 < first_day;
            key := ucount[(u - 1) * 7 + j] * 10000 + delivery_day_rank(w + j - 1) * 100;
            if best_key is null or key < best_key then best_key := key; best_d := j; end if;
          end loop;
          if dk = 'gbp_posts' then
            best_l := 1;
            for k2 in 2..nl loop
              if lload[k2] < lload[best_l] then best_l := k2; end if;
            end loop;
          end if;
        end if;
        d := w + best_d - 1;
        select coalesce(max(standard_week_seq), 0) + 1 into nxt from content_plan_items c
         where c.client_id = p_client_id and c.brand_workspace_id is not distinct from units[u]
           and c.standard_key = dk and c.standard_week = w;
        insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, planned_date, notes,
                                        brand_workspace_id, standard_key, standard_month, standard_week, standard_week_seq, gbp_location_id)
        values (p_client_id, w, v_deliv, v_channel, v_purpose,
                left(label || ' · ' || names[u] || ' · week of ' || to_char(w, 'Mon FMDD, YYYY'), 200), d,
                'Opened by the weekly delivery standard (v' || std.version || '). Set the topic, intent, service and keyword before drafting.',
                units[u], dk, date_trunc('month', d)::date, w, nxt,
                case when dk = 'gbp_posts' then locs[best_l] end)
        on conflict do nothing;
        get diagnostics got = row_count;
        made := made + got;
        ucount[(u - 1) * 7 + best_d] := ucount[(u - 1) * 7 + best_d] + 1;
        if dk = 'gbp_posts' then
          occ[(best_l - 1) * 7 + best_d] := occ[(best_l - 1) * 7 + best_d] + 1;
          lload[best_l] := lload[best_l] + 1;
        end if;
      end loop;
    end loop;
  end loop;
  return made;
end $$;
revoke all on function plan_delivery_week(uuid, date) from public, anon;
grant execute on function plan_delivery_week(uuid, date) to authenticated, service_role;

-- The Monday beat: this week and next, for clients with a weekly adoption.
create function plan_delivery_weeks() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; made int := 0; w date := delivery_week_start(delivery_today());
begin
  for c in select cl.id from clients cl where cl.status in ('active', 'launching')
      and client_weekly_first_week(cl.id) <= w + 7 order by cl.id loop
    made := made + plan_delivery_week(c.id, w) + plan_delivery_week(c.id, w + 7);
  end loop;
  return made;
end $$;
revoke all on function plan_delivery_weeks() from public, anon, authenticated, service_role;

-- plan_delivery_month() (the 1st-of-month cron, the Wednesday beat and the
-- planner's "Open this month's slots") plans a weekly client's month as its
-- weeks: every Monday in the month from the current week on. Other clients:
-- unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('public.plan_delivery_month(uuid,date)'::regprocedure);
  anchor text := $a$  first_day := greatest(m, today);
$a$;
  block text := $b$  -- weekly_delivery_v1 (20261030180000): a month the weekly standard governs is planned week by week.
  if client_weekly_first_week(p_client_id) < m_end then
    for d in select x::date from generate_series(greatest(delivery_next_monday(m), delivery_week_start(delivery_today())), m_end - 1, interval '7 days') x loop
      made := made + plan_delivery_week(p_client_id, d);
    end loop;
    return made;
  end if;
$b$;
begin
  if strpos(definition, 'weekly_delivery_v1') > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected plan_delivery_month definition; review before applying the weekly standard';
  end if;
  execute replace(definition, anchor, block || anchor);
end;
$migration$;

select cron.schedule('delivery-standard-week', '0 10 * * 1', 'select public.plan_delivery_weeks()');

-- ── 9. The reconciliation report (read-only) ────────────────────────────────
-- Per client on a standard, site, week (Monday) and deliverable:
--   standard        'weekly v2' (adopted), 'preview v2' (p_preview_week, no
--                   adoption), 'before weekly' (an earlier week) or 'monthly'.
--   target          the week's target (0 before the first weekly week).
--   credited        work attached in the week: posts / articles in any state
--                   but rejected, and slots marked delivered; published is
--                   the published part.
--   open_slots      unattached slots that stay (not retired, not retiring).
--   v1_retiring     unattached v1 slots in a weekly week that the planner
--                   retires on its next run (or would, for a preview).
--   v1_retired      v1 slots already retired.
--   over_capacity   open GBP slots readiness reports over capacity (adopted
--                   weeks).
--   gbp_overflow    GBP rows: the client's projected over-capacity for the
--                   week once every site's remaining GBP slots are opened
--                   (same figure on each GBP row of the client-week).
--   remaining       what the planner would still open (target − credited −
--                   open slots, at least 0); over_target the excess.
create function delivery_week_report(p_client_id uuid default null, p_from date default null, p_through date default null,
                                     p_preview_week date default null)
returns table (
  client_id uuid, unit_kind text, brand_workspace_id uuid, unit_name text, week_start date, deliverable text, standard text,
  target integer, credited integer, published integer, open_slots integer, v1_retiring integer, v1_retired integer,
  over_capacity integer, gbp_overflow integer, remaining integer, over_target integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with rng as (
    select delivery_week_start(coalesce(p_from, delivery_today())) as w0,
           delivery_week_start(coalesce(p_through, coalesce(p_from, delivery_today()) + 35)) as w1
  ),
  cl as (
    select c.id as client_id, c.name,
           coalesce(client_weekly_first_week(c.id), delivery_next_monday(p_preview_week)) as first_week,
           client_weekly_first_week(c.id) is not null as adopted,
           (select s from delivery_standards s where s.cadence = 'weekly' order by s.version desc limit 1) as latest,
           cardinality(delivery_gbp_locations(c.id)) as nloc
    from clients c
    where (p_client_id is null or c.id = p_client_id)
      and (exists (select 1 from client_delivery_standards d where d.client_id = c.id)
           or exists (select 1 from client_weekly_delivery_standards d where d.client_id = c.id))
  ),
  weeks as (select x::date as w from rng, generate_series(rng.w0, rng.w1, interval '7 days') x),
  units as (
    select cl.client_id, 'brand'::text as unit_kind, ws.id as bid, ws.name as unit_name from cl join client_brand_workspaces ws on ws.client_id = cl.client_id
    union all
    select cl.client_id, 'client', null::uuid, cl.name from cl
     where not exists (select 1 from client_brand_workspaces ws where ws.client_id = cl.client_id)
    union all
    select cl.client_id, 'unattributed', null::uuid, 'Unattributed' from cl
     where exists (select 1 from client_brand_workspaces ws where ws.client_id = cl.client_id)
  ),
  items as (
    select x.*, cl.first_week,
           x.kind = 'slot' and not x.retired and not x.done and delivery_v1_slot_retirable(x.plan_item_id, cl.first_week) as retiring
    from cl cross join rng cross join lateral delivery_items(cl.client_id, rng.w0, rng.w1 + 6) x
  ),
  grid as (
    select u.*, wk.w, dk.deliverable, cl.first_week, cl.adopted, cl.nloc,
           case when cl.first_week is null or wk.w < cl.first_week then null
                when cl.adopted then client_weekly_delivery_standard(u.client_id, wk.w)
                else cl.latest end as std
    from units u join cl on cl.client_id = u.client_id cross join weeks wk
    cross join (values ('blog_posts'), ('facebook_posts'), ('gbp_posts')) dk(deliverable)
  ),
  rows as (
    select g.client_id, g.unit_kind, g.bid, g.unit_name, g.w, g.deliverable, g.nloc,
           case when g.first_week is null then 'monthly' when g.w < g.first_week then 'before weekly'
                when g.adopted then 'weekly v' || (g.std).version else 'preview v' || (g.std).version end as standard,
           case when g.unit_kind = 'unattributed' or g.std is null then 0
                else case g.deliverable when 'blog_posts' then (g.std).blog_posts when 'facebook_posts' then (g.std).facebook_posts
                                        else (g.std).gbp_posts end end as target,
           (g.std).gbp_daily_location_cap as cap,
           count(*) filter (where not i.retired and (i.kind <> 'slot' or i.done))::int as credited,
           count(*) filter (where i.done)::int as published,
           count(*) filter (where i.kind = 'slot' and not i.done and not i.retired and not i.retiring)::int as open_slots,
           count(*) filter (where i.retiring)::int as v1_retiring,
           count(*) filter (where i.retired)::int as v1_retired,
           count(*) filter (where i.kind = 'slot' and g.adopted and not i.retired
                                and gbp_slot_capacity_problem(i.plan_item_id,
                                      coalesce(i.social_account_id, case when g.nloc = 1 then (delivery_gbp_locations(g.client_id))[1] end)) is not null)::int as over_capacity
    from grid g
    left join items i on i.client_id = g.client_id and i.week_start = g.w and i.deliverable = g.deliverable
      and i.unit_kind = g.unit_kind and i.brand_workspace_id is not distinct from g.bid
    group by g.client_id, g.unit_kind, g.bid, g.unit_name, g.w, g.deliverable, g.nloc, g.first_week, g.adopted, g.std
  ),
  gbp as (
    -- Free (location, day) cells of the client-week after its kept posts and
    -- slots, against every site's remaining GBP need.
    select r.client_id, r.w,
           greatest(0, sum(greatest(r.target - r.credited - r.open_slots, 0))
                       - greatest(0, max(r.cap) * max(r.nloc) * 7 - sum(r.credited + r.open_slots)))::int as overflow
    from rows r where r.deliverable = 'gbp_posts' and r.cap is not null and r.nloc > 0
    group by r.client_id, r.w
  )
  select r.client_id, r.unit_kind, r.bid, r.unit_name, r.w, r.deliverable, r.standard, r.target, r.credited, r.published,
         r.open_slots, r.v1_retiring, r.v1_retired, r.over_capacity,
         case when r.deliverable = 'gbp_posts' then g.overflow end,
         greatest(r.target - r.credited - r.open_slots, 0), greatest(r.credited + r.open_slots - r.target, 0)
  from rows r left join gbp g on g.client_id = r.client_id and g.w = r.w
  order by r.client_id, case r.unit_kind when 'unattributed' then 1 else 0 end, r.unit_name, r.w, r.deliverable
$$;
revoke all on function delivery_week_report(uuid, date, date, date) from public, anon;
grant execute on function delivery_week_report(uuid, date, date, date) to authenticated, service_role;
comment on function delivery_week_report(uuid, date, date, date) is
  'Read-only weekly reconciliation: target, credited work, open slots, v1 slots retired / to retire and GBP over-capacity per client, site, week and deliverable. p_preview_week previews a start week for clients without a weekly adoption.';

-- ── 10. Postconditions ──────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from client_weekly_delivery_standards) then
    raise exception 'The migration adopts no client';
  end if;
  if exists (select 1 from content_plan_items where standard_week is not null or retired_at is not null) then
    raise exception 'The migration opens or retires no slot';
  end if;
  if strpos(pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure), 'weekly_gbp_capacity_v1') = 0
     or strpos(pg_get_functiondef('public.plan_delivery_month(uuid,date)'::regprocedure), 'weekly_delivery_v1') = 0 then
    raise exception 'readiness or the monthly planner was not updated';
  end if;
  if has_function_privilege('authenticated', 'public.plan_delivery_weeks()', 'execute')
     or has_function_privilege('service_role', 'public.plan_delivery_weeks()', 'execute')
     or has_function_privilege('anon', 'public.delivery_targets(uuid,date)', 'execute')
     or has_function_privilege('anon', 'public.delivery_week_report(uuid,date,date,date)', 'execute')
     or not has_function_privilege('authenticated', 'public.delivery_targets(uuid,date)', 'execute') then
    raise exception 'grants are not as reviewed';
  end if;
  if has_table_privilege('anon', 'public.client_weekly_delivery_standards', 'select')
     or has_table_privilege('authenticated', 'public.client_weekly_delivery_standards', 'update') then
    raise exception 'client_weekly_delivery_standards grants are not as reviewed';
  end if;
end $$;
