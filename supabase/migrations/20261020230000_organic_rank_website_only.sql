-- Organic rank counts only the client's own website (Lucas reporting pilot,
-- Oct 20 2026).
--
-- rank-sync stored the first organic result matching the site host OR the
-- business name. Directory, social and review pages titled with the name
-- (and once a same-name firm in another state) were stored as the website's
-- organic rank: 197 rows across nine clients on Oct 20. The collector fix
-- ships separately; this migration stops every reader from counting them.
-- No stored row is changed or deleted.
--
-- State of one organic observation, from the stored URL and the client's own
-- recorded websites (clients.website_url, sites.url, brand websites):
--   website      the URL's host is one of the client's hosts (or a subdomain)
--   third_party  some other host: the website's own position is unknown
--   unverified   no host to check against, or a DataForSEO row with no URL
--   not_found    checked, not in the results
-- BrightLocal, CSV and manual rows carry no URL; their provider or author
-- ranked the configured website, so a position without a URL stays website.
--
-- Readers: client_growth_rankings / portal_growth_rankings / portal_rankings
-- gain state columns and show a position only for website (organic) or
-- listed (map pack) rows, so even an un-updated reader cannot count a
-- third-party page. compute_location_index (City Index) averages website
-- organic rows only from its next run; stored location_index rows are left
-- as recorded.

create or replace function public.url_host(p_url text)
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select nullif(lower(regexp_replace(
    substring(p_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/:?#]+)'),
    '^www\.', '')), '')
$$;

create or replace function public.organic_rank_state(p_source text, p_position integer, p_url text, p_hosts text[])
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when p_position is null then 'not_found'
    when p_url is null then case when p_source = 'dataforseo' then 'unverified' else 'website' end
    when coalesce(cardinality(p_hosts), 0) = 0 or public.url_host(p_url) is null then 'unverified'
    when exists (
      select 1 from unnest(p_hosts) h
      where public.url_host(p_url) = h or right(public.url_host(p_url), length(h) + 1) = '.' || h
    ) then 'website'
    else 'third_party'
  end
$$;

revoke all on function public.url_host(text) from public, anon;
revoke all on function public.organic_rank_state(text, integer, text, text[]) from public, anon;
grant execute on function public.url_host(text) to authenticated, service_role;
grant execute on function public.organic_rank_state(text, integer, text, text[]) to authenticated, service_role;

-- The client's own website hosts, inline in each view: a function would run
-- as the portal user, who cannot read clients/sites, and see no hosts.

create or replace view public.client_growth_rankings with (security_invoker = true) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
  s.location_id, l.name as location_name, s.result_type,
  s.first_position, s.first_checked_at, s.position, s.checked_at, s.previous_position, s.previous_checked_at,
  s.first_state, s.state, s.previous_state
from public.keywords k
cross join lateral (
  select array_agg(distinct x.h) as hosts from (
    select public.url_host(c.website_url) as h from public.clients c where c.id = k.client_id
    union all select public.url_host(si.url) from public.sites si where si.client_id = k.client_id
    union all select public.url_host(b.website_url) from public.client_brand_workspaces b where b.client_id = k.client_id
  ) x where x.h is not null
) w
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
      case when r.result_type::text = 'organic' then public.organic_rank_state(r.source::text, r.position, r.url_ranked, w.hosts)
           when r.position is null then 'not_found' else 'listed' end as state,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at desc, r.id desc) as latest,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at, r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id = k.id and r.source::text = 'dataforseo' and r.recorded_at <= now()
  )
  select o.location_id, o.result_type,
    max(o.position) filter (where o.earliest = 1 and o.state in ('website', 'listed')) as first_position,
    max(o.recorded_at) filter (where o.earliest = 1) as first_checked_at,
    max(o.position) filter (where o.latest = 1 and o.state in ('website', 'listed')) as position,
    max(o.recorded_at) filter (where o.latest = 1) as checked_at,
    max(o.position) filter (where o.latest = 2 and o.state in ('website', 'listed')) as previous_position,
    max(o.recorded_at) filter (where o.latest = 2) as previous_checked_at,
    max(o.state) filter (where o.earliest = 1) as first_state,
    max(o.state) filter (where o.latest = 1) as state,
    max(o.state) filter (where o.latest = 2) as previous_state
  from ordered o
  where o.latest <= 2 or o.earliest = 1
  group by o.location_id, o.result_type
) s on true
left join public.locations l on l.id = s.location_id and l.client_id = k.client_id
where k.is_active and k.is_tracked;

