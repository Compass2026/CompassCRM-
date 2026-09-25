-- 0048 Authority Engine D2: persisted runs and first-class opportunities.
--
-- The deterministic engine (supabase/functions/authority, D1.1) stays the
-- source of truth for WHAT to recommend; Client Intelligence and the live
-- source tables stay the source of truth for client facts. This migration
-- only records what the engine said (authority_runs), gives each opportunity
-- a durable identity with a human workflow (authority_opportunities), keeps
-- an append-only history (authority_opportunity_events) and links the work
-- that came out of it (authority_opportunity_links).
--
-- Writers
--   authority_begin_run / authority_record_run   the authority-run Edge Function only
--                                                (PostgREST's authenticator login + service_role)
--   authority_decide                             a signed-in teammate through PostgREST;
--                                                the same function for accept / link only
-- Nothing else writes these tables: no API grants, no write policies, and a
-- guard trigger refuses any write outside those functions — including the
-- worker's SQL (session_user postgres) and a raw service-role REST call.
--
-- Workflow status (stored): open → accepted → dismissed. in_progress and
-- completed are DERIVED from links (authority_opportunity_state), so they can
-- never be claimed without an asset: accepted moves to in_progress only when
-- a resulting asset / task / change is linked, and to completed only when
-- that asset is done. resolved = the latest completed run no longer reports
-- the opportunity. A degraded run changes no opportunity at all.
--
-- Dismissal: a normal dismissal needs a reason AND a date (dismissed_until;
-- the UI offers 30 / 60 / 90 days). A request without a date is refused.
-- When the date passes, the opportunity returns to open if the engine still
-- reports it. The only permanent state is the explicit, separate
-- suppressed = true ("never recommend again"), which has no date.

-- Markets: D2 keeps the governed locations model (locations.is_active =
-- approved). Physical / service locations and SEO market targets may become
-- separate concepts in D3; nothing here models market areas.
--
-- Rollback (before any run is recorded): drop the view, the functions and
-- the four tables, and the two (id, client_id) constraints added in §1.

-- ── 1. Composite keys the links need (additive) ─────────────────────────────
alter table content_posts add constraint content_posts_id_client_key unique (id, client_id);
alter table change_log    add constraint change_log_id_client_key    unique (id, client_id);
-- social_posts, drafter_runs, tasks already carry (id, client_id) keys (0043, 0045, 0047).

-- ── 2. Tables ───────────────────────────────────────────────────────────────
create table authority_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null default 'running' check (status in ('running', 'completed', 'degraded', 'failed')),
  mode text not null check (mode in ('full', 'refresh')),
  requested_via text not null check (requested_via in ('team', 'worker')),
  requested_by uuid references team_members(id) on delete set null,
  finished_at timestamptz,
  engine_version text check (engine_version ~ '^authority-v[0-9.]+$'),
  judged_at timestamptz,
  as_of date,
  input_hash text check (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  section_hashes jsonb,
  inventory_fetched_at timestamptz,
  inventory_pages int check (inventory_pages >= 0),
  inventory_errors int check (inventory_errors >= 0),
  inventory jsonb,            -- the public-site observation (not held anywhere else)
  sources jsonb,              -- report.sources: GSC window / rows / coverage, ranks, inventory
  report jsonb,               -- the engine's report, as produced
  counts jsonb,               -- {by_section, by_action, by_tier}
  previous_run_id uuid,
  diff jsonb,                 -- {added, resolved, regressed, section_changed, reopened} opportunity keys
  error text,
  constraint authority_runs_id_client_key unique (id, client_id),
  constraint authority_runs_previous_fk foreign key (previous_run_id, client_id) references authority_runs (id, client_id),
  constraint authority_runs_finish check ((status = 'running') = (finished_at is null)),
  constraint authority_runs_result check (status not in ('completed', 'degraded')
    or (report is not null and engine_version is not null and input_hash is not null and judged_at is not null)),
  constraint authority_runs_failure check (status <> 'failed' or error is not null)
);
create unique index authority_runs_one_running on authority_runs (client_id) where status = 'running';
create index authority_runs_client_idx on authority_runs (client_id, created_at desc);
comment on table authority_runs is
  'Authority Engine runs (audit). Written only by authority_begin_run / authority_record_run (the authority-run function). Not a source of client facts.';

create table authority_opportunities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  key text not null check (key ~ '^[a-z_]+:[A-Za-z0-9_:/.''-]+$' and length(key) <= 300),
  first_seen_run_id uuid not null,
  last_seen_run_id uuid not null,
  last_seen_at timestamptz not null,
  present boolean not null default true,
  -- snapshot from the last run that reported it
  section text not null check (section in ('fix_now', 'ready', 'needs_decision', 'research', 'blocked', 'avoid')),
  action text not null check (action in ('create', 'improve', 'refresh', 'consolidate', 'avoid', 'insufficient_evidence',
                                         'research_required', 'requires_confirmation', 'blocked_data_prerequisite')),
  tier text not null check (tier in ('A', 'B', 'C', 'none')),
  content_type text not null,
  topic text not null,
  service_id uuid,
  keyword_id uuid,
  intent text,
  target_path text,
  sort_order int[] not null default '{}',
  eligible_from date,
  opportunity jsonb not null,
  -- human workflow
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  dismissed_until date,
  suppressed boolean not null default false,
  status_reason text,
  decided_by uuid references team_members(id) on delete set null,
  decided_at timestamptz,
  constraint authority_opportunities_client_key unique (client_id, key),
  constraint authority_opportunities_id_client_key unique (id, client_id),
  constraint authority_opportunities_first_run_fk foreign key (first_seen_run_id, client_id) references authority_runs (id, client_id),
  constraint authority_opportunities_last_run_fk foreign key (last_seen_run_id, client_id) references authority_runs (id, client_id),
  -- every dismissal has a reason; a normal one has a date, a suppression has none
  constraint authority_opportunities_dismissal check (status <> 'dismissed' or length(btrim(coalesce(status_reason, ''))) > 0),
  constraint authority_opportunities_dismissal_dated check (status <> 'dismissed' or suppressed or dismissed_until is not null),
  constraint authority_opportunities_suppressed check (not suppressed or (status = 'dismissed' and dismissed_until is null)),
  constraint authority_opportunities_undismissed check (status = 'dismissed' or dismissed_until is null)
);
create index authority_opportunities_client_idx on authority_opportunities (client_id, present, section);
comment on table authority_opportunities is
  'One row per Authority opportunity key per client: the latest engine snapshot plus the human workflow. in_progress / completed / resolved are derived (authority_opportunity_state).';

