-- 0058 — Billing B2: the Stripe sync write boundary and the webhook ledger.
--
-- One door into the Stripe mirror. The shared sync layer
-- (supabase/functions/_shared/stripe/) is the only writer: webhook
-- processing, reconciliation (B4), linking an existing Stripe customer (B3)
-- and any manual resync all hand it the canonical Stripe object, and it
-- writes through billing_sync_apply() / billing_link_customer() here.
--
-- Who can reach those functions — the facts this relies on (checked on the
-- production project Sept 29 2026):
--   * Edge Functions reach Postgres through PostgREST: session_user
--     `authenticator`, role `service_role`. EVERY Edge Function in the project
--     holds the same service-role key (Supabase project secrets are
--     project-wide), so the database cannot tell the Stripe functions from
--     the other fourteen. Isolation between Edge Functions is code review,
--     not credentials — see docs/billing.md, "Write boundary" (a
--     production-blocking follow-up until accepted or re-hosted).
--   * The Foundation worker's SQL (Supabase MCP) runs as `postgres`: table
--     owner, BYPASSRLS, not a superuser, may SET ROLE. Its session_user is
--     always `postgres`.
--   * The app signs in as `authenticated` (teammates, portal contacts); it
--     never holds the service-role key.
--
-- So, as 0045 / 0047 do:
--   1. The mirror tables refuse every write (insert, update, delete,
--      truncate) unless it happens inside a billing sync function called by
--      an authenticator + service_role session. The worker's SQL is refused
--      whatever role it switches to or flag it sets; teammates, portal
--      contacts and anon have no write grant at all. A true superuser (the
--      platform role; sandbox fixtures) is exempt: it can switch triggers off
--      regardless.
--   2. service_role loses direct INSERT / UPDATE / DELETE / TRUNCATE on the
--      mirror: a service-role PostgREST call can only write through the sync
--      functions, which accept Stripe-shaped rows and resolve ownership from
--      the customer link themselves (a caller never names the client).
--   3. The webhook ledger: an event is claimed with a lease
--      (received | failed | expired processing → processing), finished only
--      by the attempt that claimed it, and failed with its error so Stripe's
--      retry runs it again. Concurrent deliveries of one event: one works,
--      the other is told it is in progress.
--   OUT OF SCOPE (as 0047): a deliberate schema change by the table owner
--   (disabling or dropping these triggers) defeats any in-database control.

-- ── 1. Ledger: processing with a lease ───────────────────────────────────────
alter table stripe_events drop constraint stripe_events_status_check;
alter table stripe_events
  add column lease_expires_at timestamptz,
  add constraint stripe_events_status_check
    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  add constraint stripe_events_lease_check check ((status = 'processing') = (lease_expires_at is not null));
drop index stripe_events_pending;
create index stripe_events_pending on stripe_events (received_at) where status in ('received', 'processing', 'failed');

-- ── 2. Caller helpers ────────────────────────────────────────────────────────
-- PostgREST's login with the service role: an Edge Function. The worker's SQL
-- (session_user postgres) never is, whatever role it switches to.
create function billing_caller_is_service() returns boolean
language sql stable set search_path = public as $$
  select session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role'
$$;
-- ...inside a billing sync function's transaction.
create function billing_sync_active() returns boolean
language sql stable set search_path = public as $$
  select billing_caller_is_service() and coalesce(current_setting('compass.billing_sync', true), '') = 'on'
$$;
create function billing_caller_is_superuser() returns boolean
language sql stable set search_path = public, pg_catalog as $$
  select coalesce((select rolsuper from pg_roles where rolname = session_user), false)
$$;
revoke all on function billing_caller_is_service() from public, anon, authenticated;
revoke all on function billing_sync_active() from public, anon, authenticated;
revoke all on function billing_caller_is_superuser() from public, anon, authenticated;

-- ── 3. The mirror guard ──────────────────────────────────────────────────────
create function billing_mirror_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if billing_sync_active() or billing_caller_is_superuser() then
    return case when tg_level = 'ROW' then coalesce(new, old) end;
  end if;
  raise exception 'The Stripe mirror (%) is written only by the Stripe sync functions', tg_table_name
    using errcode = '42501';