create or replace view public.portal_growth_rankings with (security_barrier = true, security_invoker = false) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
  s.location_id, l.name as location_name, s.result_type,
  s.first_position, s.first_checked_at, s.position, s.checked_at, s.previous_position, s.previous_checked_at,
  s.first_state, s.state, s.previous_state
from public.keywords k
cross join lateral (
  select array_agg(distinct x.h) as hosts from (
    select public.url_host(c.website_url) as h from public.clients c where c.id = k.client_id
    union all select public.url_host(si.url) from public.sites si where si.client_id = k.client_id
    union all select public.url_host(b.website_url) from public.client_brand_workspaces b where b.client_id = k.client_id
  ) x where x.h is not null
) w
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
      case when r.result_type::text = 'organic' then public.organic_rank_state(r.source::text, r.position, r.url_ranked, w.hosts)
           when r.position is null then 'not_found' else 'listed' end as state,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at desc, r.id desc) as latest,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at, r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id = k.id and r.source::text = 'dataforseo' and r.recorded_at <= now()
  )
  select o.location_id, o.result_type,
    max(o.position) filter (where o.earliest = 1 and o.state in ('website', 'listed')) as first_position,
    max(o.recorded_at) filter (where o.earliest = 1) as first_checked_at,
    max(o.position) filter (where o.latest = 1 and o.state in ('website', 'listed')) as position,
    max(o.recorded_at) filter (where o.latest = 1) as checked_at,
    max(o.position) filter (where o.latest = 2 and o.state in ('website', 'listed')) as previous_position,
    max(o.recorded_at) filter (where o.latest = 2) as previous_checked_at,
    max(o.state) filter (where o.earliest = 1) as first_state,
    max(o.state) filter (where o.latest = 1) as state,
    max(o.state) filter (where o.latest = 2) as previous_state
  from ordered o
  where o.latest <= 2 or o.earliest = 1
  group by o.location_id, o.result_type
) s on true
left join public.locations l on l.id = s.location_id and l.client_id = k.client_id
where k.is_active and k.is_tracked and k.client_id = (select public.portal_client_id());

create or replace view public.portal_rankings with (security_invoker = false) as
with ranked as (
  select k.client_id, k.id as keyword_id, k.keyword, k.city, k.is_money,
    r.result_type::text as result_type, r.position, r.recorded_at,
    case when r.result_type::text = 'organic' then public.organic_rank_state(r.source::text, r.position, r.url_ranked, w.hosts)
         when r.position is null then 'not_found' else 'listed' end as state,
    row_number() over (partition by k.id, r.result_type order by r.recorded_at desc) as rn
  from public.rank_snapshots r
  join public.keywords k on k.id = r.keyword_id
  cross join lateral (
    select array_agg(distinct x.h) as hosts from (
      select public.url_host(c.website_url) as h from public.clients c where c.id = k.client_id
      union all select public.url_host(si.url) from public.sites si where si.client_id = k.client_id
      union all select public.url_host(b.website_url) from public.client_brand_workspaces b where b.client_id = k.client_id
    ) x where x.h is not null
  ) w
  where k.client_id = (select public.portal_client_id())
    and k.is_active and k.is_tracked
    and r.source::text = 'dataforseo'
)
select client_id, keyword, city, is_money, result_type,
  max(position) filter (where rn = 1 and state in ('website', 'listed')) as position,
  max(position) filter (where rn = 2 and state in ('website', 'listed')) as previous_position,
  max(recorded_at) filter (where rn = 1) as checked_at,
  max(state) filter (where rn = 1) as state,
  max(state) filter (where rn = 2) as previous_state
from ranked
where rn <= 2
group by client_id, keyword, city, is_money, result_type;

