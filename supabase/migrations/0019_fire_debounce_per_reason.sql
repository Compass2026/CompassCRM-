-- Debounce fires per (client, reason), not per client.
--
-- The first run after a refire finished Show Me Electrical's Brand Build
-- inside the two-minute window, so the "Brand Build complete" fire — the one
-- that starts the next stage — was dropped as a duplicate of the refire. A
-- chain must never be swallowed by the event that started it. Collapse only
-- repeats of the same reason (a bulk reopen touching three stages); let a
-- completion through regardless of what fired two minutes ago.
create or replace function fire_foundation_worker(p_client_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_token text;
  v_name text;
  v_request bigint;
begin
  v_url := get_secret('ROUTINE_FIRE_URL');
  v_token := get_secret('ROUTINE_FIRE_TOKEN');
  if v_url is null or v_token is null then
    return;
  end if;

  if exists (
    select 1 from worker_fires
    where client_id = p_client_id
      and reason = p_reason
      and created_at > now() - interval '2 minutes'
  ) then
    return;
  end if;

  select name into v_name from clients where id = p_client_id;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token,
      'anthropic-beta', 'experimental-cc-routine-2026-04-01',
      'anthropic-version', '2023-06-01'
    ),
    body := jsonb_build_object(
      'text', format('CRM event: %s for client "%s" (%s). Run the foundation-worker skill.',
                     p_reason, coalesce(v_name, '?'), p_client_id)
    )
  ) into v_request;

  insert into worker_fires (client_id, reason, request_id)
  values (p_client_id, p_reason, v_request);
end $$;

revoke execute on function fire_foundation_worker(uuid, text) from public, anon;
