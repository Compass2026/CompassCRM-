-- Monthly delivery standard: the operational targets Compass works to each
-- calendar month, kept apart from the billing entitlements (0062).
--
--   Agreement → client_entitlements_for()   what was sold; agreements, the
--                                            portal and billing read it
--   Owner decision → delivery_standards      what the team delivers; the
--                                            planner, the weekly blog tasks
--                                            and the blog gate read it
--
-- Nothing here reads or writes plans, package_entitlements,
-- client_entitlement_overrides, agreement_contracts or any Stripe table, so
-- prices, issued agreement snapshots and signature status are untouched.
--
-- Unit: each brand site of a multi-brand client (client_brand_workspaces),
-- otherwise the client. A three-brand client gets three full allocations.
-- Work is attributed to a brand through its service (one owning brand per
-- service, 20261012163631) or, for a plan slot without one, the slot's
-- brand; refreshes through the site they name. Work that cannot be
-- attributed is reported on an "unattributed" row with target 0 and is never
-- credited to any brand.
--
-- Month: the America/Chicago calendar month (as 0062). Every item counts in
-- the month of its own date (planned date, publication, receipt), so a week
-- that crosses a month boundary splits by item.
--
-- Clients without an adoption row keep every pre-standard behaviour: the
-- 0062 agreement allowance at the blog gate and the client-level weekly
-- blog tasks (Lucas included).

create table delivery_standards (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  blog_posts integer not null check (blog_posts between 0 and 100),
  facebook_posts integer not null check (facebook_posts between 0 and 100),
  gbp_posts integer not null check (gbp_posts between 0 and 100),
  page_refreshes integer not null check (page_refreshes between 0 and 100),
  -- Channels and kinds of work deliberately outside the standard.
  exclusions text[] not null default '{}'
    check (exclusions <@ array['instagram', 'new_pages', 'linkedin', 'x', 'tiktok']::text[]),
  exclusion_reason text not null default '' check (length(exclusion_reason) <= 2000),
  review_trigger text not null default '' check (length(review_trigger) <= 2000),
  check (cardinality(exclusions) = 0 or (btrim(exclusion_reason) <> '' and btrim(review_trigger) <> '')),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 2000),
  decided_by text not null check (length(btrim(decided_by)) between 1 and 200),
  decided_at timestamptz not null,
  recorded_by uuid references team_members(id),
  recorded_at timestamptz not null default now()
);

-- A client works to a standard from a month on. Latest effective_month at or
-- before the month wins; no row means the client is not on a standard.
create table client_delivery_standards (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  standard_id uuid not null references delivery_standards(id),
  effective_month date not null check (extract(day from effective_month) = 1),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 2000),
  recorded_by uuid references team_members(id),
  recorded_at timestamptz not null default now(),
  unique (client_id, effective_month)
);
create index client_delivery_standards_standard_idx on client_delivery_standards(standard_id);

alter table delivery_standards enable row level security;
alter table client_delivery_standards enable row level security;
create policy "team delivery standards" on delivery_standards to authenticated
  using ((select is_team())) with check ((select is_team()));
create policy "team client delivery standards" on client_delivery_standards to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on delivery_standards, client_delivery_standards from public, anon, authenticated;
grant select, insert on delivery_standards, client_delivery_standards to authenticated;
grant select, insert on delivery_standards, client_delivery_standards to service_role;

-- Append-only history; the recorder is whoever is signed in (null for the
-- worker), never a caller-supplied id.
create function delivery_standard_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Delivery standards are history; record a new version or effective month.' using errcode = '23514';
  end if;
  new.recorded_by := (select id from team_members where auth_user_id = auth.uid());
  new.recorded_at := now();
  return new;
end $$;
revoke all on function delivery_standard_guard() from public, anon, authenticated;
create trigger delivery_standards_guard before insert or update or delete on delivery_standards
  for each row execute function delivery_standard_guard();
create trigger client_delivery_standards_guard before insert or update or delete on client_delivery_standards
  for each row execute function delivery_standard_guard();

-- Standard 1: Tom's decision, recorded in Executive OS on task
-- 367bdeba-7b52-4ce2-adbd-b98347499223 (decision message
-- 7251fd3a-1326-4a79-81c0-1b13afa69c0c). Clients adopt it by data, not here.
insert into delivery_standards (version, blog_posts, facebook_posts, gbp_posts, page_refreshes, exclusions,
  exclusion_reason, review_trigger, source_ref, decided_by, decided_at)
values (1, 8, 8, 8, 1, array['instagram', 'new_pages', 'linkedin', 'x', 'tiktok'],
  'Social is Facebook only for now. New page creation is not in the standard; a refresh updates an existing page.',
  'Tom changes the channel or deliverable standard.',
  'executive_os:task/367bdeba-7b52-4ce2-adbd-b98347499223#message/7251fd3a-1326-4a79-81c0-1b13afa69c0c',
  'Tom', '2026-10-14 21:39:00 America/Chicago');

