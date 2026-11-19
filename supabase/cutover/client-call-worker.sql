-- Run only after deploying client-call-worker. Reads the existing Vault secret.
-- No per-client calling, recording, summarization, or email switch changes here.
select cron.schedule('client-call-worker','* * * * *',$job$
  select net.http_post(
    url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/client-call-worker',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',public.get_secret('SYNC_CRON_SECRET')),
    body:='{}'::jsonb,timeout_milliseconds:=120000
  ) where exists(select 1 from public.client_voice_recordings where state in ('queued','submitted') or (expires_at<=now() and state<>'deleted'))
    or exists(select 1 from public.client_voice_summary_emails where status='pending');
$job$);
