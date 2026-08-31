-- Plumbing for the BrightLocal sync Edge Function:
-- vault access for service role, pg_net for cron-triggered HTTP, and the
-- monthly schedule (1st, 07:00 UTC — after create_monthly_cycles at 06:00).
-- Secrets (BRIGHTLOCAL_API_KEY, SYNC_CRON_SECRET) live in Vault, not in git.

create extension if not exists pg_net;

create or replace function get_secret(secret_name text) returns text
language sql security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name;
$$;
revoke execute on function get_secret(text) from public, anon, authenticated;
grant execute on function get_secret(text) to service_role;

select cron.schedule(
  'brightlocal-monthly-sync',
  '0 7 1 * *',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/brightlocal-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('triggered_by', 'cron')
  )
  $$
);