create table authority_opportunity_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null,
  client_id uuid not null,
  run_id uuid,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('created', 'section_changed', 'resolved', 'regressed', 'reopened',
                                     'accepted', 'released', 'dismissed', 'suppressed', 'linked', 'decision')),
  actor_kind text not null check (actor_kind in ('team', 'engine', 'drafter')),
  actor_id uuid references team_members(id) on delete set null,
  detail jsonb not null default '{}',
  constraint authority_events_opportunity_fk foreign key (opportunity_id, client_id)
    references authority_opportunities (id, client_id) on delete cascade,
  constraint authority_events_run_fk foreign key (run_id, client_id) references authority_runs (id, client_id)
);
create index authority_events_opportunity_idx on authority_opportunity_events (opportunity_id, created_at);
comment on table authority_opportunity_events is
  'Append-only Authority opportunity history, written only inside the authority functions.';

create table authority_opportunity_links (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references team_members(id) on delete set null,
  kind text not null check (kind in ('social_post', 'drafter_run', 'content_post', 'change_log', 'task')),
  ref_id uuid not null,                     -- the asset as linked (kept if the asset is later deleted)
  social_post_id uuid, drafter_run_id uuid, content_post_id uuid, change_log_id uuid, task_id uuid,
  constraint authority_links_opportunity_fk foreign key (opportunity_id, client_id)
    references authority_opportunities (id, client_id) on delete cascade,
  constraint authority_links_social_post_fk foreign key (social_post_id, client_id)
    references social_posts (id, client_id) on delete set null (social_post_id),
  constraint authority_links_drafter_run_fk foreign key (drafter_run_id, client_id)
    references drafter_runs (id, client_id) on delete set null (drafter_run_id),
  constraint authority_links_content_post_fk foreign key (content_post_id, client_id)
    references content_posts (id, client_id) on delete set null (content_post_id),
  constraint authority_links_change_log_fk foreign key (change_log_id, client_id)
    references change_log (id, client_id) on delete set null (change_log_id),
  constraint authority_links_task_fk foreign key (task_id, client_id)
    references tasks (id, client_id) on delete set null (task_id),
  -- the column for the kind holds ref_id (or NULL once the asset is gone); no other column is set
  constraint authority_links_one_asset check (num_nonnulls(social_post_id, drafter_run_id, content_post_id, change_log_id, task_id) <= 1
    and coalesce(case kind when 'social_post' then social_post_id when 'drafter_run' then drafter_run_id
                           when 'content_post' then content_post_id when 'change_log' then change_log_id
                           when 'task' then task_id end, ref_id) = ref_id
    and (case kind when 'social_post' then num_nonnulls(drafter_run_id, content_post_id, change_log_id, task_id)
                   when 'drafter_run' then num_nonnulls(social_post_id, content_post_id, change_log_id, task_id)
                   when 'content_post' then num_nonnulls(social_post_id, drafter_run_id, change_log_id, task_id)
                   when 'change_log' then num_nonnulls(social_post_id, drafter_run_id, content_post_id, task_id)
                   when 'task' then num_nonnulls(social_post_id, drafter_run_id, content_post_id, change_log_id) end) = 0),
  constraint authority_links_unique unique (opportunity_id, kind, ref_id)
);
create index authority_links_opportunity_idx on authority_opportunity_links (opportunity_id);
comment on table authority_opportunity_links is
  'Work that came out of an Authority opportunity (post, drafter run, content post, change, task). Real composite FKs keep every link inside its client.';

