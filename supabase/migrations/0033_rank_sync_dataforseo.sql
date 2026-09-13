-- Weekly rank checks through DataForSEO, 50 tracked keywords per client
-- (Tom, Sept 13 2026: "weekly checks, 50 keywords, use DataForSEO").
--
-- BrightLocal's Local Rank Tracker bills per keyword per check and the key
-- is a trial, so the tracked list was capped at what a monthly BrightLocal
-- report could carry. The rank-sync Edge Function runs every tracked keyword
-- through DataForSEO's live SERP endpoint at the keyword's city (or the
-- client's home city), writes organic + map-pack positions into
-- rank_snapshots with source 'dataforseo', and recomputes the City Index.
-- BrightLocal stays for the 7×7 grids; its monthly sync is unchanged.
--
-- The tracked list is normalised to exactly 50 per client by
-- normalize_tracked_keywords(): money keywords first, then P2 by volume,
-- then P3 by volume. Nothing is deleted; is_tracked is the only flag moved.

alter type rank_source add value if not exists 'dataforseo';

create or replace function normalize_tracked_keywords(p_client_id uuid, p_target int default 50)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  with ranked as (
    select k.id,
           row_number() over (
             order by k.is_money desc,
                      case k.priority when 'p1' then 1 when 'p2' then 2 else 3 end,
                      k.volume desc nulls last,
                      k.created_at
           ) as rn
    from keywords k
    where k.client_id = p_client_id and k.is_active
  )
  update keywords k
  set is_tracked = (r.rn <= p_target)
  from ranked r
  where k.id = r.id and k.is_tracked is distinct from (r.rn <= p_target);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

comment on function normalize_tracked_keywords(uuid, int) is
  'Sets is_tracked on the top N active keywords (money, then priority, then volume) and clears it on the rest. Never deletes.';

-- Monday 06:00 UTC, before anything reads ranks that week.
select cron.schedule(
  'rank-sync-weekly',
  '0 6 * * 1',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/rank-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('triggered_by', 'cron'),
    timeout_milliseconds := 30000
  )
  $$
);
