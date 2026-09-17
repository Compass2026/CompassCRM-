-- Client portal, step 1: client sign-ins and what they can read (Sept 17 2026).
--
-- 0036 made every policy team-only. This adds the other side: a client
-- contact can sign in and see their own client, and nothing else.
--
-- The rule is NOT "add client policies to the base tables". Row-level
-- security cannot hide a column, so a portal sign-in reading `clients`
-- directly over PostgREST would still see notes, gbp_spec and drive links.
-- Instead the portal reads a handful of views, each one filtered to the
-- signed-in client and carrying only client-safe columns. The base tables
-- stay team-only, so anything not named here is unreachable by a client —
-- tasks, worker fires, billing, brand internals, other clients.
--
-- Views run as their owner (security_invoker is off), so the WHERE clause in
-- each view IS the boundary. Keep every view filtered by portal_client_id()
-- and keep them SELECT-only to `authenticated`.

-- ── Who is a portal user ────────────────────────────────────────────────────
create table portal_users (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  email text not null,
  name text,
  is_active boolean not null default true,
  invited_at timestamptz,
  invited_by text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (email)
);

comment on table portal_users is
  'A client contact who may sign in to the portal. One client each; never a team member.';

alter table portal_users enable row level security;
create policy "team full access" on portal_users
  for all to authenticated using ((select is_team())) with check ((select is_team()));
create policy "portal user reads own row" on portal_users
  for select to authenticated using (auth_user_id = auth.uid());

-- Same linking rule as team_members: invite the account first, then the row
-- (or either order — the trigger and the invite action both link by email).
create or replace function link_portal_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.auth_user_id is null then
    select id into new.auth_user_id from auth.users where lower(email) = lower(new.email);
  end if;
  return new;
end $$;
revoke execute on function link_portal_user() from public, anon, authenticated;
create trigger portal_users_link before insert or update of email on portal_users
  for each row execute function link_portal_user();

-- A team member must never also be a portal user: is_team() would be true
-- and the CRM would let them in with a client's scope attached.
create or replace function portal_user_not_team() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from team_members tm where lower(tm.email) = lower(new.email)) then
    raise exception 'Cannot invite % to the portal: that address is a Compass team member', new.email;
  end if;
  return new;
end $$;
revoke execute on function portal_user_not_team() from public, anon, authenticated;
create trigger portal_users_not_team before insert or update of email on portal_users
  for each row execute function portal_user_not_team();

-- ── The scope every view filters by ─────────────────────────────────────────
create or replace function portal_client_id() returns uuid
language sql stable security definer set search_path = public as $$
  select client_id from portal_users
  where auth_user_id = auth.uid() and is_active
  limit 1;
$$;
revoke execute on function portal_client_id() from public, anon;
grant execute on function portal_client_id() to authenticated, service_role;
comment on function portal_client_id() is
  'The client the signed-in portal user belongs to, or null. Every portal view filters by it.';

-- ── The views ───────────────────────────────────────────────────────────────
create view portal_client as
  select c.id, c.name, c.city, c.state, c.website_url, c.status::text as status, c.launched_at
  from clients c
  where c.id = (select portal_client_id());

-- Where the work stands, in stage names, with no evidence / next_action /
-- notes (those are written for Tom, not for the client).
create view portal_progress as
  select cp.client_id,
         p.name as pipeline, p.sort_order as pipeline_order,
         s.name as stage, s.sort_order as stage_order,
         cs.status::text as status, cs.completed_at
  from client_pipelines cp
  join pipelines p on p.id = cp.pipeline_id
  join client_stages cs on cs.client_pipeline_id = cp.id
  join stages s on s.id = cs.stage_id
  where cp.client_id = (select portal_client_id())
    and cp.status::text <> 'pending';

-- Tracked keywords: where they sit now and where they sat last week.
create view portal_rankings as
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

create view portal_search_performance as
  select client_id, period_start, period_end,
         sum(clicks) as clicks,
         sum(impressions) as impressions,
         round(avg(avg_position)::numeric, 1) as avg_position,
         count(*) as queries
  from gsc_snapshots
  where client_id = (select portal_client_id())
  group by client_id, period_start, period_end;

create view portal_search_queries as
  select client_id, query, page, clicks, impressions, ctr, avg_position, period_start, period_end
  from gsc_snapshots
  where client_id = (select portal_client_id());

-- What we did: approved changes and published posts. Never `reasoning`,
-- `evidence` or anything still `proposed`.
create view portal_work_log as
  select l.client_id,
         l.created_at as at,
         'change'::text as kind,
         l.change_type::text as label,
         l.object_type::text as detail,
         null::text as url
  from change_log l
  where l.client_id = (select portal_client_id())
    and l.status::text = 'approved'
  union all
  select p.client_id,
         p.published_at::timestamptz,
         'post'::text,
         p.title,
         null::text,
         p.url
  from content_posts p
  where p.client_id = (select portal_client_id())
    and p.status::text = 'published';

create view portal_reports as
  select client_id, period, status::text as status, report_url, summary, completed_at
  from monthly_cycles
  where client_id = (select portal_client_id())
    and (report_url is not null or status::text = 'complete');

create view portal_site as
  select client_id, url, staging_url, launched_at, last_pushed_at
  from sites
  where client_id = (select portal_client_id());

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants ALL on new objects in `public` to anon and authenticated by
-- default. A simple view (portal_client, portal_site) is auto-updatable, and a
-- write through a view runs as the view's owner — so leaving those defaults in
-- place would let a portal sign-in UPDATE the client row behind the view.
-- Revoke everything first, then hand back exactly SELECT.
do $$
declare
  v text;
begin
  foreach v in array array[
    'portal_client', 'portal_progress', 'portal_rankings', 'portal_search_performance',
    'portal_search_queries', 'portal_work_log', 'portal_reports', 'portal_site'
  ] loop
    execute format('alter view %I set (security_invoker = false)', v);
    execute format('revoke all on %I from public, anon, authenticated', v);
    execute format('grant select on %I to authenticated', v);
  end loop;
end $$;

-- portal_users keeps its write privileges for `authenticated` because Tom
-- invites from the app with his own session; the policies above are what
-- restrict those writes to team members. anon gets nothing.
revoke all on portal_users from public, anon;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare
  v_bad text;
begin
  -- Every portal view must filter by portal_client_id(); one that does not
  -- would serve every client's rows to every portal sign-in.
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%'
    and pg_get_viewdef(c.oid) not like '%portal_client_id()%';
  if v_bad is not null then
    raise exception 'Portal views missing the client filter: %', v_bad;
  end if;

  -- No portal view may be writable by a client (a write through a view runs
  -- as the view's owner and would bypass RLS), and anon gets nothing at all.
  select string_agg(distinct g.table_name || ' ' || g.privilege_type, ', ') into v_bad
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = g.table_schema
  where g.table_schema = 'public' and g.table_name like 'portal\_%'
    and ((g.grantee = 'authenticated' and c.relkind = 'v' and g.privilege_type <> 'SELECT')
      or g.grantee = 'anon' or g.grantee = 'PUBLIC');
  if v_bad is not null then
    raise exception 'Unexpected portal grants: %', v_bad;
  end if;
end $$;