-- ── 3. Who is calling ────────────────────────────────────────────────────────
-- The authority-run function: PostgREST's login with the service role. The
-- worker's SQL (session_user postgres) never is, whatever role it switches to.
create function authority_caller_is_service() returns boolean
language sql stable set search_path = public as $$
  select session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role'
$$;
revoke execute on function authority_caller_is_service() from public, anon, authenticated;

create function authority_write_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('compass.authority_write', true), '') = 'on'
     and (authority_caller_is_service() or post_caller_is_human())
$$;
revoke execute on function authority_write_active() from public, anon, authenticated;

-- ── 4. The guard: no write outside the functions ────────────────────────────
create function authority_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Deleting the client cascades (its row is already gone when this fires).
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  -- A linked asset deleted: its FK column is set NULL by the referential action.
  if tg_table_name = 'authority_opportunity_links' and tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and (to_jsonb(new) - array['social_post_id', 'drafter_run_id', 'content_post_id', 'change_log_id', 'task_id'])
       = (to_jsonb(old) - array['social_post_id', 'drafter_run_id', 'content_post_id', 'change_log_id', 'task_id']) then
    return new;
  end if;
  if not authority_write_active() then
    raise exception 'Authority records are written only by the authority functions' using errcode = '42501';
  end if;
  if tg_table_name in ('authority_opportunity_events', 'authority_opportunity_links') and tg_op <> 'INSERT' then
    raise exception '% is append-only', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'authority_runs' then
    if tg_op = 'DELETE' then raise exception 'Authority runs are kept' using errcode = '42501'; end if;
    if tg_op = 'UPDATE' and old.status <> 'running' then
      raise exception 'A finished Authority run is immutable' using errcode = '42501';
    end if;
  end if;
  if tg_table_name = 'authority_opportunities' and tg_op = 'DELETE' then
    raise exception 'Authority opportunities are kept' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function authority_guard() from public, anon, authenticated;

create trigger authority_runs_guard before insert or update or delete on authority_runs
  for each row execute function authority_guard();
create trigger authority_opportunities_guard before insert or update or delete on authority_opportunities
  for each row execute function authority_guard();
create trigger authority_events_guard before insert or update or delete on authority_opportunity_events
  for each row execute function authority_guard();
create trigger authority_links_guard before insert or update or delete on authority_opportunity_links
  for each row execute function authority_guard();

-- ── 5. Access: team reads, nobody writes through the API ───────────────────
alter table authority_runs enable row level security;
alter table authority_opportunities enable row level security;
alter table authority_opportunity_events enable row level security;
alter table authority_opportunity_links enable row level security;
create policy "team reads authority runs" on authority_runs for select to authenticated using ((select is_team()));
create policy "team reads authority opportunities" on authority_opportunities for select to authenticated using ((select is_team()));
create policy "team reads authority history" on authority_opportunity_events for select to authenticated using ((select is_team()));
create policy "team reads authority links" on authority_opportunity_links for select to authenticated using ((select is_team()));
revoke all on authority_runs, authority_opportunities, authority_opportunity_events, authority_opportunity_links from public, anon, authenticated;
grant select on authority_runs, authority_opportunities, authority_opportunity_events, authority_opportunity_links to authenticated;
grant select on authority_runs, authority_opportunities, authority_opportunity_events, authority_opportunity_links to service_role;

