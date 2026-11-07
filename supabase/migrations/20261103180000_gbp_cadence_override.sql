-- Business Profile cadence override (Tom, Nov 3 2026; Executive OS task
-- 3ab519f3, decision message 367b12c0). Needs 20261030180000_weekly_delivery_standard.
-- Sandbox suite: supabase/tests/sandbox/gbp_cadence_override.test.sql.
-- Rollback: supabase/rollback/20261103180000_gbp_cadence_override.down.sql.
-- Design: docs/delivery-standard.md ("Cadence overrides").
--
-- Under the weekly standard each brand site wants 5 Business Profile posts a
-- week. A client whose sites share one location fits only 7 a week (one post
-- per location per day), so a three-site client opened 15 and saw 8 flagged
-- "Over capacity" every week, counted against its target. Tom's decision for
-- that client: 7 GBP posts a week in total, at most one a day, alternating
-- between the businesses.
--
--   Record   client_delivery_overrides: one row per client, deliverable and
--            effective week (a Monday, today or later), recorded as data —
--            this migration records none. Append-only; a later row replaces
--            an earlier one from its week ('standard' ends the override).
--   Scope    gbp_posts only, and only in weeks the weekly standard governs for
--            the client (the planner and the month targets read it only
--            there). Facebook, blogs and the monthly page refresh are untouched.
--   Rotation round_robin: the override's weekly_total posts a week (1–7), on
--            the first weekly_total standard days (7 → every day) in date
--            order, one per day. Position i of week w goes to site
--            ((weeks since effective_week) × weekly_total + i) mod sites, sites
--            ordered by slug: a continuous round robin that runs on across
--            week boundaries, so 7 over three sites is 3 / 2 / 2 with the extra
--            post moving to the next site each week. The rotation is computed
--            from the calendar, never from what happens to be planned, so it
--            is the same on every rerun.
--   Planner  plan_delivery_week opens a position's slot on its day unless the
--            day is past or already carries a Business Profile item (a post,
--            a kept slot); a site never gets more than its share less its work
--            in the week, and the week never more than weekly_total. Reruns
--            open nothing. Slots opened by the standard in an override week
--            with nothing attached are retired the first time the override
--            plans the week (blocked with a Retired reason, kept as history,
--            never deleted); slots with work attached stay and count.
--   Reports  delivery_week_report's GBP target is the site's share of the
--            week (7 in total, not 15), so the removed 8 are neither remaining
--            nor over capacity. delivery_targets adds, per site and month, the
--            difference between the override's days and the standard's days
--            (delivery_override_month_delta), which is 0 for every client and
--            month without an override: their rows are unchanged.
--
-- Function edits are guarded: each target must carry the md5 of its
-- 20261030180000 definition (as replayed and as in production on Nov 3 2026)
-- and each anchor must appear exactly once.

-- ── 1. The override record ──────────────────────────────────────────────────
create table client_delivery_overrides (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  deliverable text not null check (deliverable = 'gbp_posts'),
  allocation text not null check (allocation in ('round_robin', 'standard')),
  weekly_total integer check (weekly_total between 1 and 7),
  effective_week date not null check (extract(isodow from effective_week) = 1),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 2000),
  recorded_by uuid references team_members(id),
  recorded_at timestamptz not null default now(),
  unique (client_id, deliverable, effective_week),
  constraint client_delivery_overrides_shape check ((allocation = 'round_robin') = (weekly_total is not null))
);
comment on table client_delivery_overrides is
  'Per-client cadence overrides of the weekly delivery standard. round_robin: weekly_total Business Profile posts a week across the client''s sites, at most one a day, in a continuous round robin by site slug; standard: back to the standard. From effective_week (a Monday, never in the past), only in weeks the weekly standard governs. Append-only.';
