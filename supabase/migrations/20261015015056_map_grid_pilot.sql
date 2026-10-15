-- Independent Maps scans. BrightLocal imports and organic rank jobs stay intact.
create table public.map_grid_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  grid_config_id uuid not null unique references public.grid_configs(id) on delete cascade,
  label text not null,
  target_place_id text not null check (length(target_place_id) between 10 and 300),
  points jsonb not null check (jsonb_typeof(points)='array' and jsonb_array_length(points) between 1 and 225),
  keywords jsonb not null check (jsonb_typeof(keywords)='array' and jsonb_array_length(keywords) between 1 and 10),
  zoom integer not null default 13 check (zoom between 3 and 21),
  enabled boolean not null default false,
  weekly_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  check (jsonb_array_length(points)*jsonb_array_length(keywords)<=1000)
);
create table public.map_grid_runs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.map_grid_profiles(id) on delete cascade,
  request_key text not null check (length(request_key) between 1 and 100),
  config jsonb not null,
  status text not null default 'running' check (status in ('running','complete','partial','failed')),
  expected_checks integer not null check (expected_checks between 1 and 1000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  lease_until timestamptz not null default now(),
  error text,
  unique(profile_id,request_key)
);
create unique index map_grid_one_running on public.map_grid_runs(profile_id) where status='running';
create index map_grid_runs_history on public.map_grid_runs(profile_id,started_at desc);
create table public.map_grid_checks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.map_grid_runs(id) on delete cascade,
  keyword_id uuid not null,
  keyword text not null,
  point_index integer not null,
  lat double precision not null check (lat between -85 and 85),
  lng double precision not null check (lng between -180 and 180),
  state text not null default 'planned' check (state in ('planned','posting','queued','complete','failed','unknown')),
  task_id text unique,
  position integer check (position between 1 and 100),
  results jsonb,
  cost numeric not null default 0,
  error text,
  checked_at timestamptz,
  unique(run_id,keyword_id,point_index)
);
create index map_grid_checks_run on public.map_grid_checks(run_id,state);
create index map_grid_profiles_client on public.map_grid_profiles(client_id);

alter table public.map_grid_profiles enable row level security;
alter table public.map_grid_runs enable row level security;
alter table public.map_grid_checks enable row level security;
revoke all on public.map_grid_profiles,public.map_grid_runs,public.map_grid_checks from public,anon,authenticated;
grant select on public.map_grid_profiles,public.map_grid_runs,public.map_grid_checks to authenticated;
grant all on public.map_grid_profiles,public.map_grid_runs,public.map_grid_checks to service_role;
create policy team_read on public.map_grid_profiles for select to authenticated using ((select public.is_team()));
create policy team_read on public.map_grid_runs for select to authenticated using ((select public.is_team()));
create policy team_read on public.map_grid_checks for select to authenticated using ((select public.is_team()));

-- Atomic idempotency + budget guard. Only the authenticated Edge runtime calls it.
create function public.map_grid_start(p_profile_id uuid,p_request_key text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.map_grid_profiles; r uuid; k jsonb; pt jsonb; i integer;
begin
  select * into strict p from public.map_grid_profiles where id=p_profile_id for update;
  select id into r from public.map_grid_runs where profile_id=p.id and request_key=p_request_key;
  if r is not null then return r; end if;
  if not p.enabled then raise exception 'Grid pilot is disabled'; end if;
  if exists(select 1 from public.map_grid_runs where profile_id=p.id and status='running') then
    raise exception 'A grid scan is already running';
  end if;
  if exists(select 1 from public.map_grid_runs where profile_id=p.id and started_at>now()-interval '1 hour') then
    raise exception 'Wait one hour before starting another scan';
  end if;
  -- Reject mismatched client references before any provider spend.
  if not exists(select 1 from public.grid_configs g join public.locations l on l.id=g.location_id
    where g.id=p.grid_config_id and l.client_id=p.client_id) then raise exception 'Grid client mismatch'; end if;
  for k in select value from jsonb_array_elements(p.keywords) loop
    if not exists(select 1 from public.keywords where id=(k->>'id')::uuid and client_id=p.client_id and keyword=k->>'keyword') then
      raise exception 'Grid keyword mismatch';
    end if;
  end loop;
  insert into public.map_grid_runs(profile_id,request_key,config,expected_checks)
    values(p.id,p_request_key,to_jsonb(p),jsonb_array_length(p.points)*jsonb_array_length(p.keywords)) returning id into r;
  for k in select value from jsonb_array_elements(p.keywords) loop
    i:=0;
    for pt in select value from jsonb_array_elements(p.points) loop
      insert into public.map_grid_checks(run_id,keyword_id,keyword,point_index,lat,lng)
        values(r,(k->>'id')::uuid,k->>'keyword',i,(pt->>'lat')::float8,(pt->>'lng')::float8);
      i:=i+1;
    end loop;
  end loop;
  return r;
end $$;
revoke all on function public.map_grid_start(uuid,text) from public,anon,authenticated;
grant execute on function public.map_grid_start(uuid,text) to service_role;

-- The weekly job selects only explicitly enabled profiles. Empty until pilot setup.
select cron.schedule('map-grid-weekly','0 14 * * 4',$$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/map-grid-sync',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:='{"mode":"weekly"}'::jsonb,timeout_milliseconds:=30000)
$$);
select cron.schedule('map-grid-collect','*/5 * * * *',$$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/map-grid-sync',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:='{"mode":"collect"}'::jsonb,timeout_milliseconds:=30000)
$$);