-- ── 6. Reads: the engine input and the staleness fingerprint ────────────────
-- The Authority input: the canonical Client Intelligence loader plus the
-- authority section (scripts/authority-input.sql is this, for psql).
-- Invoker rights: RLS decides what the caller sees.
create function authority_input(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select client_intelligence_input(p_client_id) || jsonb_build_object('authority', jsonb_build_object(
    'now', now(),
    'site', (select jsonb_build_object('url', coalesce(s.url, cl.website_url), 'content_paths', s.content_paths,
              'work_mode', s.work_mode, 'adapter', s.content_adapter)
             from clients cl left join sites s on s.client_id = cl.id where cl.id = p_client_id
             order by s.created_at limit 1),
    'pageGroupsFull', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'page_type', g.page_type,
              'status', g.status, 'city_tier', g.city_tier, 'target_url', g.target_url, 'primary_keyword_id', g.primary_keyword_id,
              'supporting_keyword_ids', g.supporting_keyword_ids) order by g.name, g.id)
             from page_groups g where g.client_id = p_client_id), '[]'::jsonb),
    'keywordExtras', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'volume', k.volume, 'cpc', k.cpc, 'city', k.city) order by k.id)
             from keywords k where k.client_id = p_client_id), '[]'::jsonb),
    'moneyKeywordIds', coalesce((select jsonb_agg(m.keyword_id order by m.keyword_id) from money_keywords m where m.client_id = p_client_id), '[]'::jsonb),
    'gsc', coalesce((select jsonb_agg(jsonb_build_object('query', g.query, 'page', g.page, 'impressions', g.impressions,
              'clicks', g.clicks, 'avg_position', g.avg_position, 'period_start', g.period_start, 'period_end', g.period_end,
              'keyword_id', g.keyword_id) order by g.period_end, g.query, g.page)
             from gsc_snapshots g where g.client_id = p_client_id), '[]'::jsonb),
    'ranks', coalesce((select jsonb_agg(jsonb_build_object('keyword_id', r.keyword_id, 'result_type', r.result_type,
              'position', r.position, 'url_ranked', r.url_ranked, 'recorded_at', r.recorded_at) order by r.keyword_id, r.result_type)
             from (select distinct on (r.keyword_id, r.result_type) r.*
                   from rank_snapshots r join keywords k on k.id = r.keyword_id
                   where k.client_id = p_client_id
                   order by r.keyword_id, r.result_type, r.recorded_at desc) r), '[]'::jsonb),
    'socialPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'platform', p.platform, 'search_intent', p.search_intent,
              'service_id', p.service_id, 'keyword_id', p.keyword_id, 'review_status', p.review_status,
              'publish_status', p.publish_status, 'review_note', p.review_note, 'created_at', p.created_at,
              'reviewed_at', p.reviewed_at, 'drafter_run_id', p.drafter_run_id, 'copy', p.copy,
              'claim_ids', coalesce((select jsonb_agg(pc.claim_id order by pc.claim_id) from post_claims pc where pc.post_id = p.id), '[]'::jsonb))
              order by p.created_at, p.id)
             from social_posts p where p.client_id = p_client_id), '[]'::jsonb),
    'contentPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status, 'url', p.url,
              'keyword_id', p.keyword_id, 'published_at', p.published_at) order by p.id)
             from content_posts p where p.client_id = p_client_id), '[]'::jsonb),
    'changeLog', coalesce((select jsonb_agg(jsonb_build_object('change_type', l.change_type, 'object_type', l.object_type,
              'status', l.status, 'after', l.after, 'created_at', l.created_at) order by l.created_at, l.id)
             from change_log l where l.client_id = p_client_id and l.change_type in ('page_added', 'page_rewrite')), '[]'::jsonb),
    'inventory', null
  ))
$$;
revoke all on function authority_input(uuid) from public, anon;
grant execute on function authority_input(uuid) to authenticated, service_role;

-- One md5 per source section. A run stores the fingerprint it was built
-- from; a later difference names the stale sections (checked on read — no
-- automatic reruns). Invoker rights.
create function authority_fingerprint(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  with i as (select authority_input(p_client_id) as j)
  select jsonb_build_object(
    'intelligence', md5(((select j from i) - 'asOf' - 'authority')::text),
    'page_groups',  md5(coalesce((select j->'authority'->'pageGroupsFull' from i), 'null')::text),
    'keywords',     md5(coalesce((select (j->'authority'->'keywordExtras') || (j->'authority'->'moneyKeywordIds') from i), 'null')::text),
    'gsc',          coalesce((select max(g.period_end)::text || ':' || count(*) filter (where g.period_end = (select max(period_end) from gsc_snapshots where client_id = p_client_id))
                              from gsc_snapshots g where g.client_id = p_client_id), 'none'),
    'ranks',        coalesce((select max(r.recorded_at)::text from rank_snapshots r join keywords k on k.id = r.keyword_id where k.client_id = p_client_id), 'none'),
    'posts',        md5(coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'r', p.review_status, 'p', p.publish_status) order by p.id)
                                  from social_posts p where p.client_id = p_client_id), '[]')::text),
    'content',      md5(coalesce((select j->'authority'->'contentPosts' from i), 'null')::text),
    'change_log',   md5(coalesce((select j->'authority'->'changeLog' from i), 'null')::text),
    'site',         md5(coalesce((select j->'authority'->'site' from i), 'null')::text)
  )
