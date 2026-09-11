-- Event-driven Foundation worker (Tom, Sept 11 2026).
--
-- The worker is a claude.ai Routine. Rather than polling hourly, Postgres
-- fires it at the three moments there is something to do:
--
--   1. a client is created                    → Brand Build is ready
--   2. a Foundation stage completes           → the next stage is ready; when
--                                               the last one completes, the
--                                               same transaction activates
--                                               Website, so Build to 70% is too
--   3. a Website enrollment becomes active, or a blocked stage is set back to
--      not_started                            → retry
--
-- The Routine keeps a daily schedule as a sweep. Fires go through the
-- Routine's API trigger; the URL and bearer token live in Vault as
-- ROUTINE_FIRE_URL and ROUTINE_FIRE_TOKEN. Without them, nothing fires and
-- nothing breaks — the daily sweep still finds the work.

create table worker_fires (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) on delete set null,
  reason text not null,
  request_id bigint,            -- net._http_response.id, for tracing a fire
  created_at timestamptz not null default now()
);
create index on worker_fires (client_id, created_at desc);

alter table worker_fires enable row level security;
create policy "team read worker fires" on worker_fires
  for select to authenticated using (true);

-- ── The fire itself ──────────────────────────────────────────────────────
-- Debounced: at most one fire per client per two minutes, so a data load
-- that completes three stages in one go starts one run, not three. The
-- worker's own lock makes extra runs harmless; this just keeps them rare.
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
    where client_id = p_client_id and created_at > now() - interval '2 minutes'
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

-- ── 1. Client created ────────────────────────────────────────────────────
create or replace function fire_worker_on_client_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform fire_foundation_worker(new.id, 'client created');
  return new;
end $$;

revoke execute on function fire_worker_on_client_created() from public, anon, authenticated;

drop trigger if exists clients_fire_worker on clients;
create trigger clients_fire_worker after insert on clients
  for each row execute function fire_worker_on_client_created();

-- ── 2 & 3. Stage completed, or a blocked stage reopened ──────────────────
create or replace function fire_worker_on_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_key pipeline_key;
  v_stage text;
begin
  if new.status = old.status then
    return new;
  end if;

  select cp.client_id, p.key, s.name
  into v_client, v_key, v_stage
  from client_pipelines cp
  join pipelines p on p.id = cp.pipeline_id
  join stages s on s.id = new.stage_id
  where cp.id = new.client_pipeline_id;

  if v_key = 'foundation' and new.status = 'complete' then
    perform fire_foundation_worker(v_client, v_stage || ' complete');
  elsif old.status = 'blocked' and new.status = 'not_started' then
    perform fire_foundation_worker(v_client, v_stage || ' reopened');
  end if;
  return new;
end $$;

revoke execute on function fire_worker_on_stage_change() from public, anon, authenticated;

-- Named to sort after client_stages_completion / _gate / _status, so the
-- completion cascade (pipeline complete → Website active) has already run.
drop trigger if exists client_stages_zz_fire_worker on client_stages;
create trigger client_stages_zz_fire_worker after update on client_stages
  for each row execute function fire_worker_on_stage_change();

-- ── 3. Website enrollment becomes active ─────────────────────────────────
-- Covers Tom enrolling Website after Foundation is already complete (it
-- activates immediately) as well as the pending → active flip.
create or replace function fire_worker_on_website_active() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and exists (select 1 from pipelines p where p.id = new.pipeline_id and p.key = 'website') then
    perform fire_foundation_worker(new.client_id, 'Website active');
  end if;
  return new;
end $$;

revoke execute on function fire_worker_on_website_active() from public, anon, authenticated;

drop trigger if exists client_pipelines_zz_fire_worker on client_pipelines;
create trigger client_pipelines_zz_fire_worker after insert or update on client_pipelines
  for each row execute function fire_worker_on_website_active();
