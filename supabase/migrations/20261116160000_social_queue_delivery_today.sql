-- queue_standard_social_tasks reads the delivery day like its callers
-- (Nov 16 2026).
--
-- The weekly delivery standard (20261030180000) moved the drafting beats onto
-- delivery_today() / delivery_week_start(): create_weekly_blog_tasks and
-- queue_delivery_week_drafts compute their week from it. The social queue they
-- call (queue_standard_social_tasks, 20261027191343) still took its week from
-- the wall clock, so the two disagreed whenever the delivery day is pinned:
-- the sandbox suite weekly_delivery_standard pins Nov 4 2026 and, once the
-- real date passed Nov 15, its Q1 found no Facebook / Business Profile slots
-- queued (the queue looked from the real week onward), stopping the sandbox
-- run in CI.
--
-- Production is unchanged: delivery_today() honours the pinned day only for a
-- superuser session; for cron, service and team callers it is today in
-- Central time, and delivery_week_start(d) is the ISO Monday, the same day as
-- date_trunc('week', d). Only that one line changes; the guard refuses to run
-- if the function is not the definition this edit was written against.
do $$
declare
  d text := pg_get_functiondef('public.queue_standard_social_tasks(uuid, date)'::regprocedure);
  a text := $a$  week date := date_trunc('week', now() at time zone 'America/Chicago')::date;$a$;
  b text := $b$  week date := delivery_week_start(delivery_today());$b$;
begin
  if strpos(d, a) = 0 then
    raise exception 'Unexpected queue_standard_social_tasks definition; review before applying';
  end if;
  execute replace(d, a, b);
  if strpos(pg_get_functiondef('public.queue_standard_social_tasks(uuid, date)'::regprocedure), b) = 0 then
    raise exception 'queue_standard_social_tasks was not updated';
  end if;
end $$;
