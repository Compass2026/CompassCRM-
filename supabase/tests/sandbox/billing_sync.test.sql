-- Tests for migration 0059 (billing B2: the Stripe sync write boundary and the
-- webhook ledger), run by scripts/test-portal-sandbox.sh after the 0058 suite.
-- Own harness schema (bs), fictional clients and Stripe ids.
--
-- Callers, as they reach production:
--   worker    psql as postgres (Supabase MCP: table owner, BYPASSRLS, may SET ROLE)
--   service   psql as authenticator, role service_role (the Stripe Edge Functions —
--             and, since the key is project-wide, every other Edge Function)
--   person    psql as authenticator, role authenticated, team JWT
--   portal    psql as authenticator, role authenticated, portal JWT
--   anon      psql as authenticator, role anon

\set team '00000000-0000-4000-a000-000000000001'
\set pa   '00000000-0000-4000-a000-000000000011'

\o /dev/null
create schema bs;
create table bs.results (n serial, status text, name text, detail text);
grant usage on schema bs to anon, authenticated, service_role, authenticator;
grant insert, select on bs.results to anon, authenticated, service_role, authenticator;
grant usage on sequence bs.results_n_seq to anon, authenticated, service_role, authenticator;
create function bs.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into bs.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function bs.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function bs.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function bs.id(p_k text) returns uuid language sql immutable as $$ select md5('bs:' || p_k)::uuid $$;
-- Result of one op in an apply batch.
create function bs.res(p_results jsonb, p_n int) returns text language sql immutable as $$
  select p_results -> p_n ->> 'result'
$$;
-- Stripe-shaped rows, as the sync layer maps them.
create function bs.sub(p_sub text, p_cus text, p_status text, p_at timestamptz, p_live boolean default false) returns jsonb
language sql immutable as $$
  select jsonb_build_object('stripe_subscription_id', p_sub, 'stripe_customer_id', p_cus, 'livemode', p_live,
    'status', p_status, 'collection_method', 'charge_automatically', 'currency', 'usd',
    'current_period_start', '2026-09-01T00:00:00Z', 'current_period_end', '2026-10-01T00:00:00Z',
    'stripe_created_at', '2026-09-01T00:00:00Z', 'stripe_synced_at', p_at)
$$;
create function bs.item(p_si text, p_price text, p_q int, p_at timestamptz) returns jsonb language sql immutable as $$
  select jsonb_build_object('stripe_subscription_item_id', p_si, 'stripe_price_id', p_price, 'quantity', p_q, 'stripe_synced_at', p_at)
$$;
grant execute on all functions in schema bs to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (bs.id('c1'), 'Sync Roofing', 'Wentzville', 'MO', 'active'),
  (bs.id('c2'), 'Sync Plumbing', 'Columbia', 'MO', 'active'),
  (bs.id('off'), 'Former Sync Client', 'Rolla', 'MO', 'offboarded');

-- ── G. The worker's SQL cannot write the mirror, whatever it tries ──────────
do $$
declare e text;
begin
  e := bs.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at)
      values ('prod_Worker', false, 'x', true, now())$q$);
  perform bs.ok('G1 the worker (postgres, table owner) cannot insert into the mirror', e like '42501%', e);
  perform set_config('compass.billing_sync', 'on', false);
  e := bs.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at)
      values ('prod_Worker', false, 'x', true, now())$q$);
  perform bs.ok('G2 ...not with the sync flag set by hand', e like '42501%', e);
  perform set_config('compass.billing_sync', '', false);
  e := bs.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform bs.ok('G3 ...and cannot call billing_sync_apply', e like '42501%', e);
  e := bs.try($q$select billing_event_begin('{"id": "evt_W", "type": "x", "livemode": false, "event_created_at": "2026-09-29T00:00:00Z"}')$q$);
  perform bs.ok('G4 ...nor claim a webhook event', e like '42501%', e);
  e := bs.try($q$truncate stripe_events$q$);
  perform bs.ok('G5 ...nor truncate the ledger', e like '42501%', e);
end $$;
set role service_role;
do $$
declare e text;
begin
  e := bs.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at)
      values ('prod_Worker', false, 'x', true, now())$q$);
  perform bs.ok('G7 the worker after SET ROLE service_role still cannot write the mirror', e like '42501%', e);
  e := bs.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform bs.ok('G8 ...nor call billing_sync_apply (its session is still postgres)', e like '42501%', e);
end $$;
reset role;

