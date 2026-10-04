-- 0061 — Billing B4: reconciliation run history and the reads behind it.
--
-- Reconciliation (supabase/functions/stripe-reconcile) is not a second sync:
-- it asks the shared B2 sync layer to re-read what Stripe holds and lets
-- billing_sync_apply (0059) write it, exactly as a webhook would. This
-- migration only records what each run did, and gives it a way to see what
-- changed:
--
--   1. billing_reconciliation_runs: one row per run (mode, trigger, status,
--      counters, a compact summary). One running run per mode.
--   2. billing_reconciliation_results: one row per client per run (healthy /
--      repaired / attention / failed, what changed by category, the attention
--      reasons at the time). "When was this client last reconciled, and did it
--      find anything?"
--   3. billing_mirror_fingerprint / billing_catalog_fingerprint: a digest per
--      mirrored Stripe object (the row without its bookkeeping columns). The
--      function takes one before and one after re-reading a client, and the
--      difference is what reconciliation repaired. No Stripe payload is stored.
--   4. client_billing_reconciliation (latest result per client, current mode)
--      and billing_sync_health (webhook ledger + latest run), for the screens.
--   5. billing_fire_reconciliation(): the scheduler's call, NOT scheduled here
--      (docs/billing-cutover.md enables it after cutover).
--
-- Writes happen only inside these functions, called from an authenticator +
-- service_role session (an Edge Function), through 0059's mirror guard. The
-- shared service-role key residual (docs/billing.md) applies unchanged.
-- Nothing here touches external payments, agreements or entitlements.

