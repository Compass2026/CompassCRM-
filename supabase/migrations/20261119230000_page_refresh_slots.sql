-- Webpage refresh production: the delivery standard's monthly refresh slot
-- gets worked, not just planned.
--
-- Executive OS 3ab519f3 (Nov 19 2026, Tom: "Activate webpage-refresh
-- production. Make the existing workflow select an eligible existing page,
-- prepare a reviewable improvement and apply approved changes through the
-- site's supported deployment route. Track this separately from blog
-- production. Do not turn a refresh into an unrequested website rebuild.")
--
-- The delivery standard opens one `web_page` slot (`standard_key =
-- 'page_refreshes'`) per website per month for every client. Nothing worked
-- them: the only refresh path was the monthly Reporting cycle's
-- `site_updates` task (PB7), and cycles exist only for active clients
-- enrolled in Reporting. Lucas, Ginger, MADHAIRLAB, Pensacola and Silverback
-- have refresh slots and no cycle, so November's slots sat empty.
--
-- queue_page_refresh_slots(month) opens one CLAUDE `page_refresh` task per
-- eligible slot (the playbook is "Webpage refresh slot" in the worker skill:
-- one existing page, one core keyword, prepared as a pull request or a
-- proposed document for review — never a push, never a new page) and fires
-- the worker once per client. Gates, each logged to delivery_queue_log:
--   * the slot is open (no hold, not retired, nothing linked);
--   * the client is active or launching;
--   * the site is known: the brand site's blog_site_id, else the client's
--     only sites row (several and no brand site → skipped, never guessed);
--   * the site's core keyword list is approved;
--   * no open site_updates task this month (that run covers the refresh;
--     it is re-fired instead of duplicated);
--   * no page_refresh task already names the slot.
-- Idempotent: a rerun opens nothing new. Cron: the 2nd 09:30 UTC (after
-- fire-website-updates) and Mondays 10:15 UTC (after delivery-standard-week)
-- so a slot whose gate clears mid-month is picked up within a week.
-- Rollback: supabase/rollback/20261119230000_page_refresh_slots.down.sql.

-- The queue log records refresh decisions too.
alter table delivery_queue_log drop constraint delivery_queue_log_deliverable_check;
alter table delivery_queue_log add constraint delivery_queue_log_deliverable_check
  check (deliverable = any (array['blog_posts', 'facebook_posts', 'gbp_posts', 'page_refreshes']));

create or replace function queue_page_refresh_slots(p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_month date := date_trunc('month', coalesce(p_month, delivery_today()))::date;
  s record; v_site uuid; v_sites int; opened int := 0; fired uuid[] := '{}'; v_task uuid; v_su uuid;
begin
  for s in
    select p.id, p.client_id, p.brand_workspace_id, p.planned_date, c.name as client_name, c.status::text as client_status,
           w.blog_site_id, w.name as workspace_name
      from content_plan_items p
      join clients c on c.id = p.client_id
      left join client_brand_workspaces w on w.id = p.brand_workspace_id
     where p.deliverable = 'web_page' and p.standard_key = 'page_refreshes' and p.standard_month = v_month
       and p.retired_at is null
     order by c.name, p.planned_date, p.id
  loop
    perform pg_advisory_xact_lock(hashtextextended('page_refresh:' || s.id::text, 0));
    if exists (select 1 from content_plan_items x where x.id = s.id
                 and (x.hold is not null or x.content_post_id is not null or x.social_post_id is not null or x.output_url is not null)) then
      continue;  -- held or already delivered: nothing to queue, nothing to log
    end if;
    if s.client_status not in ('active', 'launching') then
      continue;
    end if;
    if exists (select 1 from tasks t where t.key = 'page_refresh' and t.client_id = s.client_id
                 and t.notes like '%plan_item:' || s.id::text || '%') then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason)
      values (s.client_id, s.id, 'page_refreshes', 'skipped', 'Already queued.');
      continue;
    end if;
    -- The site: the brand site's, else the client's only one.
    v_site := s.blog_site_id;
    if v_site is null and s.brand_workspace_id is null then
      select count(*), (array_agg(st.id))[1] into v_sites, v_site from sites st where st.client_id = s.client_id;
      if v_sites <> 1 then v_site := null; end if;
    end if;
    if v_site is null then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason)
      values (s.client_id, s.id, 'page_refreshes', 'skipped',
              case when coalesce(v_sites, 0) = 0 and s.brand_workspace_id is null then 'No sites row; left for Tom.'
                   else 'Website not identified for this slot (several sites, or a brand site without a blog site); left for Tom.' end);
      continue;
    end if;
    if not exists (select 1 from core_keyword_lists l where l.client_id = s.client_id and l.status = 'approved'
                     and l.brand_workspace_id is not distinct from s.brand_workspace_id) then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason)
      values (s.client_id, s.id, 'page_refreshes', 'skipped',
              left('No approved core keyword list' || coalesce(' for ' || s.workspace_name, '') || '.', 300));
      continue;
    end if;
    -- The monthly Reporting run covers this client's refresh: re-fire it, do not duplicate it.
    select t.id into v_su from tasks t join monthly_cycles mc on mc.id = t.monthly_cycle_id
     where t.key = 'site_updates' and t.client_id = s.client_id and t.status in ('open', 'in_progress', 'blocked')
       and date_trunc('month', mc.period)::date = v_month
     limit 1;
    if v_su is not null then
      update tasks set status = 'open',
             notes = coalesce(notes, '') || E'\nqueue_page_refresh_slots ' || to_char(delivery_today(), 'YYYY-MM-DD')
                     || ': refresh slot plan_item:' || s.id || ' is this run''s refresh; reopened (gates now pass: site, approved core list).'
       where id = v_su and status = 'blocked';
      -- Re-fire only a run that was just reopened or has sat untouched for
      -- six days; a run working (or already answered this week) is left alone.
      if found or exists (select 1 from tasks t where t.id = v_su and t.updated_at < now() - interval '6 days') then
        insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason, task_id)
        values (s.client_id, s.id, 'page_refreshes', 'queued', 'Covered by this month''s site_updates task; re-fired.', v_su);
        if not s.client_id = any (fired) then fired := fired || s.client_id; end if;
      end if;
      continue;
    end if;
    insert into tasks (client_id, key, owner, title, status, playbook_step, autonomy_level, due_date, notes)
    values (s.client_id, 'page_refresh', 'CLAUDE',
            left('Webpage refresh for ' || coalesce(s.workspace_name, s.client_name)
                 || ': improve one existing page on a core keyword, prepared for review', 200),
            'open', 'PB7', 'run_flag', s.planned_date,
            'plan_item:' || s.id || ' site:' || v_site || ' month:' || to_char(v_month, 'YYYY-MM')
            || ' (page refresh, delivery standard). Refresh ONE existing page of this site on a keyword of the approved core list'
            || ' (worker skill: "Webpage refresh slot"). Prepare it as a pull request or a proposed document for review;'
            || ' never push, never add a page, never rebuild the site.')
    returning id into v_task;
    insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason, task_id)
    values (s.client_id, s.id, 'page_refreshes', 'queued', 'Ready (approved core list, site known).', v_task);
    opened := opened + 1;
    if not s.client_id = any (fired) then fired := fired || s.client_id; end if;
  end loop;
  for v_task in select unnest(fired) loop
    perform fire_foundation_worker(v_task,
      'Webpage refresh: prepare this month''s refresh slot for review (one existing page, core keyword; never a push)');
  end loop;
  return opened;
end;
$function$;

revoke all on function queue_page_refresh_slots(date) from public, anon, authenticated;
grant execute on function queue_page_refresh_slots(date) to service_role;

select cron.schedule('page-refresh-month', '30 9 2 * *', 'select public.queue_page_refresh_slots()');
select cron.schedule('page-refresh-weekly', '15 10 * * 1', 'select public.queue_page_refresh_slots()');