-- ── L / S. The Stripe functions' session ────────────────────────────────────
\c - authenticator
set role service_role;
select bs.as_user('service_role', null);
do $$
declare e text; r jsonb;
begin
  e := bs.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at)
      values ('prod_Direct', false, 'x', true, now())$q$);
  perform bs.ok('G9 the service role cannot write a mirror table directly (only through the sync functions)', e like '42501%', e);

  -- Link customers (as B3's "link existing customer" and Compass-created customers will).
  r := billing_link_customer(jsonb_build_object('client_id', bs.id('c1'), 'link_source', 'linked_existing',
    'row', jsonb_build_object('stripe_customer_id', 'cus_S1', 'livemode', false, 'email', 'owner@sync-roofing.test',
      'stripe_synced_at', '2026-09-29T10:00:00Z')));
  perform bs.ok('L1 the sync session links an existing Stripe customer to a client', r ->> 'stripe_customer_id' = 'cus_S1', r::text);
  perform billing_link_customer(jsonb_build_object('client_id', bs.id('c2'), 'link_source', 'created',
    'row', jsonb_build_object('stripe_customer_id', 'cus_S2', 'livemode', false, 'stripe_synced_at', '2026-09-29T10:00:00Z')));
  perform billing_link_customer(jsonb_build_object('client_id', bs.id('c1'), 'link_source', 'created',
    'row', jsonb_build_object('stripe_customer_id', 'cus_S1live', 'livemode', true, 'stripe_synced_at', '2026-09-29T10:00:00Z')));
  e := bs.try(format($q$select billing_link_customer(%L)$q$, jsonb_build_object('client_id', bs.id('c2'), 'link_source', 'linked_existing',
    'row', jsonb_build_object('stripe_customer_id', 'cus_S1', 'livemode', false, 'stripe_synced_at', now()))));
  perform bs.ok('L2 a customer already on one client cannot be linked to another', e like '23505%', e);
  e := bs.try(format($q$select billing_link_customer(%L)$q$, jsonb_build_object('client_id', bs.id('c1'), 'link_source', 'created',
    'row', jsonb_build_object('stripe_customer_id', 'cus_S1dup', 'livemode', false, 'stripe_synced_at', now()))));
  perform bs.ok('L3 a client cannot get a second test-mode customer (no duplicate creation)', e like '23505%', e);
  e := bs.try(format($q$select billing_link_customer(%L)$q$, jsonb_build_object('client_id', bs.id('off'), 'link_source', 'created',
    'row', jsonb_build_object('stripe_customer_id', 'cus_Off', 'livemode', false, 'stripe_synced_at', now()))));
  perform bs.ok('L4 an offboarded client cannot be linked', e like '23503%', e);

  -- Catalog.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(
    jsonb_build_object('op', 'product', 'row', jsonb_build_object('stripe_product_id', 'prod_S', 'livemode', false,
      'name', 'Compass Marketing Package', 'active', true, 'stripe_synced_at', '2026-09-29T10:00:00Z')),
    jsonb_build_object('op', 'price', 'row', jsonb_build_object('stripe_price_id', 'price_SM', 'stripe_product_id', 'prod_S',
      'livemode', false, 'active', true, 'type', 'recurring', 'currency', 'usd', 'unit_amount_cents', 150000,
      'recurring_interval', 'month', 'recurring_interval_count', 1, 'stripe_synced_at', '2026-09-29T10:00:00Z')),
    jsonb_build_object('op', 'price', 'row', jsonb_build_object('stripe_price_id', 'price_SY', 'stripe_product_id', 'prod_S',
      'livemode', false, 'active', true, 'type', 'recurring', 'currency', 'usd', 'unit_amount_cents', 1500000,
      'recurring_interval', 'year', 'recurring_interval_count', 1, 'stripe_synced_at', '2026-09-29T10:00:00Z')))));
  perform bs.ok('S1 products and prices are written', bs.res(r, 0) = 'written' and bs.res(r, 2) = 'written', r::text);

  -- A subscription with two items.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_S1', 'cus_S1', 'active', '2026-09-29T10:00:00Z'),
    'items', jsonb_build_array(bs.item('si_A', 'price_SM', 1, '2026-09-29T10:00:00Z'), bs.item('si_B', 'price_SY', 1, '2026-09-29T10:00:00Z'))))));
  perform bs.ok('S2 a subscription for a linked customer is written with its items, on the customer''s client',
    bs.res(r, 0) = 'written'
    and (select client_id from subscriptions where stripe_subscription_id = 'sub_S1') = bs.id('c1')
    and (select count(*) from subscription_items si join subscriptions s on s.id = si.subscription_id
         where s.stripe_subscription_id = 'sub_S1' and si.client_id = bs.id('c1')) = 2, r::text);

  -- Newer read: past_due, one item removed.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_S1', 'cus_S1', 'past_due', '2026-09-29T11:00:00Z'),
    'items', jsonb_build_array(bs.item('si_A', 'price_SM', 2, '2026-09-29T11:00:00Z'))))));
  perform bs.ok('S3 a newer read updates the status and replaces the item set (removed item deleted, quantity changed)',
    (select status from subscriptions where stripe_subscription_id = 'sub_S1') = 'past_due'
    and (select array_agg(stripe_subscription_item_id || ':' || quantity) from subscription_items si
         join subscriptions s on s.id = si.subscription_id where s.stripe_subscription_id = 'sub_S1') = array['si_A:2'], r::text);

  -- An older read arriving late never wins.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_S1', 'cus_S1', 'active', '2026-09-29T10:30:00Z'),
    'items', jsonb_build_array(bs.item('si_A', 'price_SM', 1, '2026-09-29T10:30:00Z'), bs.item('si_B', 'price_SY', 1, '2026-09-29T10:30:00Z'))))));
  perform bs.ok('S4 an older read is stale: status, items and quantities are left as the newer read wrote them',
    bs.res(r, 0) = 'stale' and (select status from subscriptions where stripe_subscription_id = 'sub_S1') = 'past_due'
    and (select count(*) from subscription_items si join subscriptions s on s.id = si.subscription_id
         where s.stripe_subscription_id = 'sub_S1') = 1, r::text);

  -- A caller cannot aim a row at another client.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_S1b', 'cus_S1', 'active', '2026-09-29T11:00:00Z') || jsonb_build_object('client_id', bs.id('c2')),
    'items', '[]'::jsonb))));
  perform bs.ok('S5 a row that names another client lands on its customer''s client anyway',
    (select client_id from subscriptions where stripe_subscription_id = 'sub_S1b') = bs.id('c1'), r::text);

  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_Stranger', 'cus_Stranger', 'active', '2026-09-29T11:00:00Z'), 'items', '[]'::jsonb))));
  perform bs.ok('S6 a subscription of a customer Compass has not linked is skipped (unlinked), nothing written',
    bs.res(r, 0) = 'unlinked' and not exists (select 1 from subscriptions where stripe_subscription_id = 'sub_Stranger'), r::text);

  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'subscription',
    'row', bs.sub('sub_Live', 'cus_S1', 'active', '2026-09-29T11:00:00Z', true), 'items', '[]'::jsonb))));
  perform bs.ok('S7 a live-mode object on a test-mode customer is refused (mode_mismatch)',
    bs.res(r, 0) = 'mode_mismatch' and not exists (select 1 from subscriptions where stripe_subscription_id = 'sub_Live'), r::text);

  -- Invoices and lines.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'invoice',
    'row', jsonb_build_object('stripe_invoice_id', 'in_S1', 'stripe_customer_id', 'cus_S1', 'stripe_subscription_id', 'sub_S1',
      'livemode', false, 'status', 'open', 'collection_method', 'charge_automatically', 'currency', 'usd',
      'subtotal_cents', 300000, 'total_cents', 300000, 'amount_due_cents', 300000, 'amount_paid_cents', 0,
      'amount_remaining_cents', 300000, 'attempt_count', 1, 'stripe_created_at', '2026-09-01T00:00:00Z',
      'stripe_synced_at', '2026-09-29T11:00:00Z'),
    'lines', jsonb_build_array(
      jsonb_build_object('stripe_line_item_id', 'il_1', 'stripe_price_id', 'price_SM', 'amount_cents', 300000, 'currency', 'usd', 'quantity', 2, 'stripe_synced_at', '2026-09-29T11:00:00Z'),
      jsonb_build_object('stripe_line_item_id', 'il_2', 'amount_cents', -5000, 'currency', 'usd', 'proration', true, 'stripe_synced_at', '2026-09-29T11:00:00Z'))))));
  perform bs.ok('S8 an invoice is written with its lines (a negative proration line included)',
    bs.res(r, 0) = 'written' and (select count(*) from invoice_line_items l join invoices i on i.id = l.invoice_id
      where i.stripe_invoice_id = 'in_S1') = 2, r::text);
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'invoice',
    'row', jsonb_build_object('stripe_invoice_id', 'in_S1', 'stripe_customer_id', 'cus_S1', 'stripe_subscription_id', 'sub_S1',
      'livemode', false, 'status', 'paid', 'collection_method', 'charge_automatically', 'currency', 'usd',
      'subtotal_cents', 300000, 'total_cents', 300000, 'amount_due_cents', 300000, 'amount_paid_cents', 300000,
      'amount_remaining_cents', 0, 'attempt_count', 2, 'paid_at', '2026-09-29T11:30:00Z', 'stripe_created_at', '2026-09-01T00:00:00Z',
      'stripe_synced_at', '2026-09-29T11:30:00Z'),
    'lines', jsonb_build_array(
      jsonb_build_object('stripe_line_item_id', 'il_1', 'stripe_price_id', 'price_SM', 'amount_cents', 300000, 'currency', 'usd', 'quantity', 2, 'stripe_synced_at', '2026-09-29T11:30:00Z'))))));
  perform bs.ok('S9 invoice.paid: status paid, remaining 0, the dropped line removed',
    (select status || ':' || amount_remaining_cents from invoices where stripe_invoice_id = 'in_S1') = 'paid:0'
    and (select count(*) from invoice_line_items l join invoices i on i.id = l.invoice_id where i.stripe_invoice_id = 'in_S1') = 1, r::text);
  r := billing_sync_apply('{"ops": [{"op": "delete_invoice", "id": "in_S1"}]}');
  perform bs.ok('S10 invoice.deleted never removes a finalized invoice', bs.res(r, 0) = 'kept_not_draft', r::text);

  -- Payments and refunds: one payment, two partial refunds, then a status change.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(
    jsonb_build_object('op', 'payment', 'row', jsonb_build_object('stripe_payment_intent_id', 'pi_S1', 'stripe_charge_id', 'py_S1',
      'stripe_customer_id', 'cus_S1', 'stripe_invoice_id', 'in_S1', 'livemode', false, 'status', 'succeeded',
      'payment_method_type', 'us_bank_account', 'amount_cents', 300000, 'amount_refunded_cents', 150000, 'currency', 'usd',
      'paid_at', '2026-09-29T11:30:00Z', 'stripe_synced_at', '2026-09-29T12:00:00Z')),
    jsonb_build_object('op', 'refund', 'row', jsonb_build_object('stripe_refund_id', 'pyr_1', 'stripe_payment_intent_id', 'pi_S1',
      'stripe_charge_id', 'py_S1', 'livemode', false, 'amount_cents', 100000, 'currency', 'usd', 'status', 'succeeded',
      'reason', 'requested_by_customer', 'stripe_created_at', '2026-09-29T11:40:00Z', 'stripe_synced_at', '2026-09-29T12:00:00Z')),
    jsonb_build_object('op', 'refund', 'row', jsonb_build_object('stripe_refund_id', 'pyr_2', 'stripe_payment_intent_id', 'pi_S1',
      'stripe_charge_id', 'py_S1', 'livemode', false, 'amount_cents', 50000, 'currency', 'usd', 'status', 'pending',
      'stripe_created_at', '2026-09-29T11:50:00Z', 'stripe_synced_at', '2026-09-29T12:00:00Z')))));
  perform bs.ok('S11 a payment and two partial refunds land in one batch, each refund its own row on the payment''s client',
    (select count(*) from stripe_refunds r join payments p on p.id = r.payment_id
      where p.stripe_payment_intent_id = 'pi_S1' and r.client_id = bs.id('c1')) = 2
    and (select amount_refunded_cents from payments where stripe_payment_intent_id = 'pi_S1') = 150000, r::text);
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(
    jsonb_build_object('op', 'refund', 'row', jsonb_build_object('stripe_refund_id', 'pyr_2', 'stripe_payment_intent_id', 'pi_S1',
      'livemode', false, 'amount_cents', 50000, 'currency', 'usd', 'status', 'failed', 'failure_reason', 'charge_for_pending_refund_disputed',
      'stripe_created_at', '2026-09-29T11:50:00Z', 'stripe_synced_at', '2026-09-29T13:00:00Z')))));
  perform bs.ok('S12 a refund''s later state (failed, with its reason) replaces the earlier one',
    (select status || ':' || failure_reason from stripe_refunds where stripe_refund_id = 'pyr_2') = 'failed:charge_for_pending_refund_disputed', r::text);
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(
    jsonb_build_object('op', 'refund', 'row', jsonb_build_object('stripe_refund_id', 're_X', 'stripe_payment_intent_id', 'pi_Unknown',
      'livemode', false, 'amount_cents', 1, 'currency', 'usd', 'status', 'succeeded',
      'stripe_created_at', '2026-09-29T11:50:00Z', 'stripe_synced_at', '2026-09-29T13:00:00Z')))));
  perform bs.ok('S13 a refund of a payment Compass does not mirror is skipped', bs.res(r, 0) = 'missing_payment', r::text);

  -- Customers: update-only; deleted markers.
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(
    jsonb_build_object('op', 'customer', 'row', jsonb_build_object('stripe_customer_id', 'cus_S1', 'email', 'billing@sync-roofing.test',
      'default_payment_method_type', 'us_bank_account', 'default_payment_method_last4', '6789', 'stripe_synced_at', '2026-09-29T12:00:00Z')),
    jsonb_build_object('op', 'customer', 'row', jsonb_build_object('stripe_customer_id', 'cus_Unknown', 'email', 'x@y.test',
      'stripe_synced_at', '2026-09-29T12:00:00Z')))));
  perform bs.ok('S14 customer.updated updates a linked customer and never creates one',
    bs.res(r, 0) = 'written' and bs.res(r, 1) = 'unlinked'
    and (select email || ':' || default_payment_method_last4 from stripe_customers where stripe_customer_id = 'cus_S1')
        = 'billing@sync-roofing.test:6789'
    and not exists (select 1 from stripe_customers where stripe_customer_id = 'cus_Unknown'), r::text);
  r := billing_sync_apply('{"ops": [{"op": "deleted", "object": "price", "id": "price_SY", "at": "2026-09-29T13:00:00Z"}]}');
  perform bs.ok('S15 price.deleted marks the mirrored price deleted and inactive (history kept)',
    (select deleted_at is not null and not active from stripe_prices where stripe_price_id = 'price_SY'), r::text);
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'checkout_session',
    'row', jsonb_build_object('stripe_checkout_session_id', 'cs_test_Nope', 'status', 'complete', 'stripe_synced_at', now())))));
  perform bs.ok('S16 a Checkout session Compass did not create is not mirrored', bs.res(r, 0) = 'missing', r::text);
  e := bs.try($q$select billing_sync_apply('{"ops": [{"op": "wipe"}]}')$q$);
  perform bs.ok('S17 an unknown op fails the whole batch', e is not null, e);

  -- The ledger.
  r := billing_event_begin('{"id": "evt_L1", "type": "invoice.paid", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z", "object_type": "invoice", "object_id": "in_S1"}');
  perform bs.ok('E1 the first delivery claims the event (attempt 1)', r = '{"claimed": true, "attempt": 1}', r::text);
  r := billing_event_begin('{"id": "evt_L1", "type": "invoice.paid", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z"}');
  perform bs.ok('E2 a concurrent duplicate is told it is in progress', r ->> 'state' = 'in_progress' and not (r ->> 'claimed')::boolean, r::text);
  r := billing_event_finish('evt_L1', 2, 'processed');
  perform bs.ok('E3 only the attempt holding the claim can finish it', not (r ->> 'ok')::boolean, r::text);
  r := billing_event_fail('evt_L1', 1, 'Stripe API timeout');
  perform bs.ok('E4 a failed attempt is recorded with its error and not processed',
    (r ->> 'ok')::boolean and (select status || ':' || last_error from stripe_events where id = 'evt_L1') = 'failed:Stripe API timeout', r::text);
  r := billing_event_begin('{"id": "evt_L1", "type": "invoice.paid", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z"}');
  perform bs.ok('E5 Stripe''s retry claims it again (attempt 2)', r = '{"claimed": true, "attempt": 2}', r::text);
  r := billing_event_finish('evt_L1', 2, 'processed');
  perform bs.ok('E6 ...and finishes it: processed, error cleared',
    (r ->> 'ok')::boolean and (select status = 'processed' and processed_at is not null and last_error is null and lease_expires_at is null
      from stripe_events where id = 'evt_L1'), r::text);
  r := billing_event_begin('{"id": "evt_L1", "type": "invoice.paid", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z"}');
  perform bs.ok('E7 a redelivery of a processed event is a duplicate (done)', r ->> 'state' = 'done', r::text);
  r := billing_event_begin('{"id": "evt_L2", "type": "customer.subscription.updated", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z"}', 0);
  r := billing_event_begin('{"id": "evt_L2", "type": "customer.subscription.updated", "livemode": false, "event_created_at": "2026-09-29T11:30:00Z"}');
  perform bs.ok('E8 an expired lease (a crashed worker) is taken over by the next delivery', r = '{"claimed": true, "attempt": 2}', r::text);
  perform bs.ok('E9 ...and the crashed attempt can no longer finish', not (billing_event_finish('evt_L2', 1, 'processed') ->> 'ok')::boolean);
  r := billing_event_finish('evt_L2', 2, 'ignored', 'customer_not_linked');
  perform bs.ok('E10 an event can be finished as ignored with its reason',
    (select status || ':' || ignored_reason from stripe_events where id = 'evt_L2') = 'ignored:customer_not_linked', r::text);
  e := bs.try($q$select billing_event_finish('evt_L2', 2, 'done')$q$);
  perform bs.ok('E11 finish accepts only processed or ignored', e like '22023%', e);
