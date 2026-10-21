-- Rollback for 20261021163048_organic_rank_website_only.sql.
-- Restores the previous ranking views (20261012182258, 0037), their grants
-- and the previous City Index function (0013), then drops the two helpers.
-- No data is touched: rank_snapshots and location_index rows stay as they are.
-- Run as one transaction (psql -1 -f, or the Supabase SQL editor).

-- Current tracked keywords, including those awaiting their first check.
-- Keep source, keyword, location and result type separate for comparisons.
drop view public.client_growth_rankings;
create view public.client_growth_rankings with (security_invoker = true) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
       s.location_id, l.name as location_name, s.result_type,
       s.first_position, s.first_checked_at, s.position, s.checked_at,
       s.previous_position, s.previous_checked_at
from public.keywords k
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
           row_number() over (partition by r.location_id,r.result_type order by r.recorded_at desc,r.id desc) as latest,
           row_number() over (partition by r.location_id,r.result_type order by r.recorded_at,r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id=k.id and r.source::text='dataforseo' and r.recorded_at<=now()
  )
  select location_id,result_type,
         max(position) filter(where earliest=1) as first_position,
         max(recorded_at) filter(where earliest=1) as first_checked_at,
         max(position) filter(where latest=1) as position,
         max(recorded_at) filter(where latest=1) as checked_at,
         max(position) filter(where latest=2) as previous_position,
         max(recorded_at) filter(where latest=2) as previous_checked_at
  from ordered where latest<=2 or earliest=1 group by location_id,result_type
) s on true
left join public.locations l on l.id=s.location_id and l.client_id=k.client_id
where k.is_active and k.is_tracked;
revoke all on public.client_growth_rankings from public,anon,authenticated;
grant select on public.client_growth_rankings to authenticated;

-- Follow the portal's established owner-view boundary, with explicit tenant
-- filtering and no base-table access or internal keyword fields exposed.
-- Select base rows directly: nesting the team invoker view would still apply
-- caller RLS and hide the client's permitted results.
drop view public.portal_growth_rankings;
create view public.portal_growth_rankings with (security_barrier=true,security_invoker=false) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
       s.location_id, l.name as location_name, s.result_type,
       s.first_position, s.first_checked_at, s.position, s.checked_at,
       s.previous_position, s.previous_checked_at
from public.keywords k
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
           row_number() over (partition by r.location_id,r.result_type order by r.recorded_at desc,r.id desc) as latest,
           row_number() over (partition by r.location_id,r.result_type order by r.recorded_at,r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id=k.id and r.source::text='dataforseo' and r.recorded_at<=now()
  )
  select location_id,result_type,
         max(position) filter(where earliest=1) as first_position,
         max(recorded_at) filter(where earliest=1) as first_checked_at,
         max(position) filter(where latest=1) as position,
         max(recorded_at) filter(where latest=1) as checked_at,
         max(position) filter(where latest=2) as previous_position,
         max(recorded_at) filter(where latest=2) as previous_checked_at
  from ordered where latest<=2 or earliest=1 group by location_id,result_type
) s on true
left join public.locations l on l.id=s.location_id and l.client_id=k.client_id
where k.is_active and k.is_tracked and k.client_id=(select public.portal_client_id());
revoke all on public.portal_growth_rankings from public,anon,authenticated;
grant select on public.portal_growth_rankings to authenticated;

drop view public.portal_rankings;
create view public.portal_rankings with (security_invoker = false) as
  with ranked as (
    select k.client_id, k.id as keyword_id, k.keyword, k.city, k.is_money,
           r.result_type::text as result_type, r.position, r.recorded_at,
           row_number() over (partition by k.id, r.result_type order by r.recorded_at desc) as rn
    from rank_snapshots r
    join keywords k on k.id = r.keyword_id
    where k.client_id = (select portal_client_id())
      and k.is_active and k.is_tracked
      and r.source::text = 'dataforseo'
  )
  select client_id, keyword, city, is_money, result_type,
         max(position) filter (where rn = 1) as position,
         max(position) filter (where rn = 2) as previous_position,
         max(recorded_at) filter (where rn = 1) as checked_at
  from ranked
  where rn <= 2
  group by client_id, keyword, city, is_money, result_type;
revoke all on public.portal_rankings from public, anon, authenticated;
grant select on public.portal_rankings to authenticated;

create or replace function compute_location_index(p_location_id uuid, p_period date)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_start date := date_trunc('month', p_period)::date;
  v_end date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_organic numeric(5,2);
  v_map numeric(5,2);
  v_counted int;
begin
  select client_id into v_client from locations where id = p_location_id;
  if v_client is null then
    return;
  end if;

  select count(*) into v_counted
  from keywords k
  where k.client_id = v_client and k.is_active and k.priority = 'p1';

  -- Latest in-period position per P1 keyword and result type; keywords with
  -- no ranking in the period stay out of the average, as before.
  with latest as (
    select distinct on (rs.keyword_id, rs.result_type)
      rs.result_type, rs.position as pos
    from rank_snapshots rs
    join keywords k on k.id = rs.keyword_id
    where rs.location_id = p_location_id
      and k.client_id = v_client and k.is_active and k.priority = 'p1'
      and rs.position is not null
      and rs.recorded_at >= v_start and rs.recorded_at < v_end
    order by rs.keyword_id, rs.result_type, rs.recorded_at desc
  )
  select round(avg(pos) filter (where result_type = 'organic'), 2),
         round(avg(pos) filter (where result_type = 'map_pack'), 2)
  into v_organic, v_map
  from latest;

  insert into location_index (location_id, period, organic_index, map_index, keywords_counted, computed_at)
  values (p_location_id, v_start, v_organic, v_map, v_counted, now())
  on conflict (location_id, period) do update
    set organic_index = excluded.organic_index,
        map_index = excluded.map_index,
        keywords_counted = excluded.keywords_counted,
        computed_at = excluded.computed_at;
end $$;
revoke execute on function compute_location_index(uuid, date) from public, anon, authenticated;

drop function public.organic_rank_state(text, integer, text, text[]);
drop function public.url_host(text);