$$;
revoke all on function authority_fingerprint(uuid) from public, anon;
grant execute on function authority_fingerprint(uuid) to authenticated, service_role;

-- ── 7. Link and lifecycle state (derived) ───────────────────────────────────
-- A linked asset is done, active, or dead (rejected / vetoed / gone).
create function authority_link_state(l authority_opportunity_links) returns text
language sql stable security invoker set search_path = public as $$
  select case l.kind
    when 'social_post' then (select case when p.publish_status = 'published' or p.review_status = 'approved' then 'done'
                                         when p.review_status in ('draft', 'in_review') then 'active' else 'dead' end
                             from social_posts p where p.id = l.social_post_id)
    when 'drafter_run' then (select case when r.status in ('writing', 'submitted') then 'active' else 'dead' end
                             from drafter_runs r where r.id = l.drafter_run_id)
    when 'content_post' then (select case when c.status = 'published' then 'done' else 'active' end
                              from content_posts c where c.id = l.content_post_id)
    when 'change_log' then (select case c.status when 'approved' then 'done' when 'proposed' then 'active' else 'dead' end
                            from change_log c where c.id = l.change_log_id)
    when 'task' then (select case when t.status = 'done' then 'done' else 'active' end
                      from tasks t where t.id = l.task_id)
  end
$$;
revoke all on function authority_link_state(authority_opportunity_links) from public, anon;
grant execute on function authority_link_state(authority_opportunity_links) to authenticated, service_role;

-- The effective workflow status: open | accepted | in_progress | completed |
-- dismissed | resolved. Invoker view: RLS applies.
create view authority_opportunity_state with (security_invoker = true) as
select o.*,
  case
    when exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id and authority_link_state(l) = 'done') then 'completed'
    when exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id and authority_link_state(l) = 'active') then 'in_progress'
    -- a normal dismissal whose date has passed reads as open while still reported
    -- (the next completed run records the reopening)
    when o.status = 'dismissed' and not o.suppressed and o.dismissed_until <= (now() at time zone 'America/Chicago')::date
         and o.present then 'open'
    when o.status = 'dismissed' then 'dismissed'
    when not o.present then 'resolved'
    else o.status
  end as effective_status
from authority_opportunities o;
revoke all on authority_opportunity_state from public, anon, authenticated;
grant select on authority_opportunity_state to authenticated, service_role;

-- The current run per client (the latest completed one) and what has changed
-- since it was built. Invoker view.
create view authority_latest with (security_invoker = true) as
select r.client_id, r.id as run_id, r.created_at, r.finished_at, r.judged_at, r.mode, r.engine_version,
       r.counts, r.sources, r.diff, r.inventory_fetched_at,
       coalesce((select array_agg(k order by k) from jsonb_each_text(authority_fingerprint(r.client_id)) f(k, v)
                 where r.section_hashes ->> f.k is distinct from f.v), '{}') as stale_sections,
       (r.inventory_fetched_at is null or r.inventory_fetched_at < now() - interval '14 days') as inventory_stale
from (select distinct on (client_id) * from authority_runs where status = 'completed' order by client_id, finished_at desc, id) r;
revoke all on authority_latest from public, anon, authenticated;
grant select on authority_latest to authenticated, service_role;

