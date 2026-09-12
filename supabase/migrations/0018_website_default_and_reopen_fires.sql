-- Every new client gets a website; reopening any stage fires the worker.
--
-- 1. New clients are enrolled in Website at creation (Tom, Sept 12 2026:
--    "all new clients get everything"). The enrollment gate parks it as
--    pending until Foundation completes, at which point
--    handle_foundation_completion activates it and the worker builds the
--    bones. Enrolling it on insert, rather than letting the worker decide
--    late in Foundation, makes the intent visible on the Plan tab from
--    minute one and removes a rule that lived only in the skill.
-- 2. fire_worker_on_stage_change fired only on blocked → not_started. A
--    backfill is complete → not_started, so it fires on any transition into
--    not_started. Setting a stage back to Not started is now, universally,
--    "run the worker on this".

-- ── 1. Website on every new client ───────────────────────────────────────
create or replace function enroll_client_in_website() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_pipelines (client_id, pipeline_id, status)
  select new.id, p.id, 'active'          -- the gate parks it as pending
  from pipelines p
  where p.key = 'website'
  on conflict (client_id, pipeline_id) do nothing;
  return new;
end $$;

revoke execute on function enroll_client_in_website() from public, anon, authenticated;

-- Named to run after clients_foundation_enrollment (alphabetical), so the
-- gate sees Foundation and parks Website behind it.
drop trigger if exists clients_zz_website_enrollment on clients;
create trigger clients_zz_website_enrollment after insert on clients
  for each row execute function enroll_client_in_website();

-- ── 2. Any reopen fires the worker ───────────────────────────────────────
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
  elsif new.status = 'not_started' and v_key in ('foundation', 'website') then
    perform fire_foundation_worker(v_client, v_stage || ' reopened');
  end if;
  return new;
end $$;

revoke execute on function fire_worker_on_stage_change() from public, anon, authenticated;
