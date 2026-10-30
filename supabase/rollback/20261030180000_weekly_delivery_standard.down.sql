-- Rollback of 20261030180000_weekly_delivery_standard.sql. Run as one
-- transaction. Restores social_slot_readiness, plan_delivery_month,
-- delivery_targets and create_weekly_blog_tasks exactly as they stood (md5
-- of pg_get_functiondef in production on Oct 30 2026:
-- 7d82b3b6f7d34c4d11118e642366d0ac, 4a6fc125878f692f756e88e13ea45a53,
-- 4d67bf3ff886339f6675c56a73bbf311, fdddc0423cafc81c222fa4231938b6ad) and
-- unschedules delivery-standard-week.
--
-- Before any weekly adoption it removes everything the migration added,
-- standard 2 included. Once a client has adopted the weekly standard the
-- script stops unless compass.weekly_rollback is set to 'confirmed' in the
-- same transaction; then:
--   * every retired v1 slot gets its previous hold back (the monthly plan
--     resumes; nothing it carried was ever touched);
--   * weekly slots with nothing attached (no post, article, draft or open
--     task) are removed — they are plans the weekly planner opened, not work;
--     weekly slots with work attached stay as hand-planned slots;
--   * the adoption rows are kept, renamed client_weekly_delivery_standards_rolled_back,
--     and standard 2 with the cadence columns stays (the adoptions name it).
do $guard$
begin
  if (exists (select 1 from client_weekly_delivery_standards)
      or exists (select 1 from content_plan_items where standard_week is not null or retired_at is not null))
     and coalesce(current_setting('compass.weekly_rollback', true), '') <> 'confirmed' then
    raise exception 'rollback 20261030180000: weekly adoptions or weekly / retired slots exist; set compass.weekly_rollback = ''confirmed'' to restore the monthly plan (see the header)';
  end if;
end $guard$;

select cron.unschedule('delivery-standard-week');

-- Readiness, the monthly planner and the Wednesday beat: take the inserted
-- blocks back out. Each edit is {original, weekly}, exactly as the
-- migration made it; undone last-first.
do $restore$
declare
  def text;
  clause text := $c$    -- weekly_gbp_capacity_v1 (20261030180000): one post per location per day.
    when s.standard_key = 'gbp_posts' and gbp_slot_capacity_problem(s.id, d.account_id) is not null
      then gbp_slot_capacity_problem(s.id, d.account_id)
$c$;
  pdm_edits text[][] := array[
    -- The clock: delivery_today() (the Chicago date in production; a pinned date in the sandbox).
    array[$a$  today date := (now() at time zone 'America/Chicago')::date;$a$, $b$  today date := delivery_today();$b$],
    array[$a$  first_day := greatest(m, today);
$a$, $b$  -- weekly_delivery_v1 (20261030180000): a month the weekly standard governs is planned week by week;
  -- the monthly loop below then opens its page refresh only.
  if client_weekly_first_week(p_client_id) < m_end then
    for d in select x::date from generate_series(greatest(delivery_next_monday(m), delivery_week_start(delivery_today())), m_end - 1, interval '7 days') x loop
      made := made + plan_delivery_week(p_client_id, d);
    end loop;
    if greatest(m, today) >= m_end then return made; end if;
  end if;
  first_day := greatest(m, today);
$b$],
    array[$a$x.unit_kind in ('brand', 'client') and x.remaining > 0 loop$a$, $b$x.unit_kind in ('brand', 'client') and x.remaining > 0
                 and (x.deliverable = 'page_refreshes' or coalesce(client_weekly_first_week(p_client_id) >= m_end, true)) loop$b$]];
  cwbt_edits text[][] := array[
    array[$a$declare c record; u record;$a$, $b$declare horizon date; c record; u record;$b$],
    -- The clock: delivery_today() (the Chicago date in production; a pinned date in the sandbox).
    array[$a$  week date:=date_trunc('week',now() at time zone 'America/Chicago')::date;$a$, $b$  week date:=delivery_week_start(delivery_today());$b$],
    array[$a$    perform plan_delivery_month(c.id, week);
$a$, $b$    perform plan_delivery_month(c.id, week);
    -- weekly_delivery_v1 (20261030180000): a weekly client's next week is planned and queued now.
    horizon := case when client_weekly_first_week(c.id) <= week + 7 then week + 13 else week + 6 end;
    if horizon > week + 6 then perform plan_delivery_week(c.id, week + 7); end if;
$b$],
    array[$a$case when c.status = 'active' then null else week end, week+6)$a$, $b$case when c.status = 'active' then null else week end, horizon)$b$],
    array[$a$social := queue_standard_social_tasks(c.id, week+6);$a$, $b$social := queue_standard_social_tasks(c.id, horizon);$b$]];
  i int;
