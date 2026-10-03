-- Tests for migration 0061 (billing B4 reconciliation history, fingerprints and
-- the health read models), run by scripts/test-portal-sandbox.sh after the 0060
-- suite. Own harness schema (br).
--
-- Callers: worker (postgres), service (authenticator + service_role: the
-- stripe-reconcile function), person (authenticated + JWT), portal, anon,
-- fixtures (supabase_admin).

\set team '00000000-0000-4000-a000-000000000001'
\set pa   '00000000-0000-4000-a000-000000000011'

\o /dev/null
create schema br;
create table br.results (n serial, status text, name text, detail text);
create table br.saved (k text primary key, v text);
grant usage on schema br to anon, authenticated, service_role, authenticator;
grant insert, select on br.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on br.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence br.results_n_seq to anon, authenticated, service_role, authenticator;
create function br.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into br.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function br.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function br.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function br.id(p_k text) returns uuid language sql immutable as $$ select md5('br:' || p_k)::uuid $$;
grant execute on all functions in schema br to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (br.id('c1'), 'Recon Roofing', 'Wentzville', 'MO', 'active'),
  (br.id('c2'), 'Recon Plumbing', 'Columbia', 'MO', 'active');
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000f3', 'recon-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000f3', 'Recon Member', 'recon-member@compassmarketing.ai', 'member');
update team_members set role = 'admin' where auth_user_id = :'team';
insert into br.saved values
  ('admin', (select id::text from team_members where auth_user_id = :'team')),
  ('member', (select id::text from team_members where auth_user_id = '00000000-0000-4000-a000-0000000000f3'));

-- Fixtures: a linked customer per client with a subscription, an invoice with
-- a line, a Stripe payment and a refund; an external payment; a mapped product.
\c - supabase_admin
insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values
  ('prod_Br1', false, 'Recon Package', true, now()),
  ('prod_BrLive', true, 'Recon Package live', true, now()),
  ('prod_BrLoose', false, 'Not in the catalog', true, now());
insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency, unit_amount_cents,
  recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at) values
  ('price_Br1', 'prod_Br1', false, true, 'recurring', 'usd', 100000, 'month', 1, 'licensed', now()),
  ('price_BrLoose', 'prod_BrLoose', false, true, 'recurring', 'usd', 100, 'month', 1, 'licensed', now());
insert into billing_packages (id, key, name, kind, stripe_product_id) values (br.id('pkg'), 'recon_pkg', 'Recon Package', 'standard', 'prod_Br1');
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values
  (br.id('c1'), 'cus_Br1', false, 'created', now()),
  (br.id('c2'), 'cus_Br2', false, 'created', now()),
  (br.id('c1'), 'cus_Br1Live', true, 'created', now());
insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status, collection_method, currency,
  stripe_created_at, stripe_synced_at) values
  (br.id('c1'), 'cus_Br1', 'sub_Br1', false, 'active', 'charge_automatically', 'usd', now(), now());
insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_Br1', 'price_Br1', 1, now() from subscriptions where stripe_subscription_id = 'sub_Br1';
insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, status, collection_method, currency,
  subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, stripe_created_at, stripe_synced_at)
  values (br.id('c1'), 'cus_Br1', 'in_Br1', false, 'paid', 'charge_automatically', 'usd', 100000, 100000, 100000, 100000, 0, now(), now());
insert into invoice_line_items (invoice_id, client_id, stripe_line_item_id, amount_cents, currency, stripe_synced_at)
  select id, client_id, 'il_Br1', 100000, 'usd', now() from invoices where stripe_invoice_id = 'in_Br1';
insert into payments (client_id, source, stripe_customer_id, stripe_payment_intent_id, livemode, status, amount_cents, currency, paid_at, stripe_synced_at)
  values (br.id('c1'), 'stripe', 'cus_Br1', 'pi_Br1', false, 'succeeded', 100000, 'usd', now(), now());
insert into payments (client_id, source, status, external_method, notes, amount_cents, currency, paid_at)
  values (br.id('c1'), 'external', 'succeeded', 'check', 'Check 1', 5000, 'usd', now());
insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id, livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
  select client_id, id, 're_Br1', 'pi_Br1', false, 1000, 'usd', 'succeeded', now(), now() from payments where stripe_payment_intent_id = 'pi_Br1';
insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id, status, attempts, last_error, last_attempt_at)
  values ('evt_BrFailed', 'invoice.paid', false, now(), 'invoice', 'in_Br1', 'failed', 1, 'db down', now());
insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id, status, attempts, last_attempt_at, lease_expires_at)
  values ('evt_BrStuck', 'invoice.paid', false, now(), 'invoice', 'in_Br1', 'processing', 1, now() - interval '20 minutes', now() - interval '15 minutes'),
         ('evt_BrLeased', 'invoice.paid', false, now(), 'invoice', 'in_Br1', 'processing', 1, now(), now() + interval '5 minutes');

-- ── W. The worker's SQL is refused ───────────────────────────────────────────
\c - postgres
do $$
declare e text;
begin
  e := br.try($q$select billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}')$q$);
  perform br.ok('W1 the worker cannot start a reconciliation run', e like '42501%', e);
  e := br.try($q$insert into billing_reconciliation_runs (livemode, trigger) values (false, 'schedule')$q$);
  perform br.ok('W2 the worker cannot write run history directly', e like '42501%', e);
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', br.id('x'))));
  perform br.ok('W3 the worker cannot record a client result', e like '42501%', e);
  e := br.try($q$set local role service_role; select billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}')$q$);
  perform br.ok('W4 ...not even after SET ROLE service_role', e like '42501%', e);
end $$;
reset role;
do $$
begin
  perform br.ok('W5 billing_fire_reconciliation does nothing without its secret', billing_fire_reconciliation() is null);
  perform br.ok('W6 the daily run is not scheduled by the migration',
    not exists (select 1 from cron.job where command like '%billing_fire_reconciliation%' or command like '%stripe-reconcile%'));
end $$;
select vault.create_secret('recon-secret-value', 'BILLING_RECONCILE_SECRET');
do $$
declare v bigint;
begin
  v := billing_fire_reconciliation();
  perform br.ok('W7 with its secret it posts to stripe-reconcile with the dedicated header',
    v is not null and exists (select 1 from net.http_request_queue where id = v
      and url like '%/functions/v1/stripe-reconcile' and headers ->> 'x-billing-reconcile-secret' = 'recon-secret-value'
      and body ->> 'trigger' = 'schedule'));
end $$;

-- ── P. A signed-in person, a portal contact and anon ─────────────────────────
\c - authenticator
set role authenticated;
select br.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := br.try($q$select billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}')$q$);
  perform br.ok('P1 an admin''s own session cannot start a run directly (only the function)', e like '42501%', e);
  e := br.try($q$select billing_mirror_fingerprint('00000000-0000-4000-b000-00000000000a', false)$q$);
  perform br.ok('P2 ...nor read a fingerprint', e like '42501%', e);
  e := br.try($q$insert into billing_reconciliation_runs (livemode, trigger) values (false, 'schedule')$q$);
  perform br.ok('P3 ...nor write run history', e like '42501%', e);
end $$;
reset role;
set role anon;
do $$
declare e text;
begin
  e := br.try($q$select count(*) from billing_reconciliation_runs$q$);
  perform br.ok('P4 anon cannot read run history', e like '42501%', e);
  e := br.try($q$select count(*) from billing_sync_health$q$);
  perform br.ok('P5 anon cannot read sync health', e like '42501%', e);
end $$;
reset role;

-- ── S. The stripe-reconcile function's session ───────────────────────────────
set role service_role;
do $$
declare
  r jsonb;
  e text;
  fp1 jsonb;
  fp2 jsonb;
