-- Fires that the Routine API refused are retried, not lost.
--
-- Nine worker sessions started within half an hour on Sept 13 and the tenth
-- fire (a monthly cycle started by hand) came back 429. Nothing retried it:
-- fire_foundation_worker() logs the pg_net request id and moves on, and the
-- next thing that would have picked the work up was the daily sweep. A
-- chain must not lose a link to a rate limit, so every 15 minutes
-- retry_failed_fires() looks at fires from the last day whose response was
-- 429 or a 5xx (or that never got one) and fires them again, once per
-- attempt, up to three attempts, skipping any whose work has since been
-- picked up by another fire for the same client and reason.

alter table worker_fires
  add column if not exists retry_of bigint references worker_fires(id) on delete set null,
  add column if not exists attempt int not null default 1;

create index if not exists worker_fires_client_reason_idx on worker_fires (client_id, reason, created_at desc);

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
      and w.attempt < 3
      and (r.id is null or r.status_code = 429 or r.status_code >= 500)
      -- not already retried
      and not exists (select 1 from worker_fires w2 where w2.retry_of = w.id)
      -- no later successful fire for the same client + reason
      and not exists (
        select 1 from worker_fires w3
        join net._http_response r3 on r3.id = w3.request_id
        where w3.client_id = w.client_id and w3.reason = w.reason
          and w3.created_at > w.created_at and r3.status_code = 200)
    order by w.created_at
    limit 5   -- spread across ticks so the retries themselves are not a burst
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

revoke execute on function retry_failed_fires() from public, anon, authenticated;

select cron.unschedule('retry-failed-fires')
where exists (select 1 from cron.job where jobname = 'retry-failed-fires');
select cron.schedule('retry-failed-fires', '*/15 * * * *', $$select public.retry_failed_fires()$$);
