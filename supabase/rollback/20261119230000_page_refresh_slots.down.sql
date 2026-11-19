-- Rollback of 20261119230000_page_refresh_slots.sql. Tasks it opened are
-- kept (they are work records); only the scheduler and the function go.
select cron.unschedule('page-refresh-month') where exists (select 1 from cron.job where jobname = 'page-refresh-month');
select cron.unschedule('page-refresh-weekly') where exists (select 1 from cron.job where jobname = 'page-refresh-weekly');
drop function if exists queue_page_refresh_slots(date);
-- The wider delivery_queue_log check stays: page_refreshes rows are history.