-- ── 1. Tables ────────────────────────────────────────────────────────────────
create table billing_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  livemode boolean not null,
  trigger text not null check (trigger in ('schedule', 'admin', 'admin_client')),
  requested_by uuid references team_members on delete set null,
  scope_client_id uuid references clients on delete restrict,
  status text not null default 'running'
    check (status in ('running', 'completed', 'completed_with_errors', 'partial', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  customers_examined int not null default 0 check (customers_examined >= 0),
  customers_repaired int not null default 0 check (customers_repaired >= 0),
  objects_examined int not null default 0 check (objects_examined >= 0),
  records_changed int not null default 0 check (records_changed >= 0),
  warnings int not null default 0 check (warnings >= 0),
  failures int not null default 0 check (failures >= 0),
  events_recovered int not null default 0 check (events_recovered >= 0),
  -- {examined: {object: n}, changed: {category: n}, warnings: [...], failures: [...], skipped: n}
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  error text,
  check ((status = 'running') = (completed_at is null)),
  check (status <> 'failed' or error is not null),
  check (trigger <> 'schedule' or requested_by is null),
  check ((trigger = 'admin_client') = (scope_client_id is not null))
);
create unique index billing_reconciliation_one_running on billing_reconciliation_runs (livemode) where status = 'running';
create index on billing_reconciliation_runs (livemode, started_at desc);

create table billing_reconciliation_results (
  run_id uuid not null references billing_reconciliation_runs on delete restrict,
  client_id uuid not null references clients on delete restrict,
  stripe_customer_id text not null,
  livemode boolean not null,
  status text not null check (status in ('healthy', 'repaired', 'attention', 'failed')),
  records_changed int not null default 0 check (records_changed >= 0),
  changes jsonb not null default '{}' check (jsonb_typeof(changes) = 'object'), -- {category: n}
  objects_examined int not null default 0 check (objects_examined >= 0),
  attention_reasons text[] not null default '{}',
  warnings text[] not null default '{}',
  error text,
  checked_at timestamptz not null default clock_timestamp(),
  primary key (run_id, client_id),
  check (status <> 'failed' or error is not null),
  check (status <> 'repaired' or records_changed > 0)
);
create index on billing_reconciliation_results (client_id, livemode, checked_at desc);

alter table billing_reconciliation_runs enable row level security;
alter table billing_reconciliation_results enable row level security;
create policy "team read" on billing_reconciliation_runs for select to authenticated using ((select is_team()));
create policy "team read" on billing_reconciliation_results for select to authenticated using ((select is_team()));
do $$
declare t text;
begin
  foreach t in array array['billing_reconciliation_runs', 'billing_reconciliation_results'] loop
    execute format('revoke all on %I from public, anon, authenticated, service_role', t);
    execute format('grant select on %I to authenticated, service_role', t);
    execute format('create trigger %I before insert or update or delete on %I for each row execute function billing_mirror_guard()',
      t || '_sync_guard', t);
    execute format('create trigger %I before truncate on %I for each statement execute function billing_mirror_guard()',
      t || '_sync_guard_truncate', t);
  end loop;
end $$;

-- A result is a record of what happened: never changed or removed. A run is
-- changed only while it is running (by billing_reconcile_finish).
create function billing_reconciliation_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if billing_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_table_name = 'billing_reconciliation_runs' and tg_op = 'UPDATE' and old.status = 'running' then
    return new;
  end if;
  raise exception 'Reconciliation history is append-only' using errcode = 'check_violation';
end $$;
revoke all on function billing_reconciliation_immutable() from public, anon, authenticated;
create trigger billing_reconciliation_runs_immutable before update or delete on billing_reconciliation_runs
  for each row execute function billing_reconciliation_immutable();
create trigger billing_reconciliation_results_immutable before update or delete on billing_reconciliation_results
  for each row execute function billing_reconciliation_immutable();

-- ── 2. Run functions (Edge Function session only) ────────────────────────────
-- p = {livemode, trigger, requested_by, scope_client_id}. A run left running
-- for 30 minutes is closed as failed first (its function died); a live run in
-- the same mode refuses the new one (55P03).
create function billing_reconcile_begin(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_live boolean := (p ->> 'livemode')::boolean;
  v_trigger text := p ->> 'trigger';
begin
  perform billing_require_service();
  if v_live is null then raise exception 'livemode is required' using errcode = 'check_violation'; end if;
  if v_trigger in ('admin', 'admin_client')
     and not exists (select 1 from team_members where id = (p ->> 'requested_by')::uuid and role = 'admin') then
    raise exception 'Only an admin starts a reconciliation by hand' using errcode = '42501';
  end if;
  if p ->> 'scope_client_id' is not null
     and not exists (select 1 from clients where id = (p ->> 'scope_client_id')::uuid) then
    raise exception 'client % does not exist', p ->> 'scope_client_id' using errcode = '23503';
  end if;
  update billing_reconciliation_runs
     set status = 'failed', completed_at = now(), error = 'Abandoned: the run did not finish within 30 minutes'
   where livemode = v_live and status = 'running' and started_at < now() - interval '30 minutes';
  begin
    insert into billing_reconciliation_runs (livemode, trigger, requested_by, scope_client_id)
    values (v_live, v_trigger, case when v_trigger = 'schedule' then null else (p ->> 'requested_by')::uuid end,
            (p ->> 'scope_client_id')::uuid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'A billing reconciliation is already running' using errcode = '55P03';
  end;
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('id', v_id);
end $$;

-- p = {run_id, client_id, stripe_customer_id, status, records_changed,
-- changes, objects_examined, attention_reasons, warnings, error}. The client
-- must own that customer in the run's mode.
create function billing_reconcile_client(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_live boolean;
begin
  perform billing_require_service();
  select livemode into v_live from billing_reconciliation_runs
   where id = (p ->> 'run_id')::uuid and status = 'running';
  if not found then
    raise exception 'reconciliation run % is not running', p ->> 'run_id' using errcode = '55000';
  end if;
  if not exists (select 1 from stripe_customers where client_id = (p ->> 'client_id')::uuid
                   and stripe_customer_id = p ->> 'stripe_customer_id' and livemode = v_live) then
    raise exception 'customer % is not the client''s in this mode', p ->> 'stripe_customer_id' using errcode = '23503';
  end if;
  insert into billing_reconciliation_results (run_id, client_id, stripe_customer_id, livemode, status, records_changed,
      changes, objects_examined, attention_reasons, warnings, error)
  values ((p ->> 'run_id')::uuid, (p ->> 'client_id')::uuid, p ->> 'stripe_customer_id', v_live, p ->> 'status',
          coalesce((p ->> 'records_changed')::int, 0), coalesce(p -> 'changes', '{}'),
          coalesce((p ->> 'objects_examined')::int, 0),
          coalesce(array(select jsonb_array_elements_text(p -> 'attention_reasons')), '{}'),
          coalesce(array(select jsonb_array_elements_text(p -> 'warnings')), '{}'),
          p ->> 'error');
  perform set_config('compass.billing_sync', 'off', true);
end $$;

-- p = {run_id, status, customers_examined, customers_repaired,
-- objects_examined, records_changed, warnings, failures, events_recovered,
-- summary, error}. Only a running run is finished, once.
create function billing_reconcile_finish(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform billing_require_service();
  if coalesce(p ->> 'status', 'running') = 'running' then
    raise exception 'a run finishes with a final status' using errcode = 'check_violation';
  end if;
  update billing_reconciliation_runs set
    status = p ->> 'status', completed_at = clock_timestamp(),
    customers_examined = coalesce((p ->> 'customers_examined')::int, 0),
    customers_repaired = coalesce((p ->> 'customers_repaired')::int, 0),
    objects_examined = coalesce((p ->> 'objects_examined')::int, 0),
    records_changed = coalesce((p ->> 'records_changed')::int, 0),
    warnings = coalesce((p ->> 'warnings')::int, 0),
    failures = coalesce((p ->> 'failures')::int, 0),
    events_recovered = coalesce((p ->> 'events_recovered')::int, 0),
    summary = coalesce(p -> 'summary', '{}'),
    error = p ->> 'error'
  where id = (p ->> 'run_id')::uuid and status = 'running';
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'reconciliation run % is not running', p ->> 'run_id' using errcode = '55000';
  end if;
  perform set_config('compass.billing_sync', 'off', true);
end $$;

-- ── 3. Fingerprints (read-only) ──────────────────────────────────────────────
-- A digest of a mirrored row without its bookkeeping columns: equal digests
-- mean Stripe's data did not change. A subscription's digest includes its
-- items, an invoice's its lines, so one changed object counts once.
create function billing_row_digest(r jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
  select md5((r - array['id', 'created_at', 'updated_at', 'stripe_synced_at', 'subscription_id', 'invoice_id'])::text)
$$;

create function billing_mirror_fingerprint(p_client uuid, p_livemode boolean) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'customer', coalesce((select jsonb_object_agg(c.stripe_customer_id, billing_row_digest(to_jsonb(c)))
      from stripe_customers c where c.client_id = p_client and c.livemode = p_livemode), '{}'),
    'subscription', coalesce((select jsonb_object_agg(s.stripe_subscription_id, md5(billing_row_digest(to_jsonb(s)) || coalesce(
        (select string_agg(billing_row_digest(to_jsonb(i)), ',' order by i.stripe_subscription_item_id)
         from subscription_items i where i.subscription_id = s.id), '')))
      from subscriptions s where s.client_id = p_client and s.livemode = p_livemode), '{}'),
    'invoice', coalesce((select jsonb_object_agg(v.stripe_invoice_id, md5(billing_row_digest(to_jsonb(v)) || coalesce(
        (select string_agg(billing_row_digest(to_jsonb(l)), ',' order by l.stripe_line_item_id)
         from invoice_line_items l where l.invoice_id = v.id), '')))
      from invoices v where v.client_id = p_client and v.livemode = p_livemode), '{}'),
    'payment', coalesce((select jsonb_object_agg(pm.stripe_payment_intent_id, billing_row_digest(to_jsonb(pm)))
      from payments pm where pm.client_id = p_client and pm.source = 'stripe' and pm.livemode = p_livemode), '{}'),
    'refund', coalesce((select jsonb_object_agg(r.stripe_refund_id, billing_row_digest(to_jsonb(r)))
      from stripe_refunds r where r.client_id = p_client and r.livemode = p_livemode), '{}'),
    'checkout', coalesce((select jsonb_object_agg(cs.stripe_checkout_session_id, billing_row_digest(to_jsonb(cs)))
      from checkout_sessions cs where cs.client_id = p_client and cs.livemode = p_livemode), '{}'))
$$;

-- The Stripe Products the catalog maps (packages and one-time items) in a
-- mode, and every Price on them.
create function billing_catalog_fingerprint(p_livemode boolean) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with mapped as (
    select stripe_product_id from billing_packages where stripe_product_id is not null
    union select stripe_product_id from billing_one_time_items where stripe_product_id is not null)
  select jsonb_build_object(
    'product', coalesce((select jsonb_object_agg(p.stripe_product_id, billing_row_digest(to_jsonb(p)))
      from stripe_products p join mapped m using (stripe_product_id) where p.livemode = p_livemode), '{}'),
    'price', coalesce((select jsonb_object_agg(pr.stripe_price_id, billing_row_digest(to_jsonb(pr)))
      from stripe_prices pr join mapped m using (stripe_product_id) where pr.livemode = p_livemode), '{}'))
$$;

-- ── 4. Read models for the screens (invoker rights: RLS applies) ─────────────
create view client_billing_reconciliation with (security_invoker = true) as
select distinct on (r.client_id)
  r.client_id, r.run_id, r.stripe_customer_id, r.livemode, r.status, r.records_changed, r.changes,
  r.attention_reasons, r.warnings, r.error, r.checked_at, run.trigger
from billing_reconciliation_results r
join billing_reconciliation_runs run on run.id = r.run_id
where r.livemode = billing_livemode()
order by r.client_id, r.checked_at desc;

create view billing_sync_health with (security_invoker = true) as
select
  m.livemode,
  (select max(e.received_at) from stripe_events e where e.livemode = m.livemode) as last_event_at,
  (select count(*) from stripe_events e where e.livemode = m.livemode and e.status = 'failed')::int as failed_events,
  (select count(*) from stripe_events e where e.livemode = m.livemode and e.status = 'processing'
     and e.lease_expires_at < now())::int as stuck_events,
  lr.id as last_run_id, lr.status as last_run_status, lr.trigger as last_run_trigger,
  lr.started_at as last_run_started_at, lr.completed_at as last_run_completed_at,
  lr.customers_examined as last_run_customers, lr.records_changed as last_run_records_changed,
  lr.warnings as last_run_warnings, lr.failures as last_run_failures
from (select billing_livemode() as livemode) m
left join lateral (
  select * from billing_reconciliation_runs r where r.livemode = m.livemode and r.trigger <> 'admin_client'
  order by r.started_at desc limit 1) lr on true;

revoke all on client_billing_reconciliation, billing_sync_health from public, anon, authenticated;
grant select on client_billing_reconciliation, billing_sync_health to authenticated, service_role;

-- ── 5. The scheduler's call (not scheduled here) ─────────────────────────────
-- pg_cron runs this as postgres: an authenticated POST to stripe-reconcile
-- with the anon key (the gateway's JWT check) and the dedicated
-- BILLING_RECONCILE_SECRET (the function's own check). Without the secret it
-- does nothing. docs/billing-cutover.md schedules it daily after cutover.
create function billing_fire_reconciliation() returns bigint
language plpgsql set search_path = public, pg_temp as $$
declare
  v_secret text := get_secret('BILLING_RECONCILE_SECRET');
  v_request bigint;
begin
  if v_secret is null then return null; end if;
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/stripe-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-billing-reconcile-secret', v_secret),
    body := jsonb_build_object('trigger', 'schedule'),
    timeout_milliseconds := 30000) into v_request;
  return v_request;
end $$;

revoke all on function billing_row_digest(jsonb) from public, anon, authenticated;
revoke all on function billing_mirror_fingerprint(uuid, boolean) from public, anon, authenticated;
revoke all on function billing_catalog_fingerprint(boolean) from public, anon, authenticated;
revoke all on function billing_reconcile_begin(jsonb) from public, anon, authenticated;
revoke all on function billing_reconcile_client(jsonb) from public, anon, authenticated;
revoke all on function billing_reconcile_finish(jsonb) from public, anon, authenticated;
revoke all on function billing_fire_reconciliation() from public, anon, authenticated, service_role;
grant execute on function billing_row_digest(jsonb) to service_role;
grant execute on function billing_mirror_fingerprint(uuid, boolean) to service_role;
grant execute on function billing_catalog_fingerprint(boolean) to service_role;
grant execute on function billing_reconcile_begin(jsonb) to service_role;
grant execute on function billing_reconcile_client(jsonb) to service_role;
grant execute on function billing_reconcile_finish(jsonb) to service_role;

-- ── 6. Verify ────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['billing_reconciliation_runs', 'billing_reconciliation_results'] loop
    if has_table_privilege('service_role', 'public.' || t, 'insert,update,delete,truncate')
       or has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete,truncate')
       or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0061: % is writable through the API', t;
    end if;
  end loop;
  foreach t in array array['billing_reconcile_begin(jsonb)', 'billing_reconcile_client(jsonb)',
    'billing_reconcile_finish(jsonb)', 'billing_mirror_fingerprint(uuid,boolean)', 'billing_catalog_fingerprint(boolean)',
    'billing_fire_reconciliation()'] loop
    if has_function_privilege('authenticated', 'public.' || t, 'execute')
       or has_function_privilege('anon', 'public.' || t, 'execute') then
      raise exception '0061: % is callable by a signed-in user or anon', t;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.client_billing_reconciliation', 'select')
     or has_table_privilege('anon', 'public.billing_sync_health', 'select')
     or has_table_privilege('authenticated', 'public.billing_sync_health', 'insert') then
    raise exception '0061: a reconciliation view grants more than authenticated SELECT';
  end if;
end $$;
