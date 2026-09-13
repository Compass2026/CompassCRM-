-- Pace the fire retries to the Routine's rate limit.
--
-- The first retry tick re-fired two dropped fires 90 seconds after the 429
-- and both were refused again: the limit is a rolling window, and a retry
-- inside it just burns an attempt. A rate limit is not a failure of the
-- fire, so: retry only when the newest answer for that client + reason is
-- more than ten minutes old, two per tick instead of five, and allow up to
-- eight attempts (two hours of ticks) before giving up. The daily sweep
-- remains the backstop after that.

create or replace function retry_failed_fires() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_fire record;
  v_url text;
  v_token text;
  v_name text;
  v_request bigint;
  v_count int := 0;
begin
  v_url := get_secret('ROUTINE_FIRE_URL');
  v_token := get_secret('ROUTINE_FIRE_TOKEN');
  if v_url is null or v_token is null then
    return 0;
  end if;

  for v_fire in
    select w.id, w.client_id, w.reason, w.attempt
    from worker_fires w
    left join net._http_response r on r.id = w.request_id
    where w.created_at > now() - interval '24 hours'
      and w.created_at < now() - interval '5 minutes'
      and w.attempt < 8
      and (r.id is null or r.status_code = 429 or r.status_code >= 500)
      -- not already retried
      and not exists (select 1 from worker_fires w2 where w2.retry_of = w.id)
      -- no later successful fire for the same client + reason
      and not exists (
        select 1 from worker_fires w3
        join net._http_response r3 on r3.id = w3.request_id
        where w3.client_id = w.client_id and w3.reason = w.reason
          and w3.created_at > w.created_at and r3.status_code = 200)
      -- outside the rate-limit window: nothing for this client + reason in
      -- the last ten minutes
      and not exists (
        select 1 from worker_fires w4
        where w4.client_id = w.client_id and w4.reason = w.reason
          and w4.created_at > now() - interval '10 minutes')
    order by w.created_at
    limit 2
  loop
    select name into v_name from clients where id = v_fire.client_id;

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
                       v_fire.reason, coalesce(v_name, '?'), v_fire.client_id)
      )
    ) into v_request;

    insert into worker_fires (client_id, reason, request_id, retry_of, attempt)
    values (v_fire.client_id, v_fire.reason, v_request, v_fire.id, v_fire.attempt + 1);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