end $$;
reset role;

-- ── P. A teammate, a portal contact and anon cannot reach the sync functions ─
set role authenticated;
select bs.as_user('authenticated', :'team');
do $$
declare e text;
begin
  perform bs.ok('P1 a teammate reads what the sync wrote', (select count(*) from subscriptions where client_id = bs.id('c1')) = 2
    and (select count(*) from stripe_refunds where client_id = bs.id('c1')) = 2);
  e := bs.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform bs.ok('P2 a teammate cannot call billing_sync_apply', e like '42501%', e);
  e := bs.try(format($q$select billing_link_customer(%L)$q$, jsonb_build_object('client_id', bs.id('c2'), 'link_source', 'linked_existing',
    'row', jsonb_build_object('stripe_customer_id', 'cus_Team', 'livemode', false, 'stripe_synced_at', now()))));
  perform bs.ok('P3 a teammate cannot link a customer directly (B3''s action goes through the function)', e like '42501%', e);
  e := bs.try($q$select billing_event_begin('{"id": "evt_T", "type": "x", "livemode": false, "event_created_at": "2026-09-29T00:00:00Z"}')$q$);
  perform bs.ok('P4 a teammate cannot touch the ledger', e like '42501%', e);
  e := bs.try($q$update stripe_refunds set status = 'succeeded'$q$);
  perform bs.ok('P5 a teammate cannot edit a refund', e like '42501%', e);