begin
  -- Fingerprints.
  fp1 := billing_mirror_fingerprint(br.id('c1'), false);
  perform br.ok('F1 the fingerprint names every mirrored object of the client in the mode',
    fp1 -> 'customer' ? 'cus_Br1' and not (fp1 -> 'customer' ? 'cus_Br1Live') and fp1 -> 'subscription' ? 'sub_Br1'
    and fp1 -> 'invoice' ? 'in_Br1' and fp1 -> 'payment' ? 'pi_Br1' and fp1 -> 'refund' ? 're_Br1'
    and jsonb_typeof(fp1 -> 'checkout') = 'object', fp1::text);
  perform br.ok('F2 external payments are not in it (Stripe reconciliation never judges them)',
    (select count(*) from jsonb_object_keys(fp1 -> 'payment')) = 1);
  perform br.ok('F3 another client''s objects are not in it',
    billing_mirror_fingerprint(br.id('c2'), false) -> 'subscription' = '{}'::jsonb);
  r := billing_catalog_fingerprint(false);
  perform br.ok('F4 the catalog fingerprint has the mapped product and its prices only, in the mode',
    r -> 'product' ? 'prod_Br1' and not (r -> 'product' ? 'prod_BrLoose') and not (r -> 'product' ? 'prod_BrLive')
    and r -> 'price' ? 'price_Br1' and not (r -> 'price' ? 'price_BrLoose'), r::text);
  insert into br.saved values ('fp1', fp1::text);

  -- Begin.
  r := billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}');
  insert into br.saved values ('run1', r ->> 'id');
  perform br.ok('S1 the service session starts a scheduled run',
    exists (select 1 from billing_reconciliation_runs where id = (r ->> 'id')::uuid and status = 'running' and requested_by is null));
  e := br.try($q$select billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}')$q$);
  perform br.ok('S2 a second run in the same mode is refused while one runs', e like '55P03%', e);
  e := br.try(format($q$select billing_reconcile_begin(%L)$q$, jsonb_build_object('livemode', true, 'trigger', 'admin',
    'requested_by', (select v from br.saved where k = 'member'))));
  perform br.ok('S3 a member cannot be the requester of a manual run', e like '42501%', e);
  e := br.try(format($q$select billing_reconcile_begin(%L)$q$, jsonb_build_object('livemode', true, 'trigger', 'admin_client',
    'requested_by', (select v from br.saved where k = 'admin'), 'scope_client_id', br.id('nope'))));
  perform br.ok('S4 a client run names an existing client', e like '23503%', e);

  -- Client results.
  perform billing_reconcile_client(jsonb_build_object('run_id', (r ->> 'id'), 'client_id', br.id('c1'),
    'stripe_customer_id', 'cus_Br1', 'status', 'repaired', 'records_changed', 2,
    'changes', jsonb_build_object('invoice_imported', 1, 'subscription_updated', 1), 'objects_examined', 5,
    'attention_reasons', jsonb_build_array('package_mismatch'), 'warnings', jsonb_build_array()));
  perform br.ok('S5 a client result is recorded with its changes and attention',
    exists (select 1 from billing_reconciliation_results where run_id = (r ->> 'id')::uuid and client_id = br.id('c1')
      and records_changed = 2 and changes ->> 'invoice_imported' = '1' and attention_reasons = array['package_mismatch']));
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c2'),
    'stripe_customer_id', 'cus_Br1', 'status', 'healthy')));
  perform br.ok('S6 a result cannot pair a client with another client''s customer', e like '23503%', e);
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c1'),
    'stripe_customer_id', 'cus_Br1Live', 'status', 'healthy')));
  perform br.ok('S7 ...nor with a customer of the other mode', e like '23503%', e);
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c2'),
    'stripe_customer_id', 'cus_Br2', 'status', 'failed')));
  perform br.ok('S8 a failed result needs its error', e like '23514%', e);
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c2'),
    'stripe_customer_id', 'cus_Br2', 'status', 'repaired', 'records_changed', 0)));
  perform br.ok('S9 "repaired" means at least one record changed', e like '23514%', e);
  perform billing_reconcile_client(jsonb_build_object('run_id', (r ->> 'id'), 'client_id', br.id('c2'),
    'stripe_customer_id', 'cus_Br2', 'status', 'failed', 'error', 'Stripe 500'));
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c2'),
    'stripe_customer_id', 'cus_Br2', 'status', 'healthy')));
  perform br.ok('S10 one result per client per run', e like '23505%', e);
  e := br.try(format($q$update billing_reconciliation_results set status = 'healthy' where client_id = %L$q$, br.id('c2')));
  perform br.ok('S11 the service role cannot edit a result directly', e like '42501%', e);

  -- Finish.
  e := br.try(format($q$select billing_reconcile_finish(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'status', 'running')));
  perform br.ok('S12 a run finishes with a final status', e like '23514%', e);
  perform billing_reconcile_finish(jsonb_build_object('run_id', r ->> 'id', 'status', 'completed_with_errors',
    'customers_examined', 2, 'customers_repaired', 1, 'objects_examined', 9, 'records_changed', 2, 'warnings', 0,
    'failures', 1, 'events_recovered', 2, 'summary', jsonb_build_object('changed', jsonb_build_object('invoice_imported', 1))));
  perform br.ok('S13 the finished run keeps its counters and summary',
    exists (select 1 from billing_reconciliation_runs where id = (r ->> 'id')::uuid and status = 'completed_with_errors'
      and completed_at is not null and records_changed = 2 and failures = 1 and events_recovered = 2
      and summary -> 'changed' ->> 'invoice_imported' = '1'));
  e := br.try(format($q$select billing_reconcile_finish(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'status', 'completed')));
  perform br.ok('S14 a finished run cannot be finished again', e like '55000%', e);
  e := br.try(format($q$select billing_reconcile_client(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'client_id', br.id('c1'),
    'stripe_customer_id', 'cus_Br1', 'status', 'healthy')));
  perform br.ok('S15 nothing is added to a finished run', e like '55000%', e);
  e := br.try(format($q$select billing_reconcile_finish(%L)$q$, jsonb_build_object('run_id', r ->> 'id', 'status', 'failed')));
  perform br.ok('S16 a failed run needs its error (and a finished run stays finished)', e like '55000%' or e like '23514%', e);

  -- A manual run by an admin, in the other mode, alongside nothing.
  r := billing_reconcile_begin(jsonb_build_object('livemode', false, 'trigger', 'admin_client',
    'requested_by', (select v from br.saved where k = 'admin'), 'scope_client_id', br.id('c1')));
  perform br.ok('S17 an admin can start a one-client run', r ? 'id');
  perform billing_reconcile_client(jsonb_build_object('run_id', (r ->> 'id'), 'client_id', br.id('c1'),
    'stripe_customer_id', 'cus_Br1', 'status', 'healthy'));
  perform billing_reconcile_finish(jsonb_build_object('run_id', r ->> 'id', 'status', 'completed', 'customers_examined', 1));