end $$;
revoke all on function billing_mirror_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events'] loop
    execute format('create trigger %I before insert or update or delete on %I for each row execute function billing_mirror_guard()',
      t || '_sync_guard', t);
    execute format('create trigger %I before truncate on %I for each statement execute function billing_mirror_guard()',
      t || '_sync_guard_truncate', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on %I from service_role', t);
    execute format('grant select on %I to service_role', t);
  end loop;
end $$;

-- ── 4. Generic writers (called only inside the sync functions) ───────────────
-- Upsert one Stripe-shaped row by its Stripe key(s). Only the columns the row
-- names are written (an omitted column keeps its value), and a row fetched
-- earlier than the stored one never overwrites it (stripe_synced_at is the
-- time the object was read from Stripe): concurrent or reordered syncs
-- converge on the newest read. Returns the written row (NULL when stale).
create function billing_upsert(p_table text, p_keys text[], p_row jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  cols text[];
  v_written jsonb;
begin
  select array_agg(a.attname::text order by a.attnum) into cols
  from pg_attribute a
  where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname not in ('id', 'created_at', 'updated_at') and p_row ? a.attname;
  execute format(
    'insert into %1$I as t (%2$s) select %2$s from jsonb_populate_record(null::%1$I, $1)
     on conflict (%3$s) do update set %4$s where t.stripe_synced_at <= excluded.stripe_synced_at
     returning to_jsonb(t)',
    p_table,
    (select string_agg(quote_ident(c), ', ') from unnest(cols) c),
    (select string_agg(quote_ident(k), ', ') from unnest(p_keys) k),
    (select string_agg(format('%1$I = excluded.%1$I', c), ', ') from unnest(cols) c
      where c <> all (p_keys) and c <> 'client_id'))
  using p_row into v_written;
  return v_written;
end $$;

-- Update an existing row only (never creates one): customers and checkout
-- sessions exist because Compass linked or created them. Returns
-- 'written' | 'stale' | 'missing'.
create function billing_update(p_table text, p_key text, p_row jsonb)
returns text language plpgsql set search_path = public as $$
declare
  cols text[];
  n int;
begin
  execute format('select count(*) from %I where %I = $1', p_table, p_key) using p_row ->> p_key into n;
  if n = 0 then return 'missing'; end if;
  select array_agg(a.attname::text order by a.attnum) into cols
  from pg_attribute a
  where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname not in ('id', 'created_at', 'updated_at', 'client_id', p_key) and p_row ? a.attname;
  execute format(
    'update %1$I as t set %2$s from jsonb_populate_record(null::%1$I, $1) r
     where t.%3$I = r.%3$I and t.stripe_synced_at <= r.stripe_synced_at',
    p_table,
    (select string_agg(format('%1$I = r.%1$I', c), ', ') from unnest(cols) c),
    p_key)
  using p_row;
  get diagnostics n = row_count;
  return case when n > 0 then 'written' else 'stale' end;
end $$;

-- The client that owns a Stripe customer, in the object's mode. An object
-- whose customer is not linked (or unlinked) is not Compass's and is
-- skipped; one whose mode differs from its customer's is refused.
create function billing_owner(p_customer text, p_livemode boolean, out client_id uuid, out outcome text)
language plpgsql stable set search_path = public as $$
declare c record;
begin
  select sc.client_id, sc.livemode, sc.unlinked_at into c from stripe_customers sc where sc.stripe_customer_id = p_customer;
  if not found or c.unlinked_at is not null then
    outcome := 'unlinked';
  elsif c.livemode is distinct from p_livemode then
    outcome := 'mode_mismatch';
  else
    client_id := c.client_id;
    outcome := 'ok';
  end if;
end $$;

revoke all on function billing_upsert(text, text[], jsonb) from public, anon, authenticated, service_role;
revoke all on function billing_update(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function billing_owner(text, boolean) from public, anon, authenticated, service_role;

-- ── 5. billing_sync_apply: one batch of Stripe objects, one transaction ─────
-- p = {"ops": [...]}, applied in order; ops the sync layer emits:
--   {"op": "product" | "price", "row": {...}}
--   {"op": "customer", "row": {...}}                    update-only (linked customers)
--   {"op": "subscription", "row": {...}, "items": [...]}  the item set is replaced
--   {"op": "invoice", "row": {...}, "lines": [...]}       the line set is replaced
--   {"op": "payment", "row": {...}}                     a PaymentIntent + its charge
--   {"op": "refund", "row": {...}}                      one refund of a mirrored payment
--   {"op": "checkout_session", "row": {...}}            update-only (Compass created it)
--   {"op": "deleted", "object": "product" | "price" | "customer", "id": "...", "at": ts}
--   {"op": "delete_invoice", "id": "in_..."}             invoice.deleted (drafts only)
-- Returns [{op, id, result}] with result written | stale | unlinked |
-- mode_mismatch | missing | missing_payment | kept_not_draft | deleted.
create function billing_sync_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  r jsonb;
  own record;
  v_id uuid;
  v_result text;
  v_ids text[];
  item jsonb;
  pay record;
  results jsonb := '[]';
begin
  if not billing_caller_is_service() then
    raise exception 'billing_sync_apply is for the Stripe sync functions only' using errcode = '42501';
  end if;
  perform set_config('compass.billing_sync', 'on', true);

  for o in select * from jsonb_array_elements(coalesce(p -> 'ops', '[]')) loop
    r := o -> 'row';
    v_result := null;
    case o ->> 'op'
    when 'product' then
      v_result := case when billing_upsert('stripe_products', array['stripe_product_id'], r) is null
                       then 'stale' else 'written' end;
    when 'price' then
      v_result := case when billing_upsert('stripe_prices', array['stripe_price_id'], r) is null
                       then 'stale' else 'written' end;
    when 'customer' then
      v_result := billing_update('stripe_customers', 'stripe_customer_id', r);
      if v_result = 'missing' then v_result := 'unlinked'; end if;
    when 'subscription' then
      select * into own from billing_owner(r ->> 'stripe_customer_id', (r ->> 'livemode')::boolean);
      v_result := own.outcome;
      if own.outcome = 'ok' then
        v_id := (billing_upsert('subscriptions', array['stripe_subscription_id'],
                               r || jsonb_build_object('client_id', own.client_id)) ->> 'id')::uuid;
        v_result := case when v_id is null then 'stale' else 'written' end;
        if v_id is not null then
          select coalesce(array_agg(i ->> 'stripe_subscription_item_id'), '{}') into v_ids
          from jsonb_array_elements(coalesce(o -> 'items', '[]')) i;
          delete from subscription_items where subscription_id = v_id and stripe_subscription_item_id <> all (v_ids);
          for item in select * from jsonb_array_elements(coalesce(o -> 'items', '[]')) loop
            perform billing_upsert('subscription_items', array['stripe_subscription_item_id'],
              item || jsonb_build_object('subscription_id', v_id, 'client_id', own.client_id));
          end loop;
        end if;
      end if;
    when 'invoice' then
      select * into own from billing_owner(r ->> 'stripe_customer_id', (r ->> 'livemode')::boolean);
      v_result := own.outcome;
      if own.outcome = 'ok' then
        v_id := (billing_upsert('invoices', array['stripe_invoice_id'], r || jsonb_build_object('client_id', own.client_id)) ->> 'id')::uuid;
        v_result := case when v_id is null then 'stale' else 'written' end;
        if v_id is not null then
          select coalesce(array_agg(i ->> 'stripe_line_item_id'), '{}') into v_ids
          from jsonb_array_elements(coalesce(o -> 'lines', '[]')) i;
          delete from invoice_line_items where invoice_id = v_id and stripe_line_item_id <> all (v_ids);
          for item in select * from jsonb_array_elements(coalesce(o -> 'lines', '[]')) loop
            perform billing_upsert('invoice_line_items', array['invoice_id', 'stripe_line_item_id'],
              item || jsonb_build_object('invoice_id', v_id, 'client_id', own.client_id));
          end loop;
        end if;
      end if;
    when 'payment' then
      select * into own from billing_owner(r ->> 'stripe_customer_id', (r ->> 'livemode')::boolean);
      v_result := own.outcome;
      if own.outcome = 'ok' then
        v_id := (billing_upsert('payments', array['stripe_payment_intent_id'],
                               r || jsonb_build_object('client_id', own.client_id, 'source', 'stripe')) ->> 'id')::uuid;
        v_result := case when v_id is null then 'stale' else 'written' end;
      end if;
    when 'refund' then
      select pm.id, pm.client_id, pm.livemode into pay from payments pm
      where pm.source = 'stripe'
        and (pm.stripe_payment_intent_id = r ->> 'stripe_payment_intent_id'
             or (r ->> 'stripe_payment_intent_id' is null and pm.stripe_charge_id = r ->> 'stripe_charge_id'));
      if not found then
        v_result := 'missing_payment';
      elsif pay.livemode is distinct from (r ->> 'livemode')::boolean then
        v_result := 'mode_mismatch';
      else
        v_id := (billing_upsert('stripe_refunds', array['stripe_refund_id'],
                               r || jsonb_build_object('client_id', pay.client_id, 'payment_id', pay.id)) ->> 'id')::uuid;
        v_result := case when v_id is null then 'stale' else 'written' end;
      end if;
    when 'checkout_session' then
      v_result := billing_update('checkout_sessions', 'stripe_checkout_session_id', r);
      if v_result = 'written' and r ->> 'status' = 'complete' then
        update checkout_sessions set completed_at = coalesce(completed_at, now())
        where stripe_checkout_session_id = r ->> 'stripe_checkout_session_id';
      end if;
    when 'deleted' then
      case o ->> 'object'
      when 'product' then
        update stripe_products set deleted_at = coalesce(deleted_at, (o ->> 'at')::timestamptz), active = false
        where stripe_product_id = o ->> 'id';
      when 'price' then
        update stripe_prices set deleted_at = coalesce(deleted_at, (o ->> 'at')::timestamptz), active = false
        where stripe_price_id = o ->> 'id';
      when 'customer' then
        update stripe_customers set deleted_at = coalesce(deleted_at, (o ->> 'at')::timestamptz)
        where stripe_customer_id = o ->> 'id';
      else
        raise exception 'unknown deleted object %', o ->> 'object';
      end case;
      v_result := 'deleted';
    when 'delete_invoice' then
      delete from invoices where stripe_invoice_id = o ->> 'id' and status = 'draft';
      v_result := case when exists (select 1 from invoices where stripe_invoice_id = o ->> 'id')
                       then 'kept_not_draft' else 'deleted' end;
    else
      raise exception 'unknown billing sync op %', o ->> 'op';
    end case;
    results := results || jsonb_build_object('op', o ->> 'op',
      'id', coalesce(o ->> 'id', r ->> case o ->> 'op'
        when 'product' then 'stripe_product_id' when 'price' then 'stripe_price_id'
        when 'customer' then 'stripe_customer_id' when 'subscription' then 'stripe_subscription_id'
        when 'invoice' then 'stripe_invoice_id' when 'payment' then 'stripe_payment_intent_id'
        when 'refund' then 'stripe_refund_id' when 'checkout_session' then 'stripe_checkout_session_id' end),
      'result', v_result);
  end loop;

  perform set_config('compass.billing_sync', 'off', true);
  return results;
end $$;

-- ── 6. Linking a Stripe customer to a client ─────────────────────────────────
-- p = {client_id, link_source: created | linked_existing, linked_by (team
-- member id, or null), row: the customer as the sync layer maps it}. The
-- unique keys refuse a customer already on another client and a second
-- active link for the client in that mode (23505); an offboarded client is
-- refused. Subscriptions and invoices are imported by the sync layer after.
create function billing_link_customer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := (p ->> 'client_id')::uuid;
  v_row jsonb := p -> 'row';
  v_id uuid;
begin
  if not billing_caller_is_service() then
    raise exception 'billing_link_customer is for the Stripe sync functions only' using errcode = '42501';
  end if;
  if not exists (select 1 from clients where id = v_client and status <> 'offboarded') then
    raise exception 'client % does not exist or is offboarded', v_client using errcode = '23503';
  end if;
  perform set_config('compass.billing_sync', 'on', true);
  insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, linked_by, email, name,
      currency, default_payment_method_type, default_payment_method_brand, default_payment_method_last4,
      metadata, stripe_created_at, stripe_synced_at)
  select v_client, x.stripe_customer_id, x.livemode, p ->> 'link_source', (p ->> 'linked_by')::uuid, x.email, x.name,
         x.currency, x.default_payment_method_type, x.default_payment_method_brand, x.default_payment_method_last4,
         coalesce(x.metadata, '{}'), x.stripe_created_at, x.stripe_synced_at
  from jsonb_populate_record(null::stripe_customers, v_row) x
  returning id into v_id;
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('id', v_id, 'client_id', v_client, 'stripe_customer_id', v_row ->> 'stripe_customer_id');
end $$;

-- ── 7. The webhook ledger ────────────────────────────────────────────────────
-- Claim an event for processing (the lease is wall-clock time, not the
-- transaction's start). Returns {claimed: true, attempt} to the one
-- delivery that may work it, or {claimed: false, state: done | in_progress}.
create function billing_event_begin(p jsonb, p_lease_seconds int default 300) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt int;
  v_status text;
begin
  if not billing_caller_is_service() then
    raise exception 'billing_event_begin is for the Stripe sync functions only' using errcode = '42501';
  end if;
  perform set_config('compass.billing_sync', 'on', true);
  insert into stripe_events (id, type, livemode, api_version, event_created_at, object_type, object_id)
  values (p ->> 'id', p ->> 'type', (p ->> 'livemode')::boolean, p ->> 'api_version',
          (p ->> 'event_created_at')::timestamptz, p ->> 'object_type', p ->> 'object_id')
  on conflict (id) do nothing;
  update stripe_events
     set status = 'processing', attempts = attempts + 1, last_attempt_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   where id = p ->> 'id'
     and (status in ('received', 'failed') or (status = 'processing' and lease_expires_at < clock_timestamp()))
  returning attempts into v_attempt;
  perform set_config('compass.billing_sync', 'off', true);
  if v_attempt is not null then
    return jsonb_build_object('claimed', true, 'attempt', v_attempt);
  end if;
  select status into v_status from stripe_events where id = p ->> 'id';
  return jsonb_build_object('claimed', false,
    'state', case when v_status in ('processed', 'ignored') then 'done' else 'in_progress' end, 'status', v_status);
end $$;

-- Finish the attempt that holds the claim: processed, or ignored with the
-- reason. {ok: false} when the claim was lost (its lease expired and another
-- delivery took it); the work was idempotent either way.
create function billing_event_finish(p_id text, p_attempt int, p_status text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not billing_caller_is_service() then
    raise exception 'billing_event_finish is for the Stripe sync functions only' using errcode = '42501';
  end if;
  if p_status not in ('processed', 'ignored') then
    raise exception 'finish status must be processed or ignored' using errcode = '22023';
  end if;
  perform set_config('compass.billing_sync', 'on', true);
  update stripe_events
     set status = p_status, processed_at = now(), lease_expires_at = null, last_error = null,
         ignored_reason = case when p_status = 'ignored' then p_reason end
   where id = p_id and status = 'processing' and attempts = p_attempt;
  get diagnostics n = row_count;
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('ok', n = 1);
end $$;

-- Fail the attempt that holds the claim: the error is kept and the event is
-- open for Stripe's retry (or reconciliation's replay).
create function billing_event_fail(p_id text, p_attempt int, p_error text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not billing_caller_is_service() then
    raise exception 'billing_event_fail is for the Stripe sync functions only' using errcode = '42501';
  end if;
  perform set_config('compass.billing_sync', 'on', true);
  update stripe_events
     set status = 'failed', lease_expires_at = null, last_error = left(coalesce(nullif(p_error, ''), 'unknown error'), 2000)
   where id = p_id and status = 'processing' and attempts = p_attempt;
  get diagnostics n = row_count;
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('ok', n = 1);
end $$;

revoke all on function billing_sync_apply(jsonb) from public, anon, authenticated;
revoke all on function billing_link_customer(jsonb) from public, anon, authenticated;
revoke all on function billing_event_begin(jsonb, int) from public, anon, authenticated;
revoke all on function billing_event_finish(text, int, text, text) from public, anon, authenticated;
revoke all on function billing_event_fail(text, int, text) from public, anon, authenticated;
grant execute on function billing_sync_apply(jsonb) to service_role;
grant execute on function billing_link_customer(jsonb) to service_role;
grant execute on function billing_event_begin(jsonb, int) to service_role;
grant execute on function billing_event_finish(text, int, text, text) to service_role;
grant execute on function billing_event_fail(text, int, text) to service_role;

-- ── 8. Verify ────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events'] loop
    if has_table_privilege('service_role', 'public.' || t, 'insert,update,delete,truncate') then
      raise exception '0058: service_role can write % directly', t;
    end if;
    if (select count(*) from pg_trigger where tgrelid = ('public.' || t)::regclass
        and tgfoid = 'billing_mirror_guard'::regproc and not tgisinternal) <> 2 then
      raise exception '0058: % is missing its sync guard', t;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'billing\_%' and p.prosecdef
               and (has_function_privilege('authenticated', p.oid, 'execute')
                    or has_function_privilege('anon', p.oid, 'execute'))) then
    raise exception '0058: a billing security-definer function is callable by a signed-in user or anon';
  end if;
end $$;
