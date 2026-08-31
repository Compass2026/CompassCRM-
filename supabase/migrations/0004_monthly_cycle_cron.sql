-- Monthly cycle automation: on the 1st of each month (06:00 UTC), create a
-- monthly_cycles row + recurring tasks for every active client in Reporting.
create extension if not exists pg_cron;

select cron.schedule(
  'create-monthly-cycles',
  '0 6 1 * *',
  $$select public.create_monthly_cycles()$$
);
