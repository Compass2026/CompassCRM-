-- Current tracked keywords, including those awaiting their first check.
-- Keep source, keyword, location and result type separate for comparisons.
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
