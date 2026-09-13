-- The monthly Reporting cycle becomes worker-run (Playbooks 5 and 6).
--
-- create_monthly_cycles() (0001, cron on the 1st at 06:00 UTC) opens a cycle
-- and its tasks for every active client enrolled in Reporting. BrightLocal
-- and GSC sync at 07:00 / 07:30. This migration adds the third beat: at
-- 09:00 UTC on the 1st, fire_monthly_reporting() fires the worker once per
-- open cycle, and the worker runs PB6 (one Industry Pulse per vertical per
-- period) then PB5 (the client's refresh + report). A cycle started by hand
-- mid-month fires the same way from an insert trigger.
--
-- Also: template keys so the worker closes checklist items by key, the key
-- copied onto cycle tasks, a unique pulse per (vertical, period) so two
-- sessions cannot both write one, a summary column for the report's numbers,
-- and a TOM task per cycle — "Send the monthly report" — because sending a
-- client-facing report is the one human step in the month.

-- ── Keys on the Reporting templates ──────────────────────────────────────
update task_templates tt set key = v.key
from pipelines p, (values
  ('Industry Pulse — one per vertical, before client refreshes', 'pulse'),
  ('Monthly Refresh & Report — per client', 'monthly_report'),
  ('GBP posts (count per plan)', 'gbp_posts'),
  ('New backlinks', 'backlinks_new'),
  ('Blog content published (from Content tab)', 'content_published'),
  ('Social posts published (from Social tab)', 'social_published'),
  ('Paid ads optimization + spend review', 'paid_ads_review'),
  ('Rank snapshot recorded', 'rank_snapshot')
) as v(title, key)
where tt.pipeline_id = p.id and p.key = 'reporting' and tt.title = v.title and tt.key is null;

insert into task_templates (pipeline_id, department, title, default_owner, sort_order, playbook_step, autonomy_level, key)
select p.id, null, 'Send the monthly report to the client', 'TOM', 9, 'PB5', 'hold', 'report_send'
from pipelines p
where p.key = 'reporting'
  and not exists (select 1 from task_templates t where t.pipeline_id = p.id and t.key = 'report_send');

-- ── Cycle tasks carry the key ────────────────────────────────────────────
create or replace function create_monthly_cycles(p_period date default date_trunc('month', now())::date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  v_client record;
  v_cycle_id uuid;
begin
  -- Tell the insert trigger this is the batch: cron fires the worker for the
  -- batch at 09:00, after the syncs, not at insert time.
  perform set_config('compass.cycle_batch', '1', true);
  for v_client in
    select c.id
    from clients c
    where c.status = 'active'
      and exists (
        select 1 from client_pipelines cp
        join pipelines p on p.id = cp.pipeline_id
        where cp.client_id = c.id and p.is_recurring and cp.status = 'active'
      )
      and not exists (
        select 1 from monthly_cycles mc
        where mc.client_id = c.id and mc.period = p_period
      )
  loop
    insert into monthly_cycles (client_id, period)
    values (v_client.id, p_period)
    returning id into v_cycle_id;

    insert into tasks (client_id, monthly_cycle_id, title, owner, status, playbook_step, autonomy_level, key)
    select v_client.id, v_cycle_id, tt.title, tt.default_owner, 'open', tt.playbook_step, tt.autonomy_level, tt.key
    from task_templates tt
    join pipelines p on p.id = tt.pipeline_id and p.is_recurring
    where tt.department is null
       or exists (
         select 1 from client_pipelines cp
         join pipelines dp on dp.id = cp.pipeline_id
         where cp.client_id = v_client.id and dp.key::text = tt.department::text
       )
    order by tt.sort_order;

    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ── One pulse per vertical per period ────────────────────────────────────
create unique index if not exists industry_pulse_vertical_period_key
  on industry_pulse (vertical, period);

-- ── The report's numbers, on the cycle ───────────────────────────────────
alter table monthly_cycles add column if not exists summary jsonb;
comment on column monthly_cycles.summary is
  'PB5 report figures written by the worker: rank movement, GSC clicks / impressions vs prior period, City Index, backlinks, GBP, activity counts, wins, next month. report_url is the Drive doc.';

-- ── Fire the worker for open cycles ──────────────────────────────────────
create or replace function fire_monthly_reporting(p_period date default date_trunc('month', now())::date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_cycle record;
  v_count int := 0;
begin
  for v_cycle in
    select mc.client_id
    from monthly_cycles mc
    join clients c on c.id = mc.client_id
    where mc.period = p_period and mc.status = 'open'
      and c.status = 'active'
      and exists (select 1 from tasks t where t.monthly_cycle_id = mc.id and t.key = 'monthly_report' and t.status <> 'done')
  loop
    perform fire_foundation_worker(v_cycle.client_id, 'Monthly cycle ' || to_char(p_period, 'YYYY-MM'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on function fire_monthly_reporting(date) from public, anon, authenticated;

-- After the syncs: 06:00 cycles, 07:00 BrightLocal, 07:30 GSC, 09:00 worker.
select cron.unschedule('fire-monthly-reporting')
where exists (select 1 from cron.job where jobname = 'fire-monthly-reporting');
select cron.schedule('fire-monthly-reporting', '0 9 1 * *', $$select public.fire_monthly_reporting()$$);

-- A cycle started by hand mid-month (Reports tab button) fires at once.
create or replace function fire_worker_on_cycle_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The 1st-of-month batch is fired by cron after the syncs, not here.
  if current_setting('compass.cycle_batch', true) = '1' then
    return new;
  end if;
  perform fire_foundation_worker(new.client_id, 'Monthly cycle ' || to_char(new.period, 'YYYY-MM'));
  return new;
end $$;

revoke execute on function fire_worker_on_cycle_insert() from public, anon, authenticated;

drop trigger if exists monthly_cycles_zz_fire_worker on monthly_cycles;
create trigger monthly_cycles_zz_fire_worker after insert on monthly_cycles
  for each row execute function fire_worker_on_cycle_insert();