-- City Index: website organic rows only. Map pack unchanged.
create or replace function public.compute_location_index(p_location_id uuid, p_period date)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_start date := date_trunc('month', p_period)::date;
  v_end date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_organic numeric(5,2);
  v_map numeric(5,2);
  v_counted int;
  v_hosts text[];
begin
  select client_id into v_client from locations where id = p_location_id;
  if v_client is null then
    return;
  end if;

  select array_agg(distinct x.h) into v_hosts from (
    select public.url_host(c.website_url) as h from clients c where c.id = v_client
    union all select public.url_host(si.url) from sites si where si.client_id = v_client
    union all select public.url_host(b.website_url) from client_brand_workspaces b where b.client_id = v_client
  ) x where x.h is not null;

  select count(*) into v_counted
  from keywords k
  where k.client_id = v_client and k.is_active and k.priority = 'p1';

  -- Latest in-period position per P1 keyword and result type; keywords with
  -- no ranking in the period stay out of the average, as before. When that
  -- latest organic row is not the client's website, the keyword is left out:
  -- an older website rank is never substituted for the latest check.
  with latest as (
    select distinct on (rs.keyword_id, rs.result_type)
      rs.result_type, rs.position as pos,
      rs.result_type::text <> 'organic'
        or public.organic_rank_state(rs.source::text, rs.position, rs.url_ranked, v_hosts) = 'website' as counts
    from rank_snapshots rs
    join keywords k on k.id = rs.keyword_id
    where rs.location_id = p_location_id
      and k.client_id = v_client and k.is_active and k.priority = 'p1'
      and rs.position is not null
      and rs.recorded_at >= v_start and rs.recorded_at < v_end
    order by rs.keyword_id, rs.result_type, rs.recorded_at desc
  )
  select round(avg(pos) filter (where result_type = 'organic' and counts), 2),
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
revoke execute on function public.compute_location_index(uuid, date) from public, anon, authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare v_bad text;
begin
  if public.organic_rank_state('dataforseo', 3, 'https://www.site.test/a', array['site.test']) <> 'website'
     or public.organic_rank_state('dataforseo', 3, 'https://blog.site.test/a', array['site.test']) <> 'website'
     or public.organic_rank_state('dataforseo', 1, 'https://www.facebook.com/site', array['site.test']) <> 'third_party'
     or public.organic_rank_state('dataforseo', 1, 'https://site.test.evil.test/', array['site.test']) <> 'third_party'
     or public.organic_rank_state('dataforseo', 1, 'https://notsite.test/', array['site.test']) <> 'third_party'
     or public.organic_rank_state('dataforseo', 2, null, array['site.test']) <> 'unverified'
     or public.organic_rank_state('dataforseo', 2, 'https://site.test/', null) <> 'unverified'
     or public.organic_rank_state('brightlocal_report', 2, null, array['site.test']) <> 'website'
     or public.organic_rank_state('dataforseo', null, null, array['site.test']) <> 'not_found' then
    raise exception 'organic_rank_state truth table failed';
  end if;
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%'
    and pg_get_viewdef(c.oid) not like '%portal_client_id()%';
  if v_bad is not null then raise exception 'Portal views missing the client filter: %', v_bad; end if;
  if not exists (select 1 from pg_class where relname = 'client_growth_rankings' and 'security_invoker=true' = any(reloptions))
     or not exists (select 1 from pg_class where relname = 'portal_growth_rankings' and 'security_invoker=false' = any(reloptions) and 'security_barrier=true' = any(reloptions))
     or not exists (select 1 from pg_class where relname = 'portal_rankings' and 'security_invoker=false' = any(reloptions)) then
    raise exception 'ranking view security options changed';
  end if;
  if has_table_privilege('anon', 'public.portal_rankings', 'select')
     or has_table_privilege('anon', 'public.portal_growth_rankings', 'select')
     or has_table_privilege('authenticated', 'public.portal_rankings', 'update')
     or has_table_privilege('authenticated', 'public.portal_growth_rankings', 'insert')
     or not has_table_privilege('authenticated', 'public.portal_rankings', 'select')
     or not has_table_privilege('authenticated', 'public.client_growth_rankings', 'select') then
    raise exception 'ranking view grants changed';
  end if;
end $$;
