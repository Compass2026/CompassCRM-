-- Monthly delivery standard: the operational targets Compass works to each
-- calendar month, kept apart from the billing entitlements (0062).
--
--   Agreement → client_entitlements_for()   what was sold; agreements, the
--                                            portal and billing read it
--   Owner decision → delivery_standards      what the team delivers; the
--                                            planner and the blog gate read it
--
-- Nothing here reads or writes plans, package_entitlements,
-- client_entitlement_overrides, agreement_contracts or any Stripe table, so
-- prices, issued agreement snapshots and signature status are untouched.
--
-- Unit: each brand site of a multi-brand client (client_brand_workspaces),
-- otherwise the client. A three-brand client therefore gets three full
-- allocations. Work is attributed to a brand through its service (the
-- service has one owning brand, 20261012163631); work that cannot be
-- attributed is reported on an "unattributed" row with target 0 and is never
-- counted toward any brand.
--
-- Month: the America/Chicago calendar month (as 0062), passed explicitly.

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
-- before the month wins; no row means the client is not on a standard and
-- every consumer keeps its pre-standard behaviour.
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

-- The month's standard for a client, or nothing.
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

-- Targets and work per unit and deliverable for a month. Counted once each:
--   blog_posts      content_posts origin 'compass' (0062's month rule), brand
--                   by keyword → service; plus planner blog items with no
--                   linked or generated post yet (planned; delivered hold =
--                   completed). Weekly blog_post tasks are a work queue, not
--                   a plan, and are not counted.
--   facebook_posts  social_posts on facebook, not rejected (0062's month
--                   rule), brand by service; plus unlinked planner facebook items.
--   gbp_posts       the same on google_business. A multi-brand client's
--                   posts go to its one client-level profile; each post
--                   counts once, for the brand of its service.
--   page_refreshes  change_log page_rewrite, not vetoed, created this month;
--                   brand by the site it names. New pages are not counted.
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
  units as (
    select std.client_id, 'brand'::text as unit_kind, w.id as bid, w.name as unit_name, 1 as factor
    from std join client_brand_workspaces w on w.client_id = std.client_id
    union all
    select std.client_id, 'client', null::uuid, std.name, 1 from std
    where not exists (select 1 from client_brand_workspaces w where w.client_id = std.client_id)
    union all
    select std.client_id, 'unattributed', null::uuid, 'Unattributed', 0 from std
    where exists (select 1 from client_brand_workspaces w where w.client_id = std.client_id)
  ),
  owner as (
    select w.client_id, w.id as bid, unnest(w.service_ids) as service_id from client_brand_workspaces w
  ),
  -- (client, service or null, site or null, deliverable, done)
  work as (
    select cp.client_id, k.service_id, null::uuid as site_id, 'blog_posts'::text as deliverable, cp.status = 'published' as done
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
    select pi.client_id, pi.service_id, null,
           case pi.deliverable when 'blog' then 'blog_posts' when 'gbp' then 'gbp_posts' else 'facebook_posts' end,
           pi.hold is not distinct from 'delivered'
    from content_plan_items pi, b
    where pi.client_id in (select client_id from std)
      and (pi.deliverable in ('blog', 'gbp') or (pi.deliverable = 'social' and pi.channel::text = 'facebook'))
      and pi.social_post_id is null and pi.content_post_id is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = pi.id and d.final_content_post_id is not null)
      and coalesce(pi.planned_date, pi.week_start) >= b.m_start and coalesce(pi.planned_date, pi.week_start) < b.m_end
    union all
    select cl.client_id, null, case when cl.object_type = 'site' then cl.object_id end, 'page_refreshes', cl.status = 'approved'
    from change_log cl, b
    where cl.change_type = 'page_rewrite' and cl.status <> 'vetoed'
      and cl.client_id in (select client_id from std)
      and (cl.created_at at time zone 'America/Chicago')::date >= b.m_start
      and (cl.created_at at time zone 'America/Chicago')::date < b.m_end
  ),
  attributed as (
    select w.client_id, w.deliverable, w.done,
           coalesce(o.bid, (select x.id from client_brand_workspaces x where x.client_id = w.client_id and x.blog_site_id = w.site_id)) as bid
    from work w left join owner o on o.client_id = w.client_id and o.service_id = w.service_id
  ),
  counts as (
    select a.client_id, a.deliverable,
           case when a.bid is not null then 'brand'
                when exists (select 1 from client_brand_workspaces x where x.client_id = a.client_id) then 'unattributed'
                else 'client' end as unit_kind,
           a.bid,
           count(*) filter (where a.done)::int as completed,
           count(*) filter (where not a.done)::int as planned
    from attributed a
    group by 1, 2, 3, 4
  ),
  grid as (
    select u.*, d.deliverable, s.version, s.source_ref,
           u.factor * case d.deliverable when 'blog_posts' then s.blog_posts when 'facebook_posts' then s.facebook_posts
                                         when 'gbp_posts' then s.gbp_posts else s.page_refreshes end as target, d.ord
    from units u join std s on s.client_id = u.client_id
    cross join (values ('blog_posts', 1), ('facebook_posts', 2), ('gbp_posts', 3), ('page_refreshes', 4)) d(deliverable, ord)
  )
  select g.client_id, b.m_start, g.unit_kind, g.bid, g.unit_name, g.deliverable, g.target,
         coalesce(c.completed, 0), coalesce(c.planned, 0),
         coalesce(c.completed, 0) + coalesce(c.planned, 0),
         greatest(g.target - coalesce(c.completed, 0) - coalesce(c.planned, 0), 0),
         greatest(coalesce(c.completed, 0) + coalesce(c.planned, 0) - g.target, 0),
         g.version, g.source_ref
  from grid g cross join b
  left join counts c on c.client_id = g.client_id and c.deliverable = g.deliverable
    and c.unit_kind = g.unit_kind and c.bid is not distinct from g.bid
  order by g.client_id, case g.unit_kind when 'unattributed' then 1 else 0 end, g.unit_name, g.ord
$$;
revoke all on function delivery_targets(uuid, date) from public, anon;
grant execute on function delivery_targets(uuid, date) to authenticated, service_role;
comment on function delivery_targets(uuid, date) is
  'Monthly delivery standard per brand site (or client): target, completed, planned, remaining. Operational only; never reads billing.';

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