create index client_delivery_overrides_client_idx on client_delivery_overrides(client_id, deliverable, effective_week);
alter table client_delivery_overrides enable row level security;
create policy "team client delivery overrides" on client_delivery_overrides to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on client_delivery_overrides from public, anon, authenticated;
grant select, insert on client_delivery_overrides to authenticated, service_role;

create function client_delivery_overrides_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Delivery overrides are history; record a new effective week.' using errcode = '23514';
  end if;
  if new.effective_week < delivery_today() then
    raise exception 'A delivery override starts this week''s Monday or later (no retroactive weeks); % is in the past.', new.effective_week
      using errcode = '23514';
  end if;
  new.recorded_by := (select id from team_members where auth_user_id = auth.uid());
  new.recorded_at := now();
  return new;
end $$;
revoke all on function client_delivery_overrides_guard() from public, anon, authenticated;
create trigger client_delivery_overrides_guard before insert or update or delete on client_delivery_overrides
  for each row execute function client_delivery_overrides_guard();

-- Slots the override opened carry it.
alter table content_plan_items
  add column delivery_override_id uuid references client_delivery_overrides(id),
  add constraint content_plan_items_delivery_override_shape
    check (delivery_override_id is null or (standard_key = 'gbp_posts' and standard_week is not null));
comment on column content_plan_items.delivery_override_id is
  'Set on Business Profile slots the weekly planner opened under a cadence override (client_delivery_overrides).';

-- ── 2. Readers ──────────────────────────────────────────────────────────────
-- The round-robin override in effect for the week containing p_date, or a
-- row of nulls (none, or the latest row is 'standard'). It does not ask
-- whether the weekly standard governs the week: every caller already does.
create function client_delivery_override(p_client_id uuid, p_deliverable text, p_date date)
returns client_delivery_overrides
language sql stable security invoker set search_path = public, pg_temp as $$
  select o.* from (
    select * from client_delivery_overrides x
    where x.client_id = p_client_id and x.deliverable = p_deliverable and x.effective_week <= delivery_week_start(p_date)
    order by x.effective_week desc limit 1) o
  where o.allocation = 'round_robin'
$$;

-- The override's positions in the week containing p_week: seq 0..total-1,
-- the site it goes to and its day. Days: the first weekly_total standard
-- days (Mon, Wed, Fri, Tue, Thu, Sat, Sun) in date order. Site: position
-- (weeks since effective_week) × weekly_total + seq of the continuous round
-- robin over the client's sites by slug (the client itself when it has none).
create function delivery_override_allocation(p_client_id uuid, p_deliverable text, p_week date)
returns table (seq integer, brand_workspace_id uuid, day date)
language sql stable security invoker set search_path = public, pg_temp as $$
  with o as (select x.* from client_delivery_override(p_client_id, p_deliverable, p_week) x where x.id is not null),
  s as (select coalesce((select array_agg(w.id order by w.slug, w.id) from client_brand_workspaces w where w.client_id = p_client_id),
                        array[null::uuid]) as ids),
  d as (select array_agg(x order by x) as offs from o, unnest((array[0, 2, 4, 1, 3, 5, 6])[1:o.weekly_total]) x)
  select i, s.ids[(((delivery_week_start(p_week) - o.effective_week) / 7 * o.weekly_total + i) % cardinality(s.ids)) + 1],
         delivery_week_start(p_week) + d.offs[i + 1]
  from o, s, d, generate_series(0, o.weekly_total - 1) i
$$;

-- A site's (or the client's) share of the override in that week, or null
-- when no override is in effect.
create function delivery_override_week_target(p_client_id uuid, p_deliverable text, p_brand_workspace_id uuid, p_week date)
returns integer
language sql stable security invoker set search_path = public, pg_temp as $$
  select case when (client_delivery_override(p_client_id, p_deliverable, p_week)).id is null then null
              else (select count(*)::int from delivery_override_allocation(p_client_id, p_deliverable, p_week) a
                    where a.brand_workspace_id is not distinct from p_brand_workspace_id) end
$$;