begin
  def := pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure);
  if strpos(def, clause) = 0 then raise exception 'social_slot_readiness does not carry the weekly clause as written; restore it by hand'; end if;
  execute replace(def, clause, '');
  def := pg_get_functiondef('public.plan_delivery_month(uuid,date)'::regprocedure);
  for i in reverse array_length(pdm_edits, 1)..1 loop
    if strpos(def, pdm_edits[i][2]) = 0 then
      raise exception 'plan_delivery_month does not carry weekly edit % as written; restore it by hand', i;
    end if;
    def := replace(def, pdm_edits[i][2], pdm_edits[i][1]);
  end loop;
  execute def;
  def := pg_get_functiondef('public.create_weekly_blog_tasks()'::regprocedure);
  for i in reverse array_length(cwbt_edits, 1)..1 loop
    if strpos(def, cwbt_edits[i][2]) = 0 then
      raise exception 'create_weekly_blog_tasks does not carry weekly edit % as written; restore it by hand', i;
    end if;
    def := replace(def, cwbt_edits[i][2], cwbt_edits[i][1]);
  end loop;
  execute def;
end $restore$;

drop function delivery_targets(uuid, date);
alter function delivery_targets_monthly(uuid, date) rename to delivery_targets;
comment on function delivery_targets(uuid, date) is
  'Monthly delivery standard per brand site (or client): target, completed, planned, remaining, unverified refreshes and the recorded destination. Operational only; never reads billing.';

-- Slots.
drop trigger content_plan_items_standard_week on content_plan_items;
update content_plan_items
   set hold = retired_hold, hold_reason = retired_hold_reason, retired_at = null, retired_hold = null, retired_hold_reason = null
 where retired_at is not null;
delete from content_plan_items i
 where i.standard_week is not null and i.social_post_id is null and i.content_post_id is null
   and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)
   and not exists (select 1 from tasks t where t.client_id = i.client_id and t.status <> 'done'
                     and (t.key = 'social_slot:' || i.id::text or (t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%')));
drop index content_plan_items_standard_week_slot;
alter table content_plan_items
  drop constraint content_plan_items_standard_week_shape,
  drop column standard_week, drop column standard_week_seq,
  drop column retired_at, drop column retired_hold, drop column retired_hold_reason;

drop function delivery_week_report(uuid, date, date, date);
drop function plan_delivery_weeks();
drop function queue_delivery_week_drafts(uuid, date);
drop function plan_delivery_week(uuid, date);
drop function delivery_weekly_month_target(uuid, text, date);
drop function gbp_slot_capacity_problem(uuid, uuid);
drop function delivery_gbp_locations(uuid);
drop function delivery_items(uuid, date, date);
drop function delivery_v1_slot_retirable(uuid, date);
drop function content_plan_items_standard_week();

do $adoptions$
begin
  if exists (select 1 from client_weekly_delivery_standards) then
    drop trigger client_weekly_delivery_guard on client_weekly_delivery_standards;
    alter table client_weekly_delivery_standards rename to client_weekly_delivery_standards_rolled_back;
    revoke insert on client_weekly_delivery_standards_rolled_back from authenticated, service_role;
  else
    drop table client_weekly_delivery_standards;
    alter table delivery_standards disable trigger delivery_standards_guard;
    delete from delivery_standards where version = 2 and cadence = 'weekly';
    alter table delivery_standards enable trigger delivery_standards_guard;
    drop trigger client_delivery_standards_monthly on client_delivery_standards;
    drop function client_delivery_standards_monthly();
    alter table delivery_standards drop constraint delivery_standards_cadence_shape,
      drop column cadence, drop column gbp_daily_location_cap;
  end if;
end $adoptions$;

drop function client_weekly_delivery_guard();
drop function client_weekly_delivery_standard(uuid, date);
drop function client_weekly_first_week(uuid);
drop function delivery_day_rank(date);
drop function delivery_daily_target(integer, date);
drop function delivery_next_monday(date);
drop function delivery_week_start(date);
drop function delivery_today();

do $verify$
begin
  if md5(pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure)) <> '7d82b3b6f7d34c4d11118e642366d0ac'
     or md5(pg_get_functiondef('public.plan_delivery_month(uuid,date)'::regprocedure)) <> '4a6fc125878f692f756e88e13ea45a53'
     or md5(pg_get_functiondef('public.delivery_targets(uuid,date)'::regprocedure)) <> '4d67bf3ff886339f6675c56a73bbf311'
     or md5(pg_get_functiondef('public.create_weekly_blog_tasks()'::regprocedure)) <> 'fdddc0423cafc81c222fa4231938b6ad' then
    raise exception 'rollback 20261030180000: a function was not restored exactly';
  end if;
end $verify$;
