-- rank-sync runs on DataForSEO's task queue, not the live endpoint: live
-- takes one task per request (the first Sept 13 run posted 50 per call and
-- only the first keyword of each batch answered) and costs ten times as
-- much. The Monday 06:00 post stays; a collect beat every 20 minutes picks
-- up finished tasks and is a no-op when nothing is ready, so a run fired by
-- hand is collected the same way.

select cron.schedule(
  'rank-sync-collect',
  '*/20 * * * *',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/rank-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('mode', 'collect', 'triggered_by', 'cron'),
    timeout_milliseconds := 30000
  )
  $$
);