-- What the override changes in a site's month target: for each day of the
-- month in a week the weekly standard governs and an override is in effect,
-- the site's override posts that day less the standard's share of that day
-- (delivery_weekly_month_target's own rule). 0 without an override.
create function delivery_override_month_delta(p_client_id uuid, p_deliverable text, p_month date, p_brand_workspace_id uuid)
returns integer
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  m date := date_trunc('month', p_month)::date;
  m_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  first_week date := client_weekly_first_week(p_client_id);
  wk date; std delivery_standards; t int := 0;
begin
  if p_deliverable is distinct from 'gbp_posts' or first_week is null or first_week >= m_end
     or not exists (select 1 from client_delivery_overrides o where o.client_id = p_client_id
                     and o.deliverable = p_deliverable and o.effective_week < m_end) then
    return 0;
  end if;
  for wk in select x::date from generate_series(delivery_week_start(greatest(m, first_week)), m_end - 1, interval '7 days') x loop
    continue when (client_delivery_override(p_client_id, p_deliverable, wk)).id is null;
    std := client_weekly_delivery_standard(p_client_id, wk);
    continue when std.id is null;
    t := t + (select count(*)::int from delivery_override_allocation(p_client_id, p_deliverable, wk) a
              where a.brand_workspace_id is not distinct from p_brand_workspace_id
                and a.day >= greatest(m, first_week) and a.day < m_end)
           - (select coalesce(sum(delivery_daily_target(std.gbp_posts, x::date)), 0)::int
              from generate_series(greatest(wk, m, first_week), least(wk + 6, m_end - 1), interval '1 day') x);
  end loop;
  return t;
end $$;

revoke all on function client_delivery_override(uuid, text, date), delivery_override_allocation(uuid, text, date),
  delivery_override_week_target(uuid, text, uuid, date), delivery_override_month_delta(uuid, text, date, uuid) from public, anon;
grant execute on function client_delivery_override(uuid, text, date), delivery_override_allocation(uuid, text, date),
  delivery_override_week_target(uuid, text, uuid, date), delivery_override_month_delta(uuid, text, date, uuid)
  to authenticated, service_role;

-- ── 3. The planner, the week report and the month targets ───────────────────
-- Guarded text edits on the 20261030180000 definitions: {anchor, replacement},
-- each anchor exactly once, the marker delivery_override_v1 makes a rerun a
-- no-op. The rollback reverses them and checks the md5s again.
do $migration$
declare
  targets text[][] := array[
    array['public.plan_delivery_week(uuid,date)', '849de48f5843cfd2a64ccab09093fd4b'],
    array['public.delivery_week_report(uuid,date,date,date)', 'd1be320ef0de398b314b39c68fcaf724'],
    array['public.delivery_targets(uuid,date)', '82b6e7c31c83e498aa8a5861bd5a6a46']];
  pdw text[][] := array[
    array[$a$  existing int; later int; dayroom int; nxt int; made int := 0; got int; d date;
$a$, $b$  existing int; later int; dayroom int; nxt int; made int := 0; got int; d date;
  -- delivery_override_v1 (20261103180000): the client's Business Profile cadence override, if any.
  ovr client_delivery_overrides; ex int[] := '{}'; left_room int; dayocc int[]; pos record;
$b$],
    array[$a$   where i.client_id = p_client_id and delivery_v1_slot_retirable(i.id, first_week);
$a$, $b$   where i.client_id = p_client_id and delivery_v1_slot_retirable(i.id, first_week);

  -- delivery_override_v1 (20261103180000): under a cadence override, the week's Business Profile
  -- slots the standard opened with nothing attached are retired (kept as history), once.
  ovr := client_delivery_override(p_client_id, 'gbp_posts', w);
  if ovr.id is not null then
    update content_plan_items i
       set retired_at = now(), retired_hold = i.hold, retired_hold_reason = i.hold_reason, hold = 'blocked',
           hold_reason = left('Retired: superseded by the Business Profile cadence override (' || ovr.weekly_total
                              || ' a week across the client''s sites, round robin) from the week of '
                              || to_char(ovr.effective_week, 'Mon FMDD, YYYY') || '. Kept as history; nothing was attached.', 500)
     where i.client_id = p_client_id and i.standard_key = 'gbp_posts' and i.standard_week = w
       and i.standard_week_seq is not null and i.retired_at is null and i.delivery_override_id is distinct from ovr.id
       and i.social_post_id is null and i.content_post_id is null and i.hold is distinct from 'delivered'
       and not exists (select 1 from content_drafts cd where cd.plan_item_id = i.id)
       and not exists (select 1 from tasks t where t.client_id = i.client_id and t.status <> 'done'
                         and t.key = 'social_slot:' || i.id::text);
  end if;
$b$],
    array[$a$      room[u] := greatest(0, least(n - existing, dayroom - later));
    end loop;
$a$, $b$      room[u] := greatest(0, least(n - existing, dayroom - later));
      ex[u] := existing;
    end loop;
    -- delivery_override_v1 (20261103180000): a site's room is its share of the override's round
    -- robin for the week less its work dated in the week; the week's, weekly_total less all of it.
    if dk = 'gbp_posts' and ovr.id is not null then
      for u in 1..nu loop
        room[u] := greatest(0, (select count(*) from delivery_override_allocation(p_client_id, 'gbp_posts', w) a
                                 where a.brand_workspace_id is not distinct from units[u])::int - ex[u]);
      end loop;
      left_room := greatest(0, ovr.weekly_total - (select coalesce(sum(v), 0) from unnest(ex[1:nu]) v)::int);
    end if;
$b$],
    array[$a$    -- Round-robin: round r gives each site (rotated order) its r-th slot.
$a$, $b$    -- delivery_override_v1 (20261103180000): the override's positions in order, one a day. A
    -- position opens its site's slot on its own day unless the day has passed or already carries a
    -- Business Profile item, at a location with room that day (else the least loaded one, which
    -- readiness then flags). The standard's round robin below does not run for it.
    if dk = 'gbp_posts' and ovr.id is not null then
      select array_agg((select count(*) from delivery_items(p_client_id, w + jj - 1, w + jj - 1) x
                        where x.deliverable = 'gbp_posts' and not x.retired)::int order by jj)
        into dayocc from generate_series(1, 7) jj;
      for pos in select a.seq, a.brand_workspace_id, a.day from delivery_override_allocation(p_client_id, 'gbp_posts', w) a
                 order by a.seq loop
        exit when left_room <= 0;
        u := array_position(units, pos.brand_workspace_id);
        j := pos.day - w + 1;
        continue when u is null or room[u] <= 0 or pos.day < first_day or dayocc[j] > 0;
        best_l := null;
        for k2 in 1..nl loop
          continue when cap is not null and occ[(k2 - 1) * 7 + j] >= cap;
          if best_l is null or lload[k2] < lload[best_l] then best_l := k2; end if;
        end loop;
        if best_l is null then
          best_l := 1;
          for k2 in 2..nl loop
            if lload[k2] < lload[best_l] then best_l := k2; end if;
          end loop;
        end if;
        select coalesce(max(standard_week_seq), 0) + 1 into nxt from content_plan_items c
         where c.client_id = p_client_id and c.brand_workspace_id is not distinct from units[u]
           and c.standard_key = dk and c.standard_week = w;
        insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, planned_date, notes,
                                        brand_workspace_id, standard_key, standard_month, standard_week, standard_week_seq,
                                        gbp_location_id, delivery_override_id)
        values (p_client_id, w, v_deliv, v_channel, v_purpose,
                left(label || ' · ' || names[u] || ' · week of ' || to_char(w, 'Mon FMDD, YYYY'), 200), pos.day,
                'Opened by the weekly delivery standard (v' || std.version || ') under the Business Profile cadence override ('
                  || ovr.weekly_total || ' a week across the client''s sites, round robin). Set the topic, intent, service and keyword before drafting.',
                units[u], dk, date_trunc('month', pos.day)::date, w, nxt, locs[best_l], ovr.id)
        on conflict do nothing;
        get diagnostics got = row_count;
        made := made + got;
        room[u] := room[u] - 1; left_room := left_room - 1; dayocc[j] := dayocc[j] + 1;
        occ[(best_l - 1) * 7 + j] := occ[(best_l - 1) * 7 + j] + 1;
        lload[best_l] := lload[best_l] + 1;
      end loop;
      continue;
    end if;

    -- Round-robin: round r gives each site (rotated order) its r-th slot.
$b$]];
  dwr text[][] := array[
    array[$a$                                        else (g.std).gbp_posts end end as target,$a$,
          $b$                                        -- delivery_override_v1 (20261103180000): the site's share under a cadence override.
                                        else coalesce(delivery_override_week_target(g.client_id, 'gbp_posts', g.bid, g.w), (g.std).gbp_posts) end end as target,$b$]];
  dtg text[][] := array[
    array[$a$                else delivery_weekly_month_target(m.client_id, m.deliverable, m.month) end as target,$a$,
          $b$                -- delivery_override_v1 (20261103180000): 0 without a cadence override.
                else delivery_weekly_month_target(m.client_id, m.deliverable, m.month)
                     + delivery_override_month_delta(m.client_id, m.deliverable, m.month, m.brand_workspace_id) end as target,$b$]];
  edits text[][];
  definition text;
  t int; i int;