end $$;
reset role;

-- A run whose function died is closed when the next one begins.
\c - supabase_admin
insert into billing_reconciliation_runs (id, livemode, trigger, started_at) values (br.id('dead'), false, 'schedule', now() - interval '2 hours');
-- Fingerprint changes: data vs bookkeeping.
update subscriptions set stripe_synced_at = now() + interval '1 minute', updated_at = now() where stripe_subscription_id = 'sub_Br1';
\c - authenticator
set role service_role;
do $$
declare r jsonb; fp jsonb; fp0 jsonb := (select v::jsonb from br.saved where k = 'fp1');
begin
  fp := billing_mirror_fingerprint(br.id('c1'), false);
  perform br.ok('F5 re-reading an unchanged object (only its sync time moves) leaves the fingerprint unchanged',
    fp -> 'subscription' = fp0 -> 'subscription', fp::text);
  r := billing_reconcile_begin('{"livemode": false, "trigger": "schedule"}');
  perform br.ok('S18 a run left running for two hours is closed as failed and a new one starts',
    (select status from billing_reconciliation_runs where id = br.id('dead')) = 'failed'
    and (select error from billing_reconciliation_runs where id = br.id('dead')) like 'Abandoned%' and r ? 'id');
  perform billing_reconcile_finish(jsonb_build_object('run_id', r ->> 'id', 'status', 'failed', 'error', 'Stripe authentication failed'));
