-- GSC sync support: per-client Search Console property (auto-matched from
-- website_url when possible, overridable), natural-key dedupe for
-- gsc_snapshots, and the monthly ingestion schedule (1st, 07:30 UTC).
-- Secrets (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN) live in Vault.

alter table clients add column gsc_property text;

create unique index gsc_snapshots_natural_key
  on gsc_snapshots (client_id, query, coalesce(page, ''), period_start, period_end);

select cron.schedule(
  'gsc-monthly-sync',
  '30 7 1 * *',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/gsc-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('triggered_by', 'cron')
  )
  $$
);
