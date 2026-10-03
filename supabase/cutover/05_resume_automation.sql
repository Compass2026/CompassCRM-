-- Billing cutover, step 5: resume the automation paused by step 1 — only
-- after 04_validate.sql passed. Then unpause the Foundation worker Routine.
select cron.alter_job(jobid, active := true)
from cron.job
where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting');

select jobname, schedule, active from cron.job
where jobname in ('weekly-blog-posts', 'fire-website-updates', 'fire-monthly-reporting')
order by jobname;