-- The month's standard for a client, or a row of nulls.
create function client_delivery_standard(p_client_id uuid, p_month date)
returns delivery_standards
language sql stable security invoker set search_path = public, pg_temp as $$
  select s.* from client_delivery_standards c join delivery_standards s on s.id = c.standard_id
  where c.client_id = p_client_id
    and c.effective_month <= date_trunc('month', p_month)::date
  order by c.effective_month desc limit 1
$$;
revoke all on function client_delivery_standard(uuid, date) from public, anon;
grant execute on function client_delivery_standard(uuid, date) to authenticated, service_role;

-- ── Plan slots know their site and their place in the month ─────────────────
-- brand_workspace_id: the brand site a slot serves (set from its service when
-- the service has a brand). standard_key / standard_month: the deliverable
-- and month the slot fills; standard_seq: set only on slots the monthly
-- planner opened, unique per client, site, deliverable and month, so a rerun
-- cannot open a second copy. A refresh slot (web_page + page_refreshes) is
-- the only web page slot the standard counts.
alter table content_plan_items
  add column brand_workspace_id uuid references client_brand_workspaces(id),
  add column standard_key text check (standard_key in ('blog_posts', 'facebook_posts', 'gbp_posts', 'page_refreshes')),
  add column standard_month date check (standard_month is null or extract(day from standard_month) = 1),
  add column standard_seq integer check (standard_seq is null or standard_seq > 0),
  add constraint content_plan_items_standard_shape check (
    (standard_key is null or standard_month is not null)
    and (standard_seq is null or standard_key is not null)
    and (standard_key is null
      or (standard_key = 'blog_posts' and deliverable = 'blog')
      or (standard_key = 'facebook_posts' and deliverable = 'social' and channel = 'facebook')
      or (standard_key = 'gbp_posts' and deliverable = 'gbp')
      or (standard_key = 'page_refreshes' and deliverable = 'web_page')));
create unique index content_plan_items_standard_slot on content_plan_items
  (client_id, coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), standard_key, standard_month, standard_seq)
  where standard_seq is not null;
create index content_plan_items_brand_idx on content_plan_items(brand_workspace_id);

create function content_plan_items_standard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid; m date;
begin
  if new.service_id is not null then
    select id into b from client_brand_workspaces where client_id = new.client_id and new.service_id = any(service_ids);
    if b is not null then
      if new.brand_workspace_id is not null and new.brand_workspace_id <> b
         and (tg_op = 'INSERT' or new.brand_workspace_id is distinct from old.brand_workspace_id) then
        raise exception 'The service belongs to another brand site.' using errcode = '23514';
      end if;
      new.brand_workspace_id := b;
    end if;
  end if;
  if new.brand_workspace_id is not null
     and not exists (select 1 from client_brand_workspaces where id = new.brand_workspace_id and client_id = new.client_id) then
    raise exception 'The brand site belongs to another client.' using errcode = '23514';
  end if;
  if new.standard_key is not null then
    m := date_trunc('month', coalesce(new.planned_date, new.week_start))::date;
    -- A slot moved to another month or site is that month's hand-planned slot.
    if tg_op = 'UPDATE' and (old.standard_month, old.brand_workspace_id) is distinct from (m, new.brand_workspace_id) then
      new.standard_seq := null;
    end if;
    new.standard_month := m;
  end if;
  return new;
end $$;
revoke all on function content_plan_items_standard() from public, anon, authenticated;
create trigger content_plan_items_standard before insert or update on content_plan_items
  for each row execute function content_plan_items_standard();

create function delivery_try_timestamptz(v text) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
begin return v::timestamptz; exception when others then return null; end $$;
revoke all on function delivery_try_timestamptz(text) from public, anon;
grant execute on function delivery_try_timestamptz(text) to authenticated, service_role;

