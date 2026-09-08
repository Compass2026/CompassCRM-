-- City Index = P1 keywords only (spec §6.5a; reconciliation build order #10).
-- The BrightLocal sync used to fall back to every active keyword when a
-- client had no P1s, so the index compared cities on whatever happened to be
-- tracked. The rollup now lives here, the sync calls it, and stored rows are
-- recomputed. With no P1 keywords the index is blank — by design.

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

-- One call per client (or all clients) — what the BrightLocal sync invokes.
create or replace function recompute_location_indexes(
  p_client_id uuid default null,
  p_period date default date_trunc('month', now())::date
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_loc record;
  v_count int := 0;
begin
  for v_loc in
    select l.id from locations l
    where l.is_active and (p_client_id is null or l.client_id = p_client_id)
  loop
    perform compute_location_index(v_loc.id, p_period);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function recompute_location_indexes(uuid, date) from public, anon, authenticated;
grant execute on function recompute_location_indexes(uuid, date) to service_role;

-- Recompute what is already stored: rows written under the old fallback.
do $$
declare r record;
begin
  for r in select distinct location_id, period from location_index loop
    perform compute_location_index(r.location_id, r.period);
  end loop;
end $$;