end $$;
reset role;
\c - supabase_admin
update subscriptions set status = 'past_due' where stripe_subscription_id = 'sub_Br1';
update subscription_items set quantity = 2 where stripe_subscription_item_id = 'si_Br1';
update invoice_line_items set amount_cents = 99999 where stripe_line_item_id = 'il_Br1';
\c - authenticator
set role service_role;
do $$
declare fp jsonb; fp0 jsonb := (select v::jsonb from br.saved where k = 'fp1');
begin
  fp := billing_mirror_fingerprint(br.id('c1'), false);
  perform br.ok('F6 a changed status, item or line changes its parent''s digest (one change per object)',
    fp -> 'subscription' ->> 'sub_Br1' <> fp0 -> 'subscription' ->> 'sub_Br1'
    and fp -> 'invoice' ->> 'in_Br1' <> fp0 -> 'invoice' ->> 'in_Br1'
    and fp -> 'payment' = fp0 -> 'payment' and fp -> 'refund' = fp0 -> 'refund', fp::text);
end $$;
reset role;

-- ── R. Reads ─────────────────────────────────────────────────────────────────
set role authenticated;
select br.as_user('authenticated', '00000000-0000-4000-a000-0000000000f3');
do $$
declare h record;
begin
  perform br.ok('R1 a member reads the run history and results',
    (select count(*) from billing_reconciliation_runs) >= 3 and (select count(*) from billing_reconciliation_results) >= 3);
  perform br.ok('R2 the client view shows each client''s latest result in the current mode',
    (select status from client_billing_reconciliation where client_id = br.id('c1')) = 'healthy'
    and (select trigger from client_billing_reconciliation where client_id = br.id('c1')) = 'admin_client'
    and (select status from client_billing_reconciliation where client_id = br.id('c2')) = 'failed');
  select * into h from billing_sync_health;
  perform br.ok('R3 sync health counts failed and stuck webhook events (a live lease is not stuck)',
    h.failed_events = 1 and h.stuck_events = 1 and h.livemode = false and h.last_event_at is not null, row_to_json(h)::text);
  perform br.ok('R4 sync health shows the latest agency-wide run (a one-client run is not it)',
    h.last_run_status = 'failed' and h.last_run_trigger = 'schedule', row_to_json(h)::text);
end $$;
reset role;
set role authenticated;
select br.as_user('authenticated', :'pa');
do $$
begin
  perform br.ok('R5 a portal contact reads no reconciliation history or health',
    (select count(*) from billing_reconciliation_runs) = 0 and (select count(*) from billing_reconciliation_results) = 0
    and (select count(*) from client_billing_reconciliation) = 0
    and (select count(*) from billing_sync_health where last_event_at is not null or last_run_id is not null) = 0);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- In live mode the views show live results only.
\c - supabase_admin
insert into app_settings (key, value) values ('billing', '{"livemode": true}');
\c - authenticator
set role authenticated;
select br.as_user('authenticated', :'team');
do $$
begin
  perform br.ok('R6 switched to live, the client view and sync health show no test-mode runs',
    (select count(*) from client_billing_reconciliation) = 0
    and (select last_run_id is null and failed_events = 0 and livemode from billing_sync_health));
end $$;
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
delete from app_settings where key = 'billing';

-- ── I. History is append-only ────────────────────────────────────────────────
\c - postgres
do $$
declare e text;
begin
  e := br.try($q$delete from billing_reconciliation_results$q$);
  perform br.ok('I1 the worker cannot delete results', e like '42501%' or e like '23514%', e);
  e := br.try($q$update billing_reconciliation_runs set status = 'completed'$q$);
  perform br.ok('I2 the worker cannot rewrite runs', e like '42501%' or e like '23514%', e);
end $$;

\c - postgres
\o
\pset footer off
select status, count(*) from br.results group by status order by status;
select n, status, name, detail from br.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from br.results where status = 'fail';
  if f > 0 then raise exception '% billing reconciliation check(s) failed', f; end if;
end $$;
