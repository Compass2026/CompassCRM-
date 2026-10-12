-- Client progress reads the existing immutable measurement ledger.
-- Portal views deliberately follow 0037's owner-view boundary: explicit
-- client filter, minimal columns, SELECT only. No base-table portal access.
create view public.portal_growth_measurements with (security_barrier = true, security_invoker = false) as
select id, client_id, sequence, metric, scope, source, platform, channel,
       context, report_period, window_start, window_end, status, value, created_at
from public.report_measurements
where client_id = (select public.portal_client_id());
revoke all on public.portal_growth_measurements from public, anon, authenticated;
grant select on public.portal_growth_measurements to authenticated;

-- Aggregated imported query/page rows, explicitly NOT property-wide totals.
create view public.client_growth_search with (security_invoker = true) as
select client_id, period_start, period_end, sum(clicks)::bigint as clicks,
       sum(impressions)::bigint as impressions, count(*)::bigint as imported_rows
from public.gsc_snapshots group by client_id, period_start, period_end;
revoke all on public.client_growth_search from public, anon, authenticated;
grant select on public.client_growth_search to authenticated;
create view public.portal_growth_search with (security_barrier = true, security_invoker = false) as
select client_id, period_start, period_end, sum(clicks)::bigint as clicks,
       sum(impressions)::bigint as impressions, count(*)::bigint as imported_rows
from public.gsc_snapshots where client_id = (select public.portal_client_id())
group by client_id, period_start, period_end;
revoke all on public.portal_growth_search from public, anon, authenticated;
grant select on public.portal_growth_search to authenticated;

create table public.backlink_opportunities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  keyword_id uuid not null references public.keywords(id) on delete restrict,
  brand_workspace_id uuid references public.client_brand_workspaces(id) on delete restrict,
  target_url text not null check (length(target_url) <= 2000 and target_url ~ '^https?://[^/[:space:]?#]+'),
  source_url text not null check (length(source_url) <= 2000 and source_url ~ '^https?://[^/[:space:]?#]+'),
  title text not null check (length(btrim(title)) between 1 and 200),
  kind text not null check (kind in ('association','supplier','local_publication','partner','resource','directory','other')),
  stage text not null default 'research' check (stage in ('research','ready','contacted','submitted','placed','closed')),
  next_action text not null default '' check (length(next_action) <= 1000),
  due_on date,
  notes text not null default '' check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, source_url, target_url)
);
create index backlink_opportunities_client on public.backlink_opportunities(client_id, created_at, id);
create index backlink_opportunities_keyword on public.backlink_opportunities(keyword_id);
create index backlink_opportunities_brand on public.backlink_opportunities(brand_workspace_id) where brand_workspace_id is not null;
alter table public.backlink_opportunities enable row level security;
create policy "team backlink opportunities" on public.backlink_opportunities
  to authenticated using ((select public.is_team())) with check ((select public.is_team()));
revoke all on public.backlink_opportunities from public, anon, authenticated, service_role;
grant select, insert, update on public.backlink_opportunities to authenticated;
grant select, insert, update on public.backlink_opportunities to service_role;

-- A check is dated evidence entered by a teammate. Unreachable is not lost.
-- URLs on the opportunity are immutable: a new placement needs a new record.
create table public.backlink_checks (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.backlink_opportunities(id) on delete restrict,
  observed_on date not null,
  result text not null check (result in ('live','missing','unreachable')),
  rel text not null default 'unknown' check (rel in ('follow','nofollow','sponsored','ugc','unknown')),
  anchor_text text not null default '' check (length(anchor_text) <= 500),
  evidence text not null check (length(btrim(evidence)) between 1 and 2000),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id)
);
create index backlink_checks_latest on public.backlink_checks(opportunity_id, observed_on desc, recorded_at desc, id desc);
alter table public.backlink_checks enable row level security;
create policy "team read backlink checks" on public.backlink_checks for select to authenticated using ((select public.is_team()));
create policy "team append backlink checks" on public.backlink_checks for insert to authenticated with check ((select public.is_team()));
revoke all on public.backlink_checks from public, anon, authenticated, service_role;
grant select, insert on public.backlink_checks to authenticated, service_role;

