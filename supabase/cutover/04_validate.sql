-- Billing cutover, step 4: prove every active client is represented before
-- automation resumes. Raises (and stops the cutover) if an active client has
-- no agreement — unless it is deliberately excluded by listing its id in the
-- session setting first:
--   set compass.cutover_excluded = '{<uuid>,<uuid>}';
do $$
declare v_missing text; v_excluded uuid[];
begin
  v_excluded := coalesce(nullif(current_setting('compass.cutover_excluded', true), '')::uuid[], '{}');
  select string_agg(c.name || ' (' || c.id || ')', ', ' order by c.name) into v_missing
  from clients c
  where c.status = 'active'
    and not exists (select 1 from plans p where p.client_id = c.id and p.package_id is not null)
    and not exists (select 1 from client_entitlement_overrides o where o.client_id = c.id)
    and c.id <> all (v_excluded);
  if v_missing is not null then
    raise exception 'cutover: active client(s) with no agreement: %', v_missing;
  end if;
  if exists (select 1 from client_entitlements_for(null) limit 1) is not true then
    raise exception 'cutover: client_entitlements_for() returned nothing';
  end if;
end $$;

-- Launching clients with no agreement (not planned for yet; they will be
-- planned for only within an agreement once they become active).
select c.name as launching_without_agreement
from clients c
where c.status = 'launching' and not exists (select 1 from plans p where p.client_id = c.id and p.package_id is not null)
order by c.name;

-- Every non-offboarded client: what is included.
select c.name, c.status, e.service_key, e.kind, e.enabled, e.quantity, e.source
from clients c cross join lateral client_entitlements_for(c.id) e
where c.status <> 'offboarded' and (e.enabled or e.kind = 'quota')
order by c.name, e.sort_order;

-- This month's allocation, and what the planners will do next.
select c.name, u.service_key, u.allocation, u.completed, u.planned, u.remaining, u.over_allocation
from clients c cross join lateral client_quota_usage(c.id) u
where c.status = 'active'
order by c.name, u.service_key;

select c.name,
       case when b.allocation = 0 then 'weekly blog: not in agreement'
            when b.remaining = 0 then 'weekly blog: allocation used this month'
            else 'weekly blog: will plan (' || b.remaining || ' left)' end as weekly_blog,
       case when not coalesce(w.enabled, false) then 'website updates: website not included'
            when coalesce(pg.allocation, 0) + coalesce(rf.allocation, 0) = 0 then 'website updates: no pages or refreshes'
            else 'website updates: will fire (' || (coalesce(pg.remaining, 0) + coalesce(rf.remaining, 0)) || ' left)' end as website_updates
from clients c
left join lateral (select * from client_quota_usage(c.id) where service_key = 'blog_posts') b on true
left join lateral (select * from client_quota_usage(c.id) where service_key = 'website_pages') pg on true
left join lateral (select * from client_quota_usage(c.id) where service_key = 'website_refreshes') rf on true
left join lateral (select enabled from client_entitlements_for(c.id) where service_key = 'website') w on true
where c.status = 'active'
order by c.name;
