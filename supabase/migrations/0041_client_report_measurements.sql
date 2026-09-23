-- Nine-area client scorecards. Additive, no external calls, no client backfill.
-- Requires the reviewed team-access migration 0036 (also required by 0039).
-- This file does NOT grant portal access or introduce an organization model.
-- No BEGIN/COMMIT here: apply_migration runs the file in one transaction with
-- its version record, and an inner COMMIT would end that transaction early.
-- Applied after 0043 in production (0041 was held back for review); it only
-- adds objects and does not depend on 0042 or 0043.
do $$ begin
  if to_regprocedure('public.is_team()') is null then
    raise exception 'Apply and verify the reviewed team-access prerequisites before 0041';
  end if;
end $$;

create sequence public.report_measurement_sequence;
create table public.report_measurements (
  id uuid primary key default gen_random_uuid(), -- stable submission/import id
  -- sequence / created_at / recorded_by are always stamped by the insert
  -- trigger. The inert defaults only let callers omit them (and make the
  -- generated Insert type mark them optional); a caller's value is overwritten.
  sequence bigint not null unique default 0, -- assigned inside the serialized insert trigger
  client_id uuid not null references public.clients(id) on delete restrict,
  metric text not null check (metric in (
    'pages_live','pages_indexed','broken_links',
    'citations_correct','citations_incorrect','citations_missing',
    'referring_domains','links_new','links_lost',
    'gbp_views','gbp_clicks','gbp_call_clicks',
    'reviews_total','reviews_rating','reviews_new','reviews_unanswered',
    'organic_top3','organic_top10','maps_top3',
    'search_impressions','search_clicks','organic_sessions',
    'forms','calls','qualified_leads',
    'social_posts','social_plan','social_reach','social_engagements','social_clicks','social_followers'
  )),
  scope text not null check (length(btrim(scope)) between 1 and 300),
  source text not null check (length(btrim(source)) between 1 and 150),
  platform text not null default 'none' check (platform in ('none','facebook','instagram','linkedin','youtube','tiktok','x','pinterest','other')),
  channel text not null default 'none' check (channel in ('none','organic','paid')),
  context text not null check (context in ('before_work','existing_client')),
  report_period date check (extract(day from report_period) = 1), -- NULL = initial measurement
  window_start date not null,
  window_end date not null,
  status text not null check (status in ('measured','not_measured','not_connected','stale','not_applicable')),
  value numeric,
  evidence text not null default '' check (length(evidence) <= 1000),
  meaning text not null check (length(btrim(meaning)) between 1 and 1000),
  next_action text not null check (length(btrim(next_action)) between 1 and 1000),
  created_at timestamptz not null default now(),
  recorded_by text not null default '',
  check (window_start <= window_end),
  check (report_period is null or date_trunc('month', window_end)::date = report_period),
  check ((metric like 'social_%' and platform <> 'none' and channel <> 'none') or
         (metric not like 'social_%' and platform = 'none' and channel = 'none')),
  check ((status = 'measured' and value is not null and length(btrim(evidence)) > 0) or
         (status <> 'measured' and value is null)),
  check (value is null or (value between -1000000000000 and 1000000000000
    and (metric = 'social_followers' or value >= 0)
    and (case when metric = 'reviews_rating' then value <= 5 else value = trunc(value) end))),
  check (metric not in ('pages_live','pages_indexed','broken_links',
    'citations_correct','citations_incorrect','citations_missing','referring_domains',
    'reviews_total','reviews_rating','reviews_unanswered','organic_top3','organic_top10','maps_top3')
    or window_start = window_end)
);
create index report_measurements_client_order on public.report_measurements(client_id, sequence);
create index report_measurements_client_period on public.report_measurements(client_id, report_period);

create function public.guard_report_measurement() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Report history is immutable. Append a correction instead.' using errcode = '23514';
  end if;
  -- "Today" is Compass's day (America/Chicago), as in the app; created_at
  -- stays a UTC timestamptz.
  if new.window_end > (current_timestamp at time zone 'America/Chicago')::date then
    raise exception 'Measurement dates cannot be in the future' using errcode = '23514';
  end if;
  new.scope := btrim(new.scope);
  new.source := btrim(new.source);
  -- Serialize each series so a delayed concurrent commit cannot replace its
  -- first measured baseline. Backdated entries always get a later sequence.
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    new.client_id, new.metric, new.scope, new.source, new.platform, new.channel
  )::text, 0));
  new.sequence := nextval('public.report_measurement_sequence');
  new.created_at := clock_timestamp();
  new.recorded_by := coalesce(auth.uid()::text, auth.role(), session_user);
  return new;
end $$;
revoke all on function public.guard_report_measurement() from public, anon, authenticated;
create trigger report_measurement_immutable before insert or update or delete on public.report_measurements
  for each row execute function public.guard_report_measurement();

alter table public.report_measurements enable row level security;
create policy "team read report measurements" on public.report_measurements
  for select to authenticated using ((select public.is_team()));
create policy "team append report measurements" on public.report_measurements
  for insert to authenticated with check ((select public.is_team()) and recorded_by = (select auth.uid())::text);
-- Supabase default privileges may include ALL. Explicitly remove them.
revoke all on public.report_measurements from public, anon, authenticated, service_role;
grant select, insert on public.report_measurements to authenticated, service_role;
revoke all on sequence public.report_measurement_sequence from public, anon, authenticated, service_role;

comment on table public.report_measurements is
  'Append-only, client-owned scorecard evidence. First measured sequence per client/metric/scope/source/platform/channel is the permanent baseline. Null report_period is onboarding; monthly periods name the data month, not the worker cycle month. No portal access.';

-- New intake only. No backfill and no worker fire or customer write here.
create function public.create_reporting_baseline_task() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.tasks(client_id, title, owner, key, notes)
  values (new.id, 'Review the starting marketing baseline before improvements', 'TOM', 'reporting_baseline',
    'Reports > Starting baseline: review all nine areas, record dated evidence where available, and explain missing sources. First measurements captured after work starts must say existing client. Review does not authorize publishing or sending.');
  return new;
end $$;
revoke all on function public.create_reporting_baseline_task() from public, anon, authenticated;
create trigger clients_reporting_baseline after insert on public.clients
  for each row execute function public.create_reporting_baseline_task();