create function public.guard_backlink_opportunity() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare k public.keywords; b public.client_brand_workspaces; expected_host text; target_host text;
begin
  if tg_op = 'UPDATE' and (new.id,new.client_id,new.keyword_id,new.brand_workspace_id,new.target_url,new.source_url,new.created_at)
    is distinct from (old.id,old.client_id,old.keyword_id,old.brand_workspace_id,old.target_url,old.source_url,old.created_at) then
    raise exception 'Placement identity is immutable. Create a new opportunity for a different keyword or URL.' using errcode='23514';
  end if;
  select * into k from public.keywords where id=new.keyword_id and client_id=new.client_id;
  if k.id is null then raise exception 'Select a keyword belonging to this client' using errcode='23514'; end if;
  if tg_op = 'INSERT' then
    if not k.is_active then raise exception 'Select an active keyword' using errcode='23514'; end if;
    if exists(select 1 from public.client_brand_workspaces where client_id=new.client_id) then
      select * into b from public.client_brand_workspaces where id=new.brand_workspace_id
        and client_id=new.client_id and k.service_id=any(service_ids);
      if b.id is null then raise exception 'Keyword and destination must belong to the selected brand' using errcode='23514'; end if;
      expected_host := lower(substring(b.website_url from '^https?://([^/]+)'));
    else
      if new.brand_workspace_id is not null then raise exception 'Invalid brand' using errcode='23514'; end if;
      select lower(substring(website_url from '^https?://([^/]+)')) into expected_host from public.clients where id=new.client_id;
    end if;
    target_host := lower(substring(new.target_url from '^https?://([^/]+)'));
    if expected_host is null or regexp_replace(target_host,'^www\.','') <> regexp_replace(expected_host,'^www\.','') then
      raise exception 'Target URL must use this client or brand website' using errcode='23514';
    end if;
    if regexp_replace(lower(substring(new.source_url from '^https?://([^/]+)')),'^www\.','') = regexp_replace(target_host,'^www\.','') then
      raise exception 'A backlink must come from another website' using errcode='23514';
    end if;
    new.created_at := clock_timestamp();
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke all on function public.guard_backlink_opportunity() from public, anon, authenticated;
create trigger guard_backlink_opportunity before insert or update on public.backlink_opportunities
for each row execute function public.guard_backlink_opportunity();

create function public.guard_backlink_check() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Link checks are immutable. Append a new check.' using errcode='23514'; end if;
  if new.observed_on > (current_timestamp at time zone 'America/Chicago')::date then
    raise exception 'Link checks cannot be in the future' using errcode='23514';
  end if;
  new.recorded_at := clock_timestamp(); new.recorded_by := auth.uid();
  return new;
end $$;
revoke all on function public.guard_backlink_check() from public, anon, authenticated;
create trigger guard_backlink_check before insert or update or delete on public.backlink_checks
for each row execute function public.guard_backlink_check();

create view public.portal_backlinks with (security_barrier = true, security_invoker = false) as
select o.id, o.client_id, o.title, o.source_url, o.target_url, k.keyword,
       b.name as brand_name, c.observed_on, c.result, c.rel, c.anchor_text,
       (select min(x.observed_on) from public.backlink_checks x where x.opportunity_id=o.id and x.result='live') as first_live_on
from public.backlink_opportunities o
join public.keywords k on k.id=o.keyword_id
left join public.client_brand_workspaces b on b.id=o.brand_workspace_id
join lateral (select * from public.backlink_checks x where x.opportunity_id=o.id
  order by observed_on desc, recorded_at desc, id desc limit 1) c on true
where o.client_id=(select public.portal_client_id())
  and exists(select 1 from public.backlink_checks x where x.opportunity_id=o.id and x.result='live');
revoke all on public.portal_backlinks from public, anon, authenticated;
grant select on public.portal_backlinks to authenticated;

comment on table public.backlink_opportunities is 'Keyword-led acquisition workflow. Stage placed is not evidence of a live link. No automatic outreach.';
comment on table public.backlink_checks is 'Append-only teammate verification. Tracks known placements, not the complete web backlink profile.';