-- Targets and work per unit and deliverable for a month. Counted once each:
--   blog_posts      content_posts origin 'compass' (0062's month rule), brand
--                   by keyword → service; plus blog slots with no linked or
--                   generated post yet (planned; a delivered hold completes).
--                   Weekly blog_post tasks are a work queue, not a plan.
--   facebook_posts  social_posts on facebook, not rejected (0062's month
--                   rule), brand by service; plus unlinked facebook slots.
--   gbp_posts       the same on google_business. The client's one verified
--                   location is the destination for every brand; each post
--                   counts once, for the brand of its service.
--   page_refreshes  completed only on a live receipt: a change_log
--                   page_rewrite row, approved, whose `after` carries the url,
--                   the commit, verified_at and http_status 200, not undone by
--                   a later revert of that commit. Counted once per site, url
--                   and commit, in the month of verified_at. Approved rows
--                   without a receipt (and failed or reverted ones) are
--                   in-flight: planned, and reported as `unverified`. Refresh
--                   slots plan the month's work; slots and executions are
--                   matched, so planned = max(slots, in-flight + done) − done.
--                   Proposed rows and new pages are not counted.
-- destination: the verified Business Profile location (client-level) for
-- gbp_posts, the unit's verified Facebook Page for facebook_posts; null
-- when none is recorded.
create function delivery_targets(p_client_id uuid default null, p_month date default null)
returns table (
  client_id uuid,
  month date,
  unit_kind text,
  brand_workspace_id uuid,
  unit_name text,
  deliverable text,
  target integer,
  completed integer,
  planned integer,
  used integer,
  remaining integer,
  over_target integer,
  unverified integer,
  destination text,
  standard_version integer,
  source_ref text
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with b as (
    select m as m_start, (m + interval '1 month')::date as m_end
    from (select date_trunc('month', coalesce(p_month, (now() at time zone 'America/Chicago')::date))::date as m) x
  ),
  std as (
    select c.id as client_id, c.name, s.*
    from clients c cross join b
    cross join lateral (select * from client_delivery_standard(c.id, b.m_start)) s
    where (p_client_id is null or c.id = p_client_id) and s.id is not null
  ),
  multi as (
    select distinct w.client_id from client_brand_workspaces w where w.client_id in (select client_id from std)
  ),
  units as (
    select std.client_id, 'brand'::text as unit_kind, w.id as bid, w.name as unit_name, 1 as factor, w.facebook_account_id
    from std join client_brand_workspaces w on w.client_id = std.client_id
    union all
    select std.client_id, 'client', null::uuid, std.name, 1, null::uuid from std
    where std.client_id not in (select client_id from multi)
    union all
    select std.client_id, 'unattributed', null::uuid, 'Unattributed', 0, null::uuid from std
    where std.client_id in (select client_id from multi)
  ),
  owner as (
    select w.client_id, w.id as bid, unnest(w.service_ids) as service_id from client_brand_workspaces w
  ),
  -- (client, service, slot brand, deliverable, done)
  work as (
    select cp.client_id, k.service_id, null::uuid as slot_bid, 'blog_posts'::text as deliverable, cp.status = 'published' as done
    from content_posts cp left join keywords k on k.id = cp.keyword_id, b
    where cp.origin = 'compass' and cp.client_id in (select client_id from std)
      and ((cp.status = 'published' and cp.published_at >= b.m_start and cp.published_at < b.m_end)
        or (cp.status <> 'published' and coalesce(cp.due_date, cp.published_at) >= b.m_start
            and coalesce(cp.due_date, cp.published_at) < b.m_end))
    union all
    select sp.client_id, sp.service_id, null,
           case sp.platform::text when 'facebook' then 'facebook_posts' else 'gbp_posts' end,
           sp.publish_status = 'published'
    from social_posts sp, b
    where sp.platform::text in ('facebook', 'google_business') and sp.review_status <> 'rejected'
      and sp.client_id in (select client_id from std)
      and (case when sp.publish_status = 'published'
                then (sp.published_at at time zone 'America/Chicago')::date
                else (coalesce(sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date
           end) >= b.m_start
      and (case when sp.publish_status = 'published'
                then (sp.published_at at time zone 'America/Chicago')::date
                else (coalesce(sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date
           end) < b.m_end
    union all
    select pi.client_id, pi.service_id, pi.brand_workspace_id,
           case pi.deliverable when 'blog' then 'blog_posts' when 'gbp' then 'gbp_posts' else 'facebook_posts' end,
           pi.hold is not distinct from 'delivered'
    from content_plan_items pi, b
    where pi.client_id in (select client_id from std)
      and (pi.deliverable in ('blog', 'gbp') or (pi.deliverable = 'social' and pi.channel::text = 'facebook'))
      and pi.social_post_id is null and pi.content_post_id is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = pi.id and d.final_content_post_id is not null)
      and coalesce(pi.planned_date, pi.week_start) >= b.m_start and coalesce(pi.planned_date, pi.week_start) < b.m_end
  ),
  attributed as (
    select w.client_id, w.deliverable, w.done, coalesce(o.bid, w.slot_bid) as bid
    from work w left join owner o on o.client_id = w.client_id and o.service_id = w.service_id
  ),
  counts as (
    select a.client_id, a.deliverable,
           case when a.bid is not null then 'brand' when a.client_id in (select client_id from multi) then 'unattributed' else 'client' end as unit_kind,
           a.bid,
           count(*) filter (where a.done)::int as completed,
           count(*) filter (where not a.done)::int as planned,
           0 as unverified
    from attributed a
    group by 1, 2, 3, 4
  ),
  rewrites as (
    select cl.id, cl.client_id, cl.object_id as site_id, cl.created_at, cl.after,
           delivery_try_timestamptz(cl.after->>'verified_at') as verified_at,
           (nullif(btrim(cl.after->>'commit'), '') is not null and nullif(btrim(cl.after->>'url'), '') is not null
            and cl.after->>'http_status' = '200' and delivery_try_timestamptz(cl.after->>'verified_at') is not null
            and not exists (select 1 from change_log r where r.client_id = cl.client_id and r.change_type = 'revert'
                              and nullif(btrim(r.after->>'reverted'), '') is not null
                              and strpos(cl.after->>'commit', btrim(r.after->>'reverted')) > 0)) as receipt
    from change_log cl
    where cl.change_type = 'page_rewrite' and cl.object_type = 'site' and cl.status = 'approved'
      and cl.client_id in (select client_id from std)
  ),
  receipts as (
    select distinct on (r.client_id, r.site_id, lower(r.after->>'url'), btrim(r.after->>'commit'))
           r.client_id, r.site_id, r.verified_at
    from rewrites r where r.receipt
    order by r.client_id, r.site_id, lower(r.after->>'url'), btrim(r.after->>'commit'), r.verified_at
  ),
  refresh_work as (
    select r.client_id, (select x.id from client_brand_workspaces x where x.client_id = r.client_id and x.blog_site_id = r.site_id) as bid, 'done'::text as kind
    from receipts r, b
    where (r.verified_at at time zone 'America/Chicago')::date >= b.m_start and (r.verified_at at time zone 'America/Chicago')::date < b.m_end
    union all
    select r.client_id, (select x.id from client_brand_workspaces x where x.client_id = r.client_id and x.blog_site_id = r.site_id), 'inflight'
    from rewrites r, b
    where not r.receipt
      and (r.created_at at time zone 'America/Chicago')::date >= b.m_start and (r.created_at at time zone 'America/Chicago')::date < b.m_end
    union all
    select pi.client_id, coalesce((select o.bid from owner o where o.client_id = pi.client_id and o.service_id = pi.service_id), pi.brand_workspace_id), 'slot'
    from content_plan_items pi, b
    where pi.client_id in (select client_id from std) and pi.deliverable = 'web_page' and pi.standard_key = 'page_refreshes'
      and coalesce(pi.planned_date, pi.week_start) >= b.m_start and coalesce(pi.planned_date, pi.week_start) < b.m_end
  ),
  refresh_counts as (
    select f.client_id, 'page_refreshes'::text as deliverable,
           case when f.bid is not null then 'brand' when f.client_id in (select client_id from multi) then 'unattributed' else 'client' end as unit_kind,
           f.bid,
           count(*) filter (where f.kind = 'done')::int as completed,
           (greatest(count(*) filter (where f.kind = 'slot'),
                     count(*) filter (where f.kind in ('done', 'inflight')))
            - count(*) filter (where f.kind = 'done'))::int as planned,
           count(*) filter (where f.kind = 'inflight')::int as unverified
    from refresh_work f
    group by 1, 2, 3, 4
  ),
  all_counts as (select * from counts union all select * from refresh_counts),
  grid as (
    select u.*, d.deliverable, s.version, s.source_ref, d.ord,
           u.factor * case d.deliverable when 'blog_posts' then s.blog_posts when 'facebook_posts' then s.facebook_posts
                                         when 'gbp_posts' then s.gbp_posts else s.page_refreshes end as target
    from units u join std s on s.client_id = u.client_id
    cross join (values ('blog_posts', 1), ('facebook_posts', 2), ('gbp_posts', 3), ('page_refreshes', 4)) d(deliverable, ord)
  )
  select g.client_id, b.m_start, g.unit_kind, g.bid, g.unit_name, g.deliverable, g.target,
         coalesce(c.completed, 0), coalesce(c.planned, 0),
         coalesce(c.completed, 0) + coalesce(c.planned, 0),
         greatest(g.target - coalesce(c.completed, 0) - coalesce(c.planned, 0), 0),
         greatest(coalesce(c.completed, 0) + coalesce(c.planned, 0) - g.target, 0),
         coalesce(c.unverified, 0),
         case
           when g.unit_kind = 'unattributed' then null
           when g.deliverable = 'gbp_posts' then (
             select case when count(*) = 1 then max(coalesce(nullif(btrim(sa.publish_account_name), ''), sa.publish_page_id)) end
             from social_accounts sa where sa.client_id = g.client_id and sa.platform::text = 'google_business' and sa.publish_verified_at is not null)
           when g.deliverable = 'facebook_posts' and g.unit_kind = 'brand' then (
             select coalesce(nullif(btrim(sa.publish_account_name), ''), sa.display_name, sa.publish_page_id)
             from social_accounts sa where sa.id = g.facebook_account_id and sa.publish_verified_at is not null)
           when g.deliverable = 'facebook_posts' then (
             select case when count(*) = 1 then max(coalesce(nullif(btrim(sa.publish_account_name), ''), sa.display_name, sa.publish_page_id)) end
             from social_accounts sa where sa.client_id = g.client_id and sa.platform::text = 'facebook' and sa.publish_verified_at is not null)
         end,
         g.version, g.source_ref
  from grid g cross join b
  left join all_counts c on c.client_id = g.client_id and c.deliverable = g.deliverable
    and c.unit_kind = g.unit_kind and c.bid is not distinct from g.bid
  order by g.client_id, case g.unit_kind when 'unattributed' then 1 else 0 end, g.unit_name, g.ord
$$;
revoke all on function delivery_targets(uuid, date) from public, anon;
grant execute on function delivery_targets(uuid, date) to authenticated, service_role;
comment on function delivery_targets(uuid, date) is
  'Monthly delivery standard per brand site (or client): target, completed, planned, remaining, unverified refreshes and the recorded destination. Operational only; never reads billing.';

-- Open the month's missing slots. For each site and deliverable, what
-- delivery_targets() still has room for (existing work and slots counted
-- first) becomes slots spread evenly over the month's remaining weekdays,
-- from today on: a past day is never planned, a past month never touched,
-- and no week is filled beyond the month's room. Reruns open nothing more
-- (the room is gone, and the slot index refuses a duplicate). Nothing is
-- drafted, scheduled or published. A Facebook or Business Profile slot
-- with no verified destination is opened blocked, with the reason.
create function plan_delivery_month(p_client_id uuid, p_month date default null) returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  today date := (now() at time zone 'America/Chicago')::date;
  m date := date_trunc('month', coalesce(p_month, (now() at time zone 'America/Chicago')::date))::date;
  m_end date := (date_trunc('month', coalesce(p_month, (now() at time zone 'America/Chicago')::date)) + interval '1 month')::date;
  first_day date;
  days date[]; n int; t record; nxt int; i int; d date; made int := 0; got int;
  label text; blocked text;
begin
  if p_client_id is null then raise exception 'Choose a client' using errcode = '22023'; end if;
  first_day := greatest(m, today);
  if first_day >= m_end then return 0; end if;
  if (select s.id from client_delivery_standard(p_client_id, m) s) is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery-plan:' || p_client_id::text || ':' || m::text, 0));
  select array_agg(x::date order by x) into days
    from generate_series(first_day, m_end - 1, interval '1 day') x where extract(isodow from x) < 6;
  if days is null then
    select array_agg(x::date order by x) into days from generate_series(first_day, m_end - 1, interval '1 day') x;
  end if;
  n := cardinality(days);
  for t in select * from delivery_targets(p_client_id, m) x where x.unit_kind in ('brand', 'client') and x.remaining > 0 loop
    select coalesce(max(standard_seq), 0) into nxt from content_plan_items c
     where c.client_id = p_client_id and c.brand_workspace_id is not distinct from t.brand_workspace_id
       and c.standard_key = t.deliverable and c.standard_month = m;
    label := case t.deliverable when 'blog_posts' then 'Blog' when 'facebook_posts' then 'Facebook post'
                                when 'gbp_posts' then 'Business Profile post' else 'Page refresh' end;
    blocked := case
      when t.deliverable = 'facebook_posts' and t.destination is null then 'No verified Facebook Page for ' || t.unit_name || '.'
      when t.deliverable = 'gbp_posts' and t.destination is null then 'No verified Business Profile location for this client.'
    end;
    for i in 1..t.remaining loop
      d := days[1 + floor((i - 0.5) * n / t.remaining)::int];
      insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, planned_date, notes,
                                      hold, hold_reason, brand_workspace_id, standard_key, standard_month, standard_seq)
      values (p_client_id, d - (extract(isodow from d)::int - 1),
              case t.deliverable when 'blog_posts' then 'blog' when 'facebook_posts' then 'social' when 'gbp_posts' then 'gbp' else 'web_page' end,
              case t.deliverable when 'facebook_posts' then 'facebook'::social_platform when 'gbp_posts' then 'google_business'::social_platform end,
              case when t.deliverable in ('gbp_posts', 'page_refreshes') then 'service' else 'educational' end,
              left(label || ' · ' || t.unit_name || ' · ' || to_char(m, 'FMMonth YYYY'), 200), d,
              'Opened by the monthly delivery standard (v' || t.standard_version || '). Set the topic, intent, service and keyword before drafting.'
                || case when t.deliverable = 'page_refreshes' then ' Refresh an existing page; new pages are not part of the standard.' else '' end,
              case when blocked is not null then 'blocked' end, blocked,
              t.brand_workspace_id, t.deliverable, m, nxt + i)
      on conflict do nothing;
      get diagnostics got = row_count;
      made := made + got;
    end loop;
  end loop;
  return made;
end $$;
revoke all on function plan_delivery_month(uuid, date) from public, anon;
grant execute on function plan_delivery_month(uuid, date) to authenticated, service_role;

-- Room for one more blog publication this month. A client on a standard is
-- checked against the brand that owns the draft's service (or the client);
-- a client without one keeps 0062's agreement allocation, unchanged.
-- Publications already leasing or uncertain hold a slot in the same unit.
create function blog_publication_has_room(p_client_id uuid, p_service_id uuid, p_month date default null)
returns boolean
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare month date := date_trunc('month', coalesce(p_month, (now() at time zone 'America/Chicago')::date))::date;
  bid uuid; multi boolean; t record; inflight int;
begin
  if (select s.id from client_delivery_standard(p_client_id, month) s) is null then
    return exists(select 1 from client_quota_usage(p_client_id, month) q where q.service_key = 'blog_posts' and q.allocation > q.completed +
      (select count(*) from blog_publications x where x.client_id = p_client_id and x.status in ('publishing', 'uncertain')));
  end if;
  multi := exists(select 1 from client_brand_workspaces where client_id = p_client_id);
  select id into bid from client_brand_workspaces where client_id = p_client_id and p_service_id = any(service_ids);
  if multi and bid is null then return false; end if;
  select * into t from delivery_targets(p_client_id, month) d
  where d.deliverable = 'blog_posts' and d.unit_kind in ('brand', 'client') and d.brand_workspace_id is not distinct from bid;
  select count(*) into inflight from blog_publications x join content_drafts d on d.id = x.draft_id
  where x.client_id = p_client_id and x.status in ('publishing', 'uncertain')
    and (not multi or exists(select 1 from client_brand_workspaces w where w.id = bid and d.service_id = any(w.service_ids)));
  return coalesce(t.target, 0) > coalesce(t.completed, 0) + inflight;
end $$;
revoke all on function blog_publication_has_room(uuid, uuid, date) from public, anon, authenticated;
grant execute on function blog_publication_has_room(uuid, uuid, date) to service_role;

-- Unchanged from 20261012025951 except the allowance check, which now asks
-- blog_publication_has_room() with the draft's service.
create or replace function blog_publication_claim(p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare p blog_publications; d content_drafts; v text[]; token uuid := gen_random_uuid();
begin
  if not drafter_caller_is_service() then raise exception 'Publisher service only' using errcode = '42501'; end if;
  select * into d from content_drafts where id = (select draft_id from blog_publications where id=p_id) for update;
  select * into p from blog_publications where id=p_id for update;
  if p.id is null then raise exception 'No such publication' using errcode = 'P0002'; end if;
  perform set_config('compass.blog_publication_write','on',true);
  if p.status='publishing' and p.lease_expires_at < now() then
    update blog_publications set status='uncertain',last_error='Publisher interrupted; reconcile the repository and deployment before retrying.' where id=p.id;
    return jsonb_build_object('status','uncertain');
  end if;
  if p.status<>'queued' or p.scheduled_at>now() then return jsonb_build_object('status',p.status,'acquired',false); end if;
  v := blog_publication_problems(d,p.snapshot);
  if cardinality(v)>0 then
    update blog_publications set status='blocked',last_error=array_to_string(v,' ') where id=p.id;
    return jsonb_build_object('status','blocked','problems',v);
  end if;
  -- Serialize each client's quota check. A published record is counted only
  -- after live verification. Concurrent leases consume an available slot.
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p.client_id::text,0));
  if not blog_publication_has_room(p.client_id, d.service_id) then
    update blog_publications set status='blocked',last_error='Monthly blog allowance is unavailable or fully used.' where id=p.id;
    return jsonb_build_object('status','blocked');
  end if;
  update blog_publications set status='publishing',lease_token=token,lease_expires_at=now()+interval '10 minutes',last_error=null
    where id=p.id returning * into p;
  perform set_config('compass.blog_publication_write','',true);
  return to_jsonb(p);
end $$;

-- One blog_post task per standard blog slot dated on or before p_through
-- that is still unclaimed: no hold, no linked post, no draft, no task naming
-- it. Overdue slots are included, so a slot opened after a weekly run, a
-- month that starts after Wednesday, or a slot unblocked after its week is
-- queued on the next run rather than skipped. The task keeps the slot's own
-- date as its due date (the slot's month is unchanged); nothing is drafted,
-- scheduled or published here. Rerun-safe: a slot never gets a second task.
-- Not logged in automation_entitlement_log: that log records agreement
-- (entitlement) decisions; the task's notes name the slot it came from.
create function queue_standard_blog_tasks(p_client_id uuid, p_through date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; made int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p_client_id::text,0));
  for s in select i.id, i.planned_date, coalesce(w.name, 'the client') as unit
    from content_plan_items i left join client_brand_workspaces w on w.id = i.brand_workspace_id
    where i.client_id = p_client_id and i.standard_key = 'blog_posts' and i.planned_date <= p_through
      and i.content_post_id is null and i.hold is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)
      and not exists (select 1 from tasks t where t.client_id = p_client_id and t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%')
    order by i.planned_date, i.id loop
    insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date,notes)
      values(p_client_id, left('Blog slot for '||s.unit||': governed keyword, sourced article, team review',200),
        'CLAUDE','open','PB7','run_flag','blog_post',s.planned_date,
        'plan_item:'||s.id||' (monthly delivery standard). Choose a keyword and service of '||s.unit||'.');
    made := made + 1;
  end loop;
  return made;
end $$;
revoke all on function queue_standard_blog_tasks(uuid, date) from public, anon, authenticated, service_role;

-- The weekly blog beat (Wednesdays). Clients on a standard: open the
-- month's slots (both months when the week crosses one), then queue a task
-- for every unclaimed blog slot dated up to Sunday, overdue ones included
-- (queue_standard_blog_tasks); the worker is fired for active clients as
-- before. Every other client runs exactly the 20261012025951 body.
create or replace function create_weekly_blog_tasks() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; u record; made int:=0; existing int; slots int; n int; opened int;
  week date:=date_trunc('week',now() at time zone 'America/Chicago')::date;
begin
  for c in select cl.id, cl.status from clients cl where cl.status in ('active','launching')
      and ((client_delivery_standard(cl.id, week)).id is not null or (client_delivery_standard(cl.id, week+6)).id is not null)
      order by cl.id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    perform plan_delivery_month(c.id, week);
    if date_trunc('month', week+6) <> date_trunc('month', week) then perform plan_delivery_month(c.id, week+6); end if;
    if c.status <> 'active' then continue; end if;
    opened := queue_standard_blog_tasks(c.id, week+6);
    made := made + opened;
    if opened > 0 then
      perform fire_foundation_worker(c.id,'Weekly blog drafts: fill this week''s standard blog slots for their brand and stop for team review');
    end if;
  end loop;

  for c in select cl.id,cl.name from clients cl where cl.status='active'
      and (client_delivery_standard(cl.id, week)).id is null and (client_delivery_standard(cl.id, week+6)).id is null
      order by cl.id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    select count(*) into existing from tasks where client_id=c.id and key='blog_post'
      and (created_at at time zone 'America/Chicago')::date>=week
      and (created_at at time zone 'America/Chicago')::date<week+7;
    if existing>=2 then continue; end if;
    begin
      select allocation,used,remaining into u from client_quota_usage(c.id) where service_key='blog_posts';
    exception when others then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end;
    if u is null then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end if;
    slots:=least(2-existing,u.remaining);
    if u.allocation=0 or slots<=0 then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','skipped',case when u.allocation=0 then 'not_in_agreement' else 'allocation_used' end,u.allocation,u.used);
      continue;
    end if;
    for n in 1..slots loop
      insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date)
        values(c.id,'Blog slot '||(existing+n)||': governed keyword, sourced article, team review',
          'CLAUDE','open','PB7','run_flag','blog_post',week+2+2*(existing+n-1));
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','created','within_allocation',u.allocation,u.used+n);
      made:=made+1;
    end loop;
    perform fire_foundation_worker(c.id,'Weekly blog drafts: select active governed keywords and stop for team review');
  end loop;
  return made;
end $$;
revoke all on function create_weekly_blog_tasks() from public,anon,authenticated,service_role;

-- The 1st of each month (06:00 Chicago in CDT): open the new month's slots
-- for every client on a standard, so the month is planned from its first day.
create function plan_delivery_months() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; made int := 0;
begin
  for c in select cl.id from clients cl where cl.status in ('active', 'launching')
      and (client_delivery_standard(cl.id, (now() at time zone 'America/Chicago')::date)).id is not null loop
    made := made + plan_delivery_month(c.id);
  end loop;
  return made;
end $$;
revoke all on function plan_delivery_months() from public, anon, authenticated, service_role;
select cron.schedule('delivery-standard-month', '0 11 1 * *', 'select public.plan_delivery_months()');

-- The weekly draft fills exactly the slot its task names, or refuses
-- (missing, not a blog slot, blocked, delivered or linked, already drafted,
-- another brand's service). A task with no named slot keeps the previous
-- choice: this week's empty blog slot of the service's brand (or one
-- without a brand), or a new one. Unchanged from 20261012033430 otherwise.
create or replace function content_draft_open_weekly(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t tasks;
  d content_drafts;
  i content_plan_items;
  v_week date := date_trunc('week', (now() at time zone 'America/Chicago'))::date;
  v_kw text;
  v_slot uuid;
  v_brand uuid;
begin
  if not drafter_caller_is_service() then
    raise exception 'content_draft_open_weekly runs only in the content-drafter function' using errcode = '42501';
  end if;
  perform set_config('compass.content_draft_write', 'on', true);
  select * into t from tasks where id = (p->>'task_id')::uuid for update;
  if t.id is null or t.key is distinct from 'blog_post' then
    raise exception 'No such weekly blog task' using errcode = 'P0002';
  end if;
  -- A Sunday request may be due next week. The planner week follows the
  -- actual due date, so planned_date always belongs to its slot.
  v_week := date_trunc('week', coalesce(t.due_date, (now() at time zone 'America/Chicago')::date))::date;
  select * into d from content_drafts where source_task_id = t.id;
  if d.id is not null then
    perform set_config('compass.content_draft_write', '', true);
    return jsonb_build_object('draft_id', d.id, 'plan_item_id', d.plan_item_id, 'status', d.status, 'reused', true);
  end if;
  if t.status = 'done' then
    raise exception 'The weekly blog task is done' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p->>'topic', '')), '') is null
     or coalesce(p->>'search_intent', '') not in ('navigational', 'informational', 'commercial', 'transactional') then
    raise exception 'A weekly blog draft names its topic and search intent' using errcode = '22023';
  end if;

  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid
    and client_id = t.client_id and is_active;
  if v_kw is null then
    raise exception 'Choose an active governed keyword before generating this item' using errcode = '22023';
  end if;

  select id into v_brand from client_brand_workspaces
   where client_id = t.client_id and nullif(p->>'service_id', '')::uuid = any(service_ids);
  v_slot := substring(coalesce(t.notes, '') from 'plan_item:([0-9a-f-]{36})')::uuid;
  if v_slot is not null then
    -- A task that names its slot is bound to it: lock that exact slot, then
    -- use it or refuse with the reason. No other or new slot is substituted,
    -- so a hold, a delivery or another task's draft is never worked around.
    -- The lock also serialises two tasks naming the same slot.
    select * into i from content_plan_items x where x.id = v_slot and x.client_id = t.client_id for update;
    if i.id is null then
      raise exception 'The blog slot this task names no longer exists; replan it before drafting' using errcode = '22023';
    elsif i.deliverable <> 'blog' then
      raise exception 'The slot this task names is not a blog slot' using errcode = '22023';
    elsif i.hold = 'blocked' then
      raise exception 'The blog slot this task names is blocked (%); clear the hold before drafting', coalesce(i.hold_reason, 'no reason given')
        using errcode = '22023';
    elsif i.hold = 'delivered' or i.content_post_id is not null then
      raise exception 'The blog slot this task names is already delivered or linked to a post' using errcode = '22023';
    elsif exists (select 1 from content_drafts y where y.plan_item_id = i.id) then
      raise exception 'The blog slot this task names already has a draft; continue that draft instead' using errcode = '22023';
    elsif i.brand_workspace_id is not null and i.brand_workspace_id is distinct from v_brand then
      raise exception 'This blog slot is for another brand site; choose a keyword and service of that brand' using errcode = '22023';
    end if;
  else
    -- A task without a named slot (every task before the standard): this
    -- week's empty blog slot of the same brand (or none), or a new one.
    select * into i from content_plan_items x
     where x.client_id = t.client_id and x.week_start = v_week and x.deliverable = 'blog'
       and x.content_post_id is null and x.hold is null
       and (x.brand_workspace_id is null or x.brand_workspace_id is not distinct from v_brand)
       and not exists (select 1 from content_drafts y where y.plan_item_id = x.id)
     order by (x.brand_workspace_id is not distinct from v_brand) desc, x.created_at limit 1 for update;
    if i.id is null then
      insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, planned_date, notes)
      values (t.client_id, v_week, 'blog', 'educational', left(p->>'topic', 200), p->>'search_intent',
              nullif(p->>'keyword_id', '')::uuid, nullif(p->>'service_id', '')::uuid, coalesce(t.due_date, v_week+2), 'The weekly blog (opened by the worker).')
      returning * into i;
    end if;
  end if;
  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid and client_id = t.client_id;

  insert into content_drafts (client_id, plan_item_id, deliverable, topic, primary_keyword, keyword_id, search_intent, service_id,
                              source_task_id, request_note)
  values (t.client_id, i.id, 'blog', left(p->>'topic', 200), coalesce(v_kw, nullif(btrim(coalesce(p->>'primary_keyword', '')), '')),
          nullif(p->>'keyword_id', '')::uuid, p->>'search_intent', nullif(p->>'service_id', '')::uuid, t.id,
          'The weekly blog post.')
  returning * into d;
  update tasks set status = 'in_progress' where id = t.id and status = 'open';
  perform set_config('compass.content_draft_write', '', true);
  return jsonb_build_object('draft_id', d.id, 'plan_item_id', i.id, 'status', d.status, 'reused', false);
end $$;
revoke all on function content_draft_open_weekly(jsonb) from public, anon, authenticated;
grant execute on function content_draft_open_weekly(jsonb) to service_role;
