-- Billing cutover, step 1: pause the automation B5 changes, so no active
-- client is skipped (or planned for) while agreements are being entered.
--
--   weekly-blog-posts     create_weekly_blog_tasks()   Wed 09:00 UTC — gated by blog_posts from 0062
--   fire-website-updates  fire_website_updates()       2nd 09:00 UTC — gated by website + pages / refreshes
--   fire-monthly-reporting fire_monthly_reporting()    1st 09:00 UTC — the worker's report reads the allocation
--
-- Also pause the "Compass Foundation worker" Routine at claude.ai/code/routines
-- (its daily sweep and any fire in flight read client_quota_usage once the
-- skill on main is the B5 one). create-monthly-cycles, the syncs, the
-- publisher and the fire retries are not affected and keep running.
-- Idempotent: pausing a paused job is a no-op.

select jobid, jobname, schedule, active as was_active
from cron.job
where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting')
order by jobname;

select cron.alter_job(jobid, active := false)
from cron.job
where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting');

select jobname, active from cron.job
where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting')
order by jobname;
