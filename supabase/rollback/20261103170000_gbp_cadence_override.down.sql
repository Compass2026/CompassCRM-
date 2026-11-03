-- Rollback of 20261103170000_gbp_cadence_override.sql. Run as one
-- transaction, and before any rollback of 20261030180000 (the weekly
-- standard). Restores plan_delivery_week, delivery_week_report and
-- delivery_targets exactly as 20261030180000 left them (md5 of
-- pg_get_functiondef, as replayed and in production on Nov 3 2026:
-- 849de48f5843cfd2a64ccab09093fd4b, d1be320ef0de398b314b39c68fcaf724,
-- 82b6e7c31c83e498aa8a5861bd5a6a46) and removes the override's functions,
-- column and table.
--
-- With no override recorded it removes everything. Once one is recorded the
-- script stops unless compass.delivery_override_rollback is set to
-- 'confirmed' in the same transaction; then:
--   * the override rows are kept, renamed client_delivery_overrides_rolled_back;
--   * slots the override opened stay as ordinary weekly slots (they count
--     toward the standard's 5 a site, so the next planner run opens the rest,
--     over capacity again where one location cannot hold them);
--   * slots the override retired stay retired (blocked, with their reason and
--     previous hold kept): restoring them next to the override's slots would
--     double the week. Clearing the hold by hand un-retires one.
-- Nothing is deleted.
do $guard$
begin
  if exists (select 1 from client_delivery_overrides)
     and coalesce(current_setting('compass.delivery_override_rollback', true), '') <> 'confirmed' then
    raise exception 'rollback 20261103170000: delivery overrides are recorded; set compass.delivery_override_rollback = ''confirmed'' to return those clients to the standard (see the header)';
  end if;
end $guard$;

-- The three functions: each edit is {original, override}, exactly as the
-- migration made it; undone last-first.
do $restore$
declare
  targets text[] := array['public.plan_delivery_week(uuid,date)', 'public.delivery_week_report(uuid,date,date,date)',
                          'public.delivery_targets(uuid,date)'];
  pdw text[][] := array[
    array[$a$  existing int; later int; dayroom int; nxt int; made int := 0; got int; d date;
$a$, $b$  existing int; later int; dayroom int; nxt int; made int := 0; got int; d date;
  -- delivery_override_v1 (20261103170000): the client's Business Profile cadence override, if any.
  ovr client_delivery_overrides; ex int[] := '{}'; left_room int; dayocc int[]; pos record;
$b$],
    array[$a$   where i.client_id = p_client_id and delivery_v1_slot_retirable(i.id, first_week);
$a$, $b$   where i.client_id = p_client_id and delivery_v1_slot_retirable(i.id, first_week);

  -- delivery_override_v1 (20261103170000): under a cadence override, the week's Business Profile
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
    -- delivery_override_v1 (20261103170000): a site's room is its share of the override's round
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
$a$, $b$    -- delivery_override_v1 (20261103170000): the override's positions in order, one a day. A
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
          $b$                                        -- delivery_override_v1 (20261103170000): the site's share under a cadence override.
                                        else coalesce(delivery_override_week_target(g.client_id, 'gbp_posts', g.bid, g.w), (g.std).gbp_posts) end end as target,$b$]];
  dtg text[][] := array[
    array[$a$                else delivery_weekly_month_target(m.client_id, m.deliverable, m.month) end as target,$a$,
          $b$                -- delivery_override_v1 (20261103170000): 0 without a cadence override.
                else delivery_weekly_month_target(m.client_id, m.deliverable, m.month)
                     + delivery_override_month_delta(m.client_id, m.deliverable, m.month, m.brand_workspace_id) end as target,$b$]];
  edits text[][];
  def text;
  t int; i int;
begin
  for t in 1..array_length(targets, 1) loop
    def := pg_get_functiondef(targets[t]::regprocedure);
    edits := case t when 1 then pdw when 2 then dwr else dtg end;
    for i in reverse array_length(edits, 1)..1 loop
      if strpos(def, edits[i][2]) = 0 then
        raise exception '% does not carry override edit % as written; restore it by hand', targets[t], i;
      end if;
      def := replace(def, edits[i][2], edits[i][1]);
    end loop;
    execute def;
  end loop;
end $restore$;

drop function delivery_override_month_delta(uuid, text, date, uuid);
drop function delivery_override_week_target(uuid, text, uuid, date);
drop function delivery_override_allocation(uuid, text, date);
drop function client_delivery_override(uuid, text, date);

alter table content_plan_items
  drop constraint content_plan_items_delivery_override_shape,
  drop column delivery_override_id;

do $overrides$
begin
  if exists (select 1 from client_delivery_overrides) then
    drop trigger client_delivery_overrides_guard on client_delivery_overrides;
    alter table client_delivery_overrides rename to client_delivery_overrides_rolled_back;
    revoke insert on client_delivery_overrides_rolled_back from authenticated, service_role;
  else
    drop table client_delivery_overrides;
  end if;
end $overrides$;
drop function client_delivery_overrides_guard();

do $verify$
begin
  if md5(pg_get_functiondef('public.plan_delivery_week(uuid,date)'::regprocedure)) <> '849de48f5843cfd2a64ccab09093fd4b'
     or md5(pg_get_functiondef('public.delivery_week_report(uuid,date,date,date)'::regprocedure)) <> 'd1be320ef0de398b314b39c68fcaf724'
     or md5(pg_get_functiondef('public.delivery_targets(uuid,date)'::regprocedure)) <> '82b6e7c31c83e498aa8a5861bd5a6a46' then
    raise exception 'rollback 20261103170000: a function was not restored exactly';
  end if;
end $verify$;
