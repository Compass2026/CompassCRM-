-- One row per weekly start attempt per profile, so a skipped week is visible
-- instead of silent. Team-readable; only the service-role Edge runtime writes.
create table public.map_grid_weekly_attempts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.map_grid_profiles(id) on delete cascade,
  request_key text not null check (length(request_key) between 1 and 100),
  outcome text not null check (outcome in ('started','already_running','cooldown','disabled','error')),
  run_id uuid references public.map_grid_runs(id) on delete set null,
  message text check (message is null or length(message) <= 500),
  attempted_at timestamptz not null default now()
);
create index map_grid_weekly_attempts_profile on public.map_grid_weekly_attempts(profile_id,attempted_at desc);

alter table public.map_grid_weekly_attempts enable row level security;
revoke all on public.map_grid_weekly_attempts from public,anon,authenticated;
grant select on public.map_grid_weekly_attempts to authenticated;
grant all on public.map_grid_weekly_attempts to service_role;
create policy team_read on public.map_grid_weekly_attempts for select to authenticated using ((select public.is_team()));