end $$;
reset role;
set role authenticated;
select bs.as_user('authenticated', :'pa');
do $$
declare e text;
begin
  e := bs.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform bs.ok('P6 a portal contact cannot call billing_sync_apply', e like '42501%', e);
  perform bs.ok('P7 ...and reads no refunds or events', (select count(*) from stripe_refunds) + (select count(*) from stripe_events) = 0);
end $$;
reset role;
set role anon;
select bs.as_user('anon', null);
do $$
declare e text;
begin
  e := bs.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform bs.ok('P8 anon cannot call billing_sync_apply', e like '42501%', e);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── W. Back as the worker: rows the sync wrote are still out of its reach ────
\c - postgres
do $$
declare e text;
begin
  e := bs.try($q$update subscriptions set status = 'active' where stripe_subscription_id = 'sub_S1'$q$);
  perform bs.ok('W1 the worker cannot rewrite a synced subscription', e like '42501%', e);
  e := bs.try($q$delete from stripe_refunds where stripe_refund_id = 'pyr_1'$q$);
  perform bs.ok('W2 ...or delete a refund', e like '42501%', e);
  e := bs.try($q$update stripe_events set status = 'processed', processed_at = now() where id = 'evt_L2'$q$);
  perform bs.ok('W3 ...or mark a ledger event processed', e like '42501%', e);
  e := bs.try($q$delete from stripe_customers where stripe_customer_id = 'cus_S2'$q$);
  perform bs.ok('W4 ...or remove a customer link', e like '42501%', e);
  perform bs.ok('W5 the synced state is intact', (select status from subscriptions where stripe_subscription_id = 'sub_S1') = 'past_due'
    and (select count(*) from stripe_refunds where client_id = bs.id('c1')) = 2);
end $$;

\o
\pset footer off
select status, count(*) from bs.results group by status order by status;
select n, status, name, detail from bs.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from bs.results where status = 'fail';
  if f > 0 then raise exception '% billing sync check(s) failed', f; end if;
end $$;