begin
  for t in 1..array_length(targets, 1) loop
    definition := pg_get_functiondef(targets[t][1]::regprocedure);
    continue when strpos(definition, 'delivery_override_v1') > 0;
    if md5(definition) <> targets[t][2] then
      raise exception 'Unexpected % definition (md5 %); review before applying the cadence override', targets[t][1], md5(definition);
    end if;
    edits := case t when 1 then pdw when 2 then dwr else dtg end;
    for i in 1..array_length(edits, 1) loop
      if (length(definition) - length(replace(definition, edits[i][1], ''))) <> length(edits[i][1]) then
        raise exception 'Unexpected % definition (edit %); review before applying the cadence override', targets[t][1], i;
      end if;
      definition := replace(definition, edits[i][1], edits[i][2]);
    end loop;
    execute definition;
  end loop;
end;
$migration$;

-- ── 4. Postconditions ───────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from client_delivery_overrides) then
    raise exception 'The migration records no override';
  end if;
  if exists (select 1 from content_plan_items where delivery_override_id is not null) then
    raise exception 'The migration opens no slot';
  end if;
  if strpos(pg_get_functiondef('public.plan_delivery_week(uuid,date)'::regprocedure), 'delivery_override_v1') = 0
     or strpos(pg_get_functiondef('public.delivery_week_report(uuid,date,date,date)'::regprocedure), 'delivery_override_v1') = 0
     or strpos(pg_get_functiondef('public.delivery_targets(uuid,date)'::regprocedure), 'delivery_override_v1') = 0 then
    raise exception 'the planner, the week report or the month targets was not updated';
  end if;
  if has_table_privilege('anon', 'public.client_delivery_overrides', 'select')
     or has_table_privilege('authenticated', 'public.client_delivery_overrides', 'update')
     or has_table_privilege('authenticated', 'public.client_delivery_overrides', 'delete')
     or not has_table_privilege('authenticated', 'public.client_delivery_overrides', 'insert')
     or has_function_privilege('anon', 'public.delivery_override_allocation(uuid,text,date)', 'execute')
     or has_function_privilege('anon', 'public.delivery_override_month_delta(uuid,text,date,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.client_delivery_overrides_guard()', 'execute') then
    raise exception 'client_delivery_overrides grants are not as reviewed';
  end if;
end $$;