-- ── 8. Writers ──────────────────────────────────────────────────────────────
-- Opens a run: one running run per client (a run stuck over 15 minutes is
-- failed first). The authority-run function only.
create function authority_begin_run(p_client_id uuid, p_mode text, p_requested_via text, p_requested_by uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not authority_caller_is_service() then
    raise exception 'authority_begin_run is called only by the authority-run function' using errcode = '42501';
  end if;
  perform set_config('compass.authority_write', 'on', true);
  update authority_runs set status = 'failed', finished_at = now(), error = 'Timed out (no result within 15 minutes).'
   where client_id = p_client_id and status = 'running' and created_at < now() - interval '15 minutes';
  begin
    insert into authority_runs (client_id, mode, requested_via, requested_by)
    values (p_client_id, p_mode, p_requested_via, p_requested_by) returning id into v_id;
  exception when unique_violation then
    perform set_config('compass.authority_write', '', true);
    raise exception 'An Authority run is already running for this client' using errcode = '55P03';
  end;
  perform set_config('compass.authority_write', '', true);
  return v_id;
end $$;
revoke all on function authority_begin_run(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function authority_begin_run(uuid, text, text, uuid) to service_role;

-- Finishes a run. p: {status: completed | degraded | failed, error?,
-- engine_version, judged_at, as_of, input_hash, section_hashes,
-- inventory: {fetched_at, pages}, inventory_errors, report}.
-- completed: upserts opportunities by key, records presence and history.
-- degraded / failed: stores the run only; no opportunity changes.
create function authority_record_run(p_run_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r authority_runs;
  v_status text := p->>'status';
  v_report jsonb := p->'report';
  v_prev uuid;
  v_as_of date;
  o jsonb;
  cur authority_opportunities;
  v_id uuid;
  v_keys text[] := '{}';
  added text[] := '{}'; resolved text[] := '{}'; regressed text[] := '{}'; moved text[] := '{}'; reopened text[] := '{}';
  v_counts jsonb;
begin
  if not authority_caller_is_service() then
    raise exception 'authority_record_run is called only by the authority-run function' using errcode = '42501';
  end if;
  select * into r from authority_runs where id = p_run_id for update;
  if r.id is null then raise exception 'No Authority run %', p_run_id using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'Authority run % is already %', p_run_id, r.status using errcode = '42501'; end if;
  if v_status not in ('completed', 'degraded', 'failed') then
    raise exception 'A run finishes completed, degraded or failed, not %', v_status using errcode = '22023';
  end if;

  perform set_config('compass.authority_write', 'on', true);

  if v_status = 'failed' then
    update authority_runs set status = 'failed', finished_at = now(), error = coalesce(nullif(p->>'error', ''), 'Failed.')
     where id = p_run_id;
    perform set_config('compass.authority_write', '', true);
    return jsonb_build_object('run_id', p_run_id, 'status', 'failed');
  end if;

  if v_report is null or (v_report->'client'->>'id')::uuid is distinct from r.client_id then
    raise exception 'The report is not for this run''s client' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_report->'opportunities') x
             group by x->>'key' having count(*) > 1 or x->>'key' is null) then
    raise exception 'Opportunity keys must be present and unique within a run' using errcode = '22023';
  end if;
  v_as_of := coalesce((p->>'as_of')::date, (v_report->>'as_of')::date);

  select jsonb_build_object(
    'by_section', coalesce((select jsonb_object_agg(s, n) from (select x->>'section' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'),
    'by_action',  coalesce((select jsonb_object_agg(s, n) from (select x->>'action' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'),
    'by_tier',    coalesce((select jsonb_object_agg(s, n) from (select x->>'tier' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'))
  into v_counts;
  select id into v_prev from authority_runs
   where client_id = r.client_id and status = 'completed' and id <> p_run_id order by finished_at desc, id limit 1;

  -- Everything but the status first; the run finishes in one last update
  -- (a finished run is immutable, so nothing may follow it).
  update authority_runs set
    engine_version = p->>'engine_version',
    judged_at = (p->>'judged_at')::timestamptz, as_of = v_as_of, input_hash = p->>'input_hash',
    section_hashes = p->'section_hashes',
    inventory_fetched_at = (p->'inventory'->>'fetched_at')::timestamptz,
    inventory_pages = jsonb_array_length(coalesce(p->'inventory'->'pages', '[]')),
    inventory_errors = (p->>'inventory_errors')::int,
    inventory = p->'inventory', sources = v_report->'sources', report = v_report, counts = v_counts,
    previous_run_id = v_prev
  where id = p_run_id;

  if v_status = 'degraded' then
    -- A degraded observation (site down, most pages erroring) never resolves
    -- or reopens anything.
    update authority_runs set status = 'degraded', finished_at = now(),
      diff = jsonb_build_object('skipped', 'degraded run: opportunities unchanged') where id = p_run_id;
    perform set_config('compass.authority_write', '', true);
    return jsonb_build_object('run_id', p_run_id, 'status', 'degraded');
  end if;

  for o in select x from jsonb_array_elements(v_report->'opportunities') x loop
    v_keys := v_keys || (o->>'key');
    select * into cur from authority_opportunities where client_id = r.client_id and key = o->>'key' for update;
    if cur.id is null then
      insert into authority_opportunities (client_id, key, first_seen_run_id, last_seen_run_id, last_seen_at, present,
        section, action, tier, content_type, topic, service_id, keyword_id, intent, target_path, sort_order, eligible_from, opportunity)
      values (r.client_id, o->>'key', p_run_id, p_run_id, now(), true,
        o->>'section', o->>'action', o->>'tier', o->>'content_type', o->>'topic',
        (o->>'service_id')::uuid, (o->'target'->>'keyword_id')::uuid, o->'target'->>'intent', o->'target'->>'owner_path',
        coalesce((select array_agg(x::int) from jsonb_array_elements_text(o->'order') x), '{}'), (o->>'eligible_from')::date, o)
      returning id into v_id;
      insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
      values (v_id, r.client_id, p_run_id, 'created', 'engine', jsonb_build_object('section', o->>'section', 'action', o->>'action'));
      added := added || (o->>'key');
    else
      if not cur.present then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'regressed', 'engine', jsonb_build_object('status_was', cur.status));
        regressed := regressed || cur.key;
        if cur.status = 'accepted' then cur.status := 'open'; end if;
      end if;
      if cur.section <> o->>'section' or cur.action <> o->>'action' then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'section_changed', 'engine',
          jsonb_build_object('from', jsonb_build_object('section', cur.section, 'action', cur.action),
                             'to', jsonb_build_object('section', o->>'section', 'action', o->>'action')));
        moved := moved || cur.key;
      end if;
      -- A normal dismissal ends on its date, and only then; a suppression
      -- never does.
      if cur.status = 'dismissed' and not cur.suppressed and cur.dismissed_until <= v_as_of then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'reopened', 'engine',
          jsonb_build_object('reason', 'dismissal expired', 'until', cur.dismissed_until));
        reopened := reopened || cur.key;
        cur.status := 'open'; cur.dismissed_until := null; cur.status_reason := null;
      end if;
      update authority_opportunities set
        last_seen_run_id = p_run_id, last_seen_at = now(), present = true,
        section = o->>'section', action = o->>'action', tier = o->>'tier', content_type = o->>'content_type', topic = o->>'topic',
        service_id = (o->>'service_id')::uuid, keyword_id = (o->'target'->>'keyword_id')::uuid, intent = o->'target'->>'intent',
        target_path = o->'target'->>'owner_path',
        sort_order = coalesce((select array_agg(x::int) from jsonb_array_elements_text(o->'order') x), '{}'),
        eligible_from = (o->>'eligible_from')::date, opportunity = o,
        status = cur.status, dismissed_until = cur.dismissed_until, status_reason = cur.status_reason
      where id = cur.id;
    end if;
  end loop;

  -- No longer reported: resolved (presence only; the workflow status is kept).
  for cur in select * from authority_opportunities
              where client_id = r.client_id and present and not (key = any (v_keys)) for update loop
    update authority_opportunities set present = false where id = cur.id;
    insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
    values (cur.id, r.client_id, p_run_id, 'resolved', 'engine', jsonb_build_object('reason', 'no longer reported'));
    resolved := resolved || cur.key;
  end loop;

  update authority_runs set status = 'completed', finished_at = now(),
    diff = jsonb_build_object('added', to_jsonb(added), 'resolved', to_jsonb(resolved),
      'regressed', to_jsonb(regressed), 'section_changed', to_jsonb(moved), 'reopened', to_jsonb(reopened))
  where id = p_run_id;
  perform set_config('compass.authority_write', '', true);
  return jsonb_build_object('run_id', p_run_id, 'status', 'completed', 'added', cardinality(added), 'resolved', cardinality(resolved),
    'regressed', cardinality(regressed), 'section_changed', cardinality(moved), 'reopened', cardinality(reopened));
end $$;
revoke all on function authority_record_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function authority_record_run(uuid, jsonb) to service_role;

-- A person's (or, for accept / link, the Drafter function's) workflow
-- action. It changes Authority workflow state only: a decision about client
-- facts is made by writing the canonical table first (services, locations,
-- keywords, page groups) and recorded here with verb 'decision'.
--   accept   {}                                  open → accepted
--   release  {}                                  accepted → open (person only)
--   dismiss  {reason, until}                     → dismissed until a future date (person only; not while work is linked)
--   suppress {reason}                            → dismissed + suppressed: never recommend again (person only)
--   reopen   {}                                  dismissed → open, clears suppression (person only)
--   link     {kind, id}                          links an asset of the same client; open → accepted
--   decision {decision, canonical?}              history only (person only)
create function authority_decide(p_opportunity_id uuid, p_verb text, p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o authority_opportunities;
  v_person boolean := post_caller_is_human();
  v_actor uuid := case when post_caller_is_human() then task_actor() end;
  v_kind text := case when post_caller_is_human() then 'team' else 'drafter' end;
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_until date;
  v_link_kind text := p_payload->>'kind';
  v_ref uuid;
begin
  if not v_person and not (authority_caller_is_service() and p_verb in ('accept', 'link')) then
    raise exception 'Only a signed-in teammate decides Authority opportunities' using errcode = '42501';
  end if;
  select * into o from authority_opportunities where id = p_opportunity_id for update;
  if o.id is null then raise exception 'No such opportunity' using errcode = 'P0002'; end if;

  perform set_config('compass.authority_write', 'on', true);
  case p_verb
  when 'accept' then
    if o.status <> 'open' then raise exception 'Only an open opportunity can be accepted (it is %)', o.status using errcode = '22023'; end if;
    update authority_opportunities set status = 'accepted', decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
    values (o.id, o.client_id, 'accepted', v_kind, v_actor);
  when 'release' then
    if not v_person then raise exception 'Only a person releases an opportunity' using errcode = '42501'; end if;
    if o.status <> 'accepted' then raise exception 'Only an accepted opportunity can be released' using errcode = '22023'; end if;
    update authority_opportunities set status = 'open', decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
    values (o.id, o.client_id, 'released', v_kind, v_actor);
  when 'dismiss', 'suppress' then
    if not v_person then raise exception 'Only a person dismisses an opportunity' using errcode = '42501'; end if;
    if v_reason is null then raise exception 'A dismissal needs a reason' using errcode = '22023'; end if;
    if exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id and authority_link_state(l) = 'active') then
      raise exception 'Work is linked to this opportunity and still open; finish or close it first' using errcode = '22023';
    end if;
    if p_verb = 'dismiss' then
      v_until := nullif(p_payload->>'until', '')::date;
      if v_until is null then
        raise exception 'A dismissal needs a date (dismissed_until); "never recommend again" is suppress' using errcode = '22023';
      end if;
      if v_until <= (now() at time zone 'America/Chicago')::date then
        raise exception 'dismissed_until must be in the future' using errcode = '22023';
      end if;
    end if;
    update authority_opportunities set status = 'dismissed', status_reason = v_reason,
      dismissed_until = case when p_verb = 'dismiss' then v_until end, suppressed = (p_verb = 'suppress'),
      decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, case when p_verb = 'suppress' then 'suppressed' else 'dismissed' end, v_kind, v_actor,
            jsonb_build_object('reason', v_reason, 'until', v_until));
  when 'reopen' then
    if not v_person then raise exception 'Only a person reopens an opportunity' using errcode = '42501'; end if;
    if o.status <> 'dismissed' then raise exception 'Only a dismissed opportunity can be reopened' using errcode = '22023'; end if;
    update authority_opportunities set status = 'open', suppressed = false, dismissed_until = null, status_reason = null,
      decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'reopened', v_kind, v_actor, jsonb_build_object('reason', 'reopened by a person'));
  when 'link' then
    if o.status = 'dismissed' then raise exception 'A dismissed opportunity takes no new work' using errcode = '22023'; end if;
    v_ref := (p_payload->>'id')::uuid;
    if v_link_kind not in ('social_post', 'drafter_run', 'content_post', 'change_log', 'task') or v_ref is null then
      raise exception 'link needs {kind, id}' using errcode = '22023';
    end if;
    -- The composite FKs refuse an asset of another client.
    insert into authority_opportunity_links (opportunity_id, client_id, created_by, kind, ref_id,
      social_post_id, drafter_run_id, content_post_id, change_log_id, task_id)
    values (o.id, o.client_id, v_actor, v_link_kind, v_ref,
      case when v_link_kind = 'social_post' then v_ref end, case when v_link_kind = 'drafter_run' then v_ref end,
      case when v_link_kind = 'content_post' then v_ref end, case when v_link_kind = 'change_log' then v_ref end,
      case when v_link_kind = 'task' then v_ref end);
    if o.status = 'open' then
      update authority_opportunities set status = 'accepted', decided_by = v_actor, decided_at = now() where id = o.id;
      insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
      values (o.id, o.client_id, 'accepted', v_kind, v_actor);
    end if;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'linked', v_kind, v_actor, jsonb_build_object('kind', v_link_kind, 'id', v_ref));
  when 'decision' then
    if not v_person then raise exception 'Only a person records a decision' using errcode = '42501'; end if;
    if nullif(btrim(coalesce(p_payload->>'decision', '')), '') is null then
      raise exception 'A decision needs its text' using errcode = '22023';
    end if;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'decision', v_kind, v_actor, p_payload);
  else
    raise exception 'Unknown verb %', p_verb using errcode = '22023';
  end case;
  perform set_config('compass.authority_write', '', true);
  return (select to_jsonb(s) - 'opportunity' from authority_opportunity_state s where s.id = o.id);
end $$;
revoke all on function authority_decide(uuid, text, jsonb) from public, anon;
grant execute on function authority_decide(uuid, text, jsonb) to authenticated, service_role;

-- ── 9. Verify ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['authority_runs', 'authority_opportunities', 'authority_opportunity_events', 'authority_opportunity_links'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '% has no RLS', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then raise exception 'anon can read %', t; end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then raise exception 'authenticated can write %', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
      raise exception '% has a write policy', t;
    end if;
  end loop;
  if exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%' and definition ilike '%authority%') then
    raise exception 'A portal view reads Authority';
  end if;
  if has_function_privilege('authenticated', 'public.authority_record_run(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.authority_begin_run(uuid, text, text, uuid)', 'execute') then
    raise exception 'authenticated can call the run writers';
  end if;
end $$;
