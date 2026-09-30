-- Tests for migration 0057 (billing foundation, B1), run by
-- scripts/test-portal-sandbox.sh on the same replay after the 0056 suite.
-- Own harness schema (bl) and its own fictional clients and Stripe ids.
--
-- Callers, as they reach production:
--   worker    psql as postgres
--   service   psql as authenticator, role service_role (the Stripe Edge Functions)
--   person    psql as authenticator, role authenticated, team JWT
--   portal    psql as authenticator, role authenticated, portal JWT (client A's contact)
--   stranger  psql as authenticator, role authenticated, a sign-in on no team / portal row
--   anon      psql as authenticator, role anon
--   fixtures  psql as supabase_admin: the Stripe mirror is written only by the
--             Stripe sync functions (0058, billing_sync.test.sql); these
--             checks are about 0057's constraints, so its rows are loaded as
--             the cluster superuser, which 0058's guard exempts (as 0047's).

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set member '00000000-0000-4000-a000-0000000000e1'

\o /dev/null
create schema bl;
create table bl.results (n serial, status text, name text, detail text);
create table bl.saved (k text primary key, v jsonb);
grant usage on schema bl to anon, authenticated, service_role, authenticator;
grant insert, select on bl.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on bl.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence bl.results_n_seq to anon, authenticated, service_role, authenticator;
create function bl.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into bl.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function bl.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function bl.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function bl.id(p_k text) returns uuid language sql immutable as $$ select md5('bl:' || p_k)::uuid $$;
create function bl.status(p_client uuid) returns jsonb language sql stable as $$
  select to_jsonb(s) from client_billing_status s where s.client_id = p_client
$$;
create function bl.ent(p_client uuid, p_key text) returns jsonb language sql stable as $$
  select to_jsonb(e) from client_entitlements e where e.client_id = p_client and e.service_key = p_key
$$;
grant execute on all functions in schema bl to anon, authenticated, service_role, authenticator;

-- ── Fixtures (fictional), as the worker ─────────────────────────────────────
-- A second teammate who is a member, not an admin (the sandbox's team user is
-- an admin, as 0036 seeds production's first sign-in).
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000e1', 'sandbox-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000e1', 'Sandbox Member', 'sandbox-member@compassmarketing.ai', 'member');
insert into clients (id, name, city, state, status) values
  (bl.id('c1'), 'Billing Roofing', 'Wentzville', 'MO', 'active'),
  (bl.id('c2'), 'Billing Plumbing', 'Columbia', 'MO', 'launching'),
  (bl.id('c3'), 'Billing Masonry', 'Rolla', 'MO', 'active'),
  (bl.id('c4'), 'Billing Electric', 'Joplin', 'MO', 'active');

-- ── S. Structure: the Compass dunning is gone, the catalog is seeded ─────────
do $$
begin
  perform bl.ok('S1 the billing-daily-past-due cron job is unscheduled',
    not exists (select 1 from cron.job where jobname = 'billing-daily-past-due'));
  perform bl.ok('S2 mark_past_due_subscriptions() is dropped',
    to_regprocedure('public.mark_past_due_subscriptions()') is null);
  perform bl.ok('S3 subscriptions.paid_status and its enum are gone',
    not exists (select 1 from information_schema.columns where table_name = 'subscriptions' and column_name = 'paid_status')
    and to_regtype('public.paid_status_type') is null);
  perform bl.ok('S4 no billing money column is a float or numeric: every amount is integer minor units',
    not exists (select 1 from information_schema.columns
      where table_schema = 'public' and data_type in ('numeric', 'double precision', 'real')
        and table_name in ('stripe_prices', 'stripe_customers', 'checkout_sessions', 'subscriptions',
          'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'plans')));
  perform bl.ok('S5 the service catalog holds the fourteen seeded services (9 features, 5 monthly quotas)',
    (select count(*) filter (where kind = 'feature') = 9 and count(*) filter (where kind = 'quota') = 5
     from service_catalog));
  perform bl.ok('S5b ...with the agreed names, website as Website Management and hosting as its own feature',
    (select jsonb_object_agg(key, name) from service_catalog) = '{
      "seo": "SEO", "website": "Website Management", "gbp": "Google Business Profile", "social": "Social Media",
      "paid_ads": "Paid Advertising", "crm": "CRM", "reporting": "Monthly Reporting", "client_portal": "Client Portal",
      "hosting": "Website Hosting", "blog_posts": "Blog Posts", "website_pages": "New Website Pages",
      "website_refreshes": "Website Page Refreshes", "gbp_posts": "Google Business Profile Posts",
      "social_posts": "Social Media Posts"}'::jsonb
    and (select kind from service_catalog where key = 'hosting') = 'feature');
  perform bl.ok('S6 plans no longer carries a fee or quantities',
    not exists (select 1 from information_schema.columns where table_name = 'plans'
      and column_name in ('monthly_fee', 'package_name', 'gbp_posts_per_month', 'blog_posts_per_month',
                          'social_posts_per_month', 'ad_budget_managed')));
end $$;

-- ── W. The Stripe mirror, loaded as Stripe sync would write it ──────────────
\c - supabase_admin
do $$
declare e text;
begin
  insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values
    ('prod_Std', false, 'Compass Marketing Package', true, now()),
    ('prod_Crm', false, 'Compass Marketing + CRM', true, now()),
    ('prod_Custom', false, 'Compass Custom Retainer', true, now()),
    ('prod_Web', false, 'Website project', true, now()),
    ('prod_Setup', false, 'Setup fee', true, now()),
    ('prod_LiveStd', true, 'Compass Marketing Package', true, now());
  insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency,
      unit_amount_cents, recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at) values
    ('price_StdM', 'prod_Std', false, true, 'recurring', 'usd', 150000, 'month', 1, 'licensed', now()),
    ('price_StdY', 'prod_Std', false, true, 'recurring', 'usd', 1200000, 'year', 1, 'licensed', now()),
    ('price_CrmM', 'prod_Crm', false, true, 'recurring', 'usd', 250000, 'month', 1, 'licensed', now()),
    ('price_CustC1', 'prod_Custom', false, true, 'recurring', 'usd', 99900, 'month', 1, 'licensed', now()),
    ('price_CustSpare', 'prod_Custom', false, true, 'recurring', 'usd', 50000, 'month', 1, 'licensed', now()),
    ('price_CrmY', 'prod_Crm', false, true, 'recurring', 'usd', 2400000, 'year', 1, 'licensed', now()),
    ('price_Web', 'prod_Web', false, true, 'one_time', 'usd', 500000, null, null, null, now()),
    ('price_LiveStdM', 'prod_LiveStd', true, true, 'recurring', 'usd', 150000, 'month', 1, 'licensed', now());
  perform bl.ok('W1 the Stripe catalog mirror loads', true);

  e := bl.try($q$insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency,
      unit_amount_cents, stripe_synced_at) values ('price_Bad', 'prod_Std', false, true, 'recurring', 'usd', 1, now())$q$);
  perform bl.ok('W2 a recurring price must carry its interval', e like '23514%', e);
  e := bl.try($q$insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency,
      unit_amount_cents, stripe_synced_at) values ('price_Bad', 'prod_Std', false, true, 'one_time', 'USD', 1, now())$q$);
  perform bl.ok('W3 currency is a lower-case ISO code', e like '23514%', e);
  e := bl.try($q$insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency,
      unit_amount_cents, stripe_synced_at) values ('price_Neg', 'prod_Std', false, true, 'one_time', 'usd', -1, now())$q$);
  perform bl.ok('W4 a price amount is never negative', e like '23514%', e);
  e := bl.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at)
      values ('Compass Package', false, 'x', true, now())$q$);
  perform bl.ok('W5 Stripe ids keep their Stripe shape (a name is not a product id)', e like '23514%', e);

  insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, email, stripe_synced_at) values
    (bl.id('c1'), 'cus_C1', false, 'created', 'owner@billing-roofing.test', now()),
    (bl.id('c2'), 'cus_C2', false, 'linked_existing', null, now()),
    (bl.id('c3'), 'cus_C3', false, 'created', null, now()),
    (bl.id('c4'), 'cus_C4', false, 'created', null, now()),
    ('00000000-0000-4000-b000-00000000000a', 'cus_A', false, 'created', null, now());

  e := bl.try(format($q$insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
      values (%L, 'cus_C1', false, 'linked_existing', now())$q$, bl.id('c2')));
  perform bl.ok('C1 one Stripe customer cannot be linked to a second client', e like '23505%', e);
  e := bl.try(format($q$insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
      values (%L, 'cus_C1dup', false, 'created', now())$q$, bl.id('c1')));
  perform bl.ok('C2 a client cannot get a second active test-mode customer (no duplicate creation)', e like '23505%', e);
  e := bl.try(format($q$insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
      values (%L, 'cus_C1live', true, 'created', now())$q$, bl.id('c1')));
  perform bl.ok('C3 ...but may have one live-mode customer alongside its test one', e is null, e);
  e := bl.try($q$update stripe_customers set unlinked_at = now() where stripe_customer_id = 'cus_C2'$q$);
  perform bl.ok('C4 unlinking needs a reason', e like '23514%', e);
  update stripe_customers set unlinked_at = now(), unlink_reason = 'linked the wrong customer' where stripe_customer_id = 'cus_C2';
  e := bl.try(format($q$insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
      values (%L, 'cus_C2b', false, 'linked_existing', now())$q$, bl.id('c2')));
  perform bl.ok('C5 after an unlink (kept, with its reason) the client can be linked again', e is null, e);
  e := bl.try(format($q$update stripe_customers set client_id = %L where stripe_customer_id = 'cus_C2'$q$, bl.id('c3')));
  perform bl.ok('C6 a customer never changes client, even once unlinked', e like '23514%', e);
  e := bl.try($q$update stripe_customers set stripe_customer_id = 'cus_Other' where stripe_customer_id = 'cus_C3'$q$);
  perform bl.ok('C7 a mirrored row never changes its Stripe id', e like '23514%', e);

  -- c1: Compass Marketing Package, 2 × monthly price, active.
  insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status,
      collection_method, currency, current_period_start, current_period_end, stripe_created_at, stripe_synced_at)
  values (bl.id('c1'), 'cus_C1', 'sub_C1', false, 'active', 'charge_automatically', 'usd',
          '2026-09-01', '2026-10-01', '2026-09-01', now());
  insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_C1', 'price_StdM', 2, now() from subscriptions where stripe_subscription_id = 'sub_C1';

  e := bl.try(format($q$insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode,
      status, collection_method, currency, stripe_synced_at)
      values (%L, 'cus_C1', 'sub_Cross', false, 'active', 'charge_automatically', 'usd', now())$q$, bl.id('c3')));
  perform bl.ok('X1 a subscription cannot belong to a client other than its customer''s', e like '23503%', e);
  e := bl.try(format($q$insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id,
      stripe_price_id, quantity, stripe_synced_at)
      select id, %L, 'si_Cross', 'price_StdM', 1, now() from subscriptions where stripe_subscription_id = 'sub_C1'$q$, bl.id('c3')));
  perform bl.ok('X2 a subscription item cannot carry another client', e like '23503%', e);
  e := bl.try(format($q$insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, stripe_subscription_id,
      livemode, status, collection_method, currency, subtotal_cents, total_cents, amount_due_cents,
      amount_paid_cents, amount_remaining_cents, stripe_created_at, stripe_synced_at)
      values (%L, 'cus_C3', 'in_Cross', 'sub_C1', false, 'open', 'charge_automatically', 'usd', 1, 1, 1, 0, 1, now(), now())$q$, bl.id('c3')));
  perform bl.ok('X3 an invoice cannot point at another client''s subscription', e like '23503%', e);
  e := bl.try(format($q$insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode,
      status, collection_method, currency, stripe_synced_at)
      values (%L, 'cus_C3', 'sub_Odd', false, 'pending', 'charge_automatically', 'usd', now())$q$, bl.id('c3')));
  perform bl.ok('X4 a subscription status is one of Stripe''s', e like '23514%', e);

  insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, stripe_subscription_id, livemode, status,
      collection_method, currency, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents,
      amount_remaining_cents, paid_at, stripe_created_at, stripe_synced_at)
  values (bl.id('c1'), 'cus_C1', 'in_C1Sep', 'sub_C1', false, 'paid', 'charge_automatically', 'usd',
          300000, 300000, 300000, 300000, 0, '2026-09-01', '2026-09-01', now());
  -- c1 also bought a one-time website project (no subscription).
  insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, status,
      collection_method, currency, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents,
      amount_remaining_cents, paid_at, stripe_created_at, stripe_synced_at)
  values (bl.id('c1'), 'cus_C1', 'in_C1Web', false, 'paid', 'send_invoice', 'usd',
          500000, 500000, 500000, 500000, 0, '2026-08-20', '2026-08-15', now());
  insert into invoice_line_items (invoice_id, client_id, stripe_line_item_id, stripe_price_id, stripe_product_id,
      amount_cents, currency, stripe_synced_at)
  select id, client_id, 'il_Web', 'price_Web', 'prod_Web', 500000, 'usd', now() from invoices where stripe_invoice_id = 'in_C1Web';
  insert into payments (client_id, source, stripe_customer_id, stripe_payment_intent_id, stripe_charge_id,
      stripe_invoice_id, livemode, status, payment_method_type, amount_cents, currency, paid_at, stripe_synced_at)
  values (bl.id('c1'), 'stripe', 'cus_C1', 'pi_C1Sep', 'py_C1Sep', 'in_C1Sep', false, 'succeeded',
          'us_bank_account', 300000, 'usd', '2026-09-04', now());
  perform bl.ok('W6 a client carries a recurring subscription and a one-time project charge side by side',
    (select count(*) from invoices where client_id = bl.id('c1')) = 2);

  e := bl.try($q$update payments set amount_refunded_cents = 300001 where stripe_payment_intent_id = 'pi_C1Sep'$q$);
  perform bl.ok('P1 a refund never exceeds the payment', e like '23514%', e);
  e := bl.try(format($q$insert into payments (client_id, source, stripe_payment_intent_id, livemode, status,
      amount_cents, currency, stripe_synced_at) values (%L, 'stripe', 'pi_NoCust', false, 'processing', 1, 'usd', now())$q$, bl.id('c1')));
  perform bl.ok('P2 a Stripe payment names its customer', e like '23514%', e);
  e := bl.try(format($q$insert into payments (client_id, source, external_method, status, amount_cents, currency, paid_at,
      stripe_payment_intent_id) values (%L, 'external', 'check', 'succeeded', 1000, 'usd', now(), 'pi_Mixed')$q$, bl.id('c3')));
  perform bl.ok('P3 an external payment carries no Stripe ids', e like '23514%', e);
  e := bl.try(format($q$insert into payments (client_id, source, external_method, status, amount_cents, currency)
      values (%L, 'external', 'wire', 'succeeded', 1000, 'usd')$q$, bl.id('c3')));
  perform bl.ok('P4 a succeeded payment has a paid date', e like '23514%', e);
  e := bl.try(format($q$insert into payments (client_id, source, external_method, status, amount_cents, currency, paid_at, reference)
      values (%L, 'external', 'check', 'succeeded', 120000, 'usd', '2026-09-10', 'check 1042')$q$, bl.id('c3')));
  perform bl.ok('P5 an externally paid arrangement can be represented (check, no Stripe ids)', e is null, e);

  -- Refunds: every partial refund is its own row.
  insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id, stripe_charge_id,
      livemode, amount_cents, currency, status, reason, stripe_created_at, stripe_synced_at)
  select client_id, id, 'pyr_One', 'pi_C1Sep', 'py_C1Sep', false, 100000, 'usd', 'succeeded', 'requested_by_customer', now(), now()
  from payments where stripe_payment_intent_id = 'pi_C1Sep';
  insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id, stripe_charge_id,
      livemode, amount_cents, currency, status, failure_reason, stripe_created_at, stripe_synced_at)
  select client_id, id, 'pyr_Two', 'pi_C1Sep', 'py_C1Sep', false, 50000, 'usd', 'failed', 'expired_or_canceled_card', now(), now()
  from payments where stripe_payment_intent_id = 'pi_C1Sep';
  insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id,
      livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
  select client_id, id, 're_Three', 'pi_C1Sep', false, 25000, 'usd', 'pending', now(), now()
  from payments where stripe_payment_intent_id = 'pi_C1Sep';
  update payments set amount_refunded_cents = 100000 where stripe_payment_intent_id = 'pi_C1Sep';
  perform bl.ok('F1 a payment keeps each partial refund (succeeded, failed with its reason, pending) as its own row',
    (select count(*) = 3 and sum(r.amount_cents) filter (where r.status = 'succeeded') = 100000
       and bool_or(r.failure_reason = 'expired_or_canceled_card')
     from stripe_refunds r join payments p on p.id = r.payment_id where p.stripe_payment_intent_id = 'pi_C1Sep'));
  e := bl.try(format($q$insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id,
      livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
      select %L, id, 're_Cross', 'pi_C1Sep', false, 1, 'usd', 'succeeded', now(), now()
      from payments where stripe_payment_intent_id = 'pi_C1Sep'$q$, bl.id('c3')));
  perform bl.ok('F2 a refund belongs to its payment''s client', e like '23503%', e);
  e := bl.try($q$insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id,
      livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
      select client_id, id, 're_Ext', 'pi_Nope', false, 1, 'usd', 'succeeded', now(), now()
      from payments where source = 'external'$q$);
  perform bl.ok('F3 an external payment has no Stripe refunds', e like '23503%', e);
  e := bl.try($q$update stripe_refunds set status = 'reversed' where stripe_refund_id = 're_Three'$q$);
  perform bl.ok('F4 a refund status is one of Stripe''s', e like '23514%', e);
  e := bl.try($q$update stripe_refunds set stripe_refund_id = 're_Other' where stripe_refund_id = 're_Three'$q$);
  perform bl.ok('F5 a refund never changes its Stripe id', e like '23514%', e);
  e := bl.try($q$insert into stripe_refunds (client_id, payment_id, stripe_refund_id,
      livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
      select client_id, id, 're_Orphan', false, 1, 'usd', 'succeeded', now(), now()
      from payments where stripe_payment_intent_id = 'pi_C1Sep'$q$);
  perform bl.ok('F6 a refund names its PaymentIntent or charge', e like '23514%', e);

  insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id)
  values ('evt_One', 'invoice.paid', false, now(), 'invoice', 'in_C1Sep');
  e := bl.try($q$update stripe_events set status = 'processed' where id = 'evt_One'$q$);
  perform bl.ok('E1 an event is not processed without processed_at', e like '23514%', e);
  e := bl.try($q$update stripe_events set status = 'failed', attempts = 1 where id = 'evt_One'$q$);
  perform bl.ok('E2 a failed event keeps its error', e like '23514%', e);
  e := bl.try($q$update stripe_events set status = 'ignored', processed_at = now() where id = 'evt_One'$q$);
  perform bl.ok('E3 an ignored event says why', e like '23514%', e);
  e := bl.try($q$insert into stripe_events (id, type, livemode, event_created_at) values ('evt_One', 'invoice.paid', false, now())$q$);
  perform bl.ok('E4 a redelivered event id is recorded once', e like '23505%', e);
  update stripe_events set status = 'failed', attempts = 1, last_error = 'upstream timeout', last_attempt_at = now() where id = 'evt_One';
  update stripe_events set status = 'processed', attempts = 2, processed_at = now(), last_attempt_at = now() where id = 'evt_One';
  perform bl.ok('E5 a failed event can be retried to processed', (select status from stripe_events where id = 'evt_One') = 'processed');
end $$;

\c - authenticator

-- ── T. A teammate: reads the mirror, never writes it; edits the catalog ──────
set role authenticated;
select bl.as_user('authenticated', :'team');
do $$
declare e text; t text;
begin
  perform bl.ok('T1 a teammate reads the mirror', (select count(*) from subscriptions where client_id = bl.id('c1')) = 1
    and (select count(*) from invoices where client_id = bl.id('c1')) = 2);
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
      'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
      'stripe_events'] loop
    e := bl.try(format('update %I set updated_at = updated_at', t));
    if t = 'stripe_events' then e := bl.try('update stripe_events set attempts = attempts'); end if;
    perform bl.ok('T2 a teammate cannot update ' || t, e like '42501%', e);
    e := bl.try(format('delete from %I', t));
    perform bl.ok('T3 a teammate cannot delete from ' || t, e like '42501%', e);
  end loop;
  e := bl.try(format($q$insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode,
      status, collection_method, currency, stripe_synced_at)
      values (%L, 'cus_C3', 'sub_Team', false, 'active', 'charge_automatically', 'usd', now())$q$, bl.id('c3')));
  perform bl.ok('T4 a teammate cannot insert a subscription', e like '42501%', e);
  e := bl.try(format($q$insert into payments (client_id, source, external_method, status, amount_cents, currency, paid_at)
      values (%L, 'external', 'check', 'succeeded', 1, 'usd', now())$q$, bl.id('c3')));
  perform bl.ok('T5 a teammate cannot record a payment through the API (B3 / B5 decide how)', e like '42501%', e);
  e := bl.try(format($q$insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
      values (%L, 'cus_Team', false, 'linked_existing', now())$q$, bl.id('c3')));
  perform bl.ok('T6 a teammate cannot link a customer by writing the table (the function does it, B3)', e like '42501%', e);

  -- The Compass catalog is the team's.
  insert into billing_packages (id, key, name, kind, stripe_product_id) values
    (bl.id('pkg_std'), 'marketing', 'Compass Marketing Package', 'standard', 'prod_Std'),
    (bl.id('pkg_crm'), 'marketing_crm', 'Compass Marketing + CRM', 'standard', 'prod_Crm'),
    (bl.id('pkg_custom'), 'custom_retainer', 'Compass Custom Retainer', 'custom', 'prod_Custom');
  insert into billing_one_time_items (key, name, category, stripe_product_id) values
    ('website_project', 'Website project', 'website_project', 'prod_Web');
  perform bl.ok('K1 an admin creates standard, custom and one-time catalog entries', true);

  e := bl.try($q$insert into billing_one_time_items (key, name, category, stripe_product_id)
      values ('std_again', 'x', 'other', 'prod_Std')$q$);
  perform bl.ok('K2 a package''s Stripe product cannot also be a one-time item', e like '23505%', e);
  e := bl.try($q$insert into billing_packages (key, name, kind, stripe_product_id) values ('web_again', 'x', 'standard', 'prod_Web')$q$);
  perform bl.ok('K3 a one-time item''s Stripe product cannot also be a package', e like '23505%', e);
  e := bl.try($q$insert into billing_packages (key, name, kind, stripe_product_id) values ('std_twice', 'x', 'standard', 'prod_Std')$q$);
  perform bl.ok('K4 two packages cannot share a Stripe product', e like '23505%', e);
  e := bl.try($q$insert into billing_packages (key, name, kind, stripe_product_id) values ('ghost', 'x', 'standard', 'prod_Nope')$q$);
  perform bl.ok('K5 a package names a product the mirror holds', e like '23503%', e);

  insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default) values
    (bl.id('pkg_std'), 'standard', 'prod_Std', 'price_StdM', true),
    (bl.id('pkg_std'), 'standard', 'prod_Std', 'price_StdY', false),
    (bl.id('pkg_crm'), 'standard', 'prod_Crm', 'price_CrmM', true);
  insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, client_id) values
    (bl.id('pkg_custom'), 'custom', 'prod_Custom', 'price_CustC1', bl.id('c4'));
  perform bl.ok('K6 standard prices map to their package; a custom retainer price names its client', true);

  e := bl.try(format($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id)
      values (%L, 'standard', 'prod_Std', 'price_CrmY')$q$, bl.id('pkg_std')));
  perform bl.ok('K7 a price from another product cannot sell a package', e like '23503%', e);
  e := bl.try(format($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, client_id)
      values (%L, 'standard', 'prod_Std', 'price_StdY', %L)$q$, bl.id('pkg_std'), bl.id('c3')));
  perform bl.ok('K8 a custom price cannot hide under a standard package', e like '23514%' or e like '23505%', e);
  e := bl.try(format($q$update billing_package_prices set client_id = %L where stripe_price_id = 'price_StdY'$q$, bl.id('c3')));
  perform bl.ok('K8b ...not even by editing an existing standard price', e like '23514%', e);
  e := bl.try(format($q$update billing_package_prices set client_id = null where stripe_price_id = 'price_CustC1'$q$));
  perform bl.ok('K9 a custom retainer price must name its client', e like '23514%', e);
  e := bl.try(format($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id)
      values (%L, 'custom', 'prod_Custom', 'price_CustSpare')$q$, bl.id('pkg_custom')));
  perform bl.ok('K9b ...from the moment it is mapped', e like '23514%', e);
  e := bl.try(format($q$update billing_package_prices set package_kind = 'standard' where stripe_price_id = 'price_CustC1'$q$));
  perform bl.ok('K10 a mapping cannot relabel its package''s kind', e like '23503%' or e like '23514%', e);
  e := bl.try(format($q$update billing_packages set kind = 'standard' where id = %L$q$, bl.id('pkg_custom')));
  perform bl.ok('K11 a custom package with client prices cannot become standard', e like '23503%', e);
  e := bl.try(format($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id)
      values (%L, 'standard', 'prod_Web', 'price_Web')$q$, bl.id('pkg_std')));
  perform bl.ok('K12 a one-time price cannot sell a recurring package', e like '23503%' or e like '23514%', e);
  e := bl.try(format($q$update billing_package_prices set is_default = true where stripe_price_id = 'price_StdY'$q$));
  perform bl.ok('K13 one default price per package', e like '23505%', e);

  -- Entitlements.
  insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
    (bl.id('pkg_std'), 'seo', 'feature', true, null),
    (bl.id('pkg_std'), 'gbp', 'feature', true, null),
    (bl.id('pkg_std'), 'social', 'feature', true, null),
    (bl.id('pkg_std'), 'paid_ads', 'feature', false, null),
    (bl.id('pkg_std'), 'blog_posts', 'quota', true, 4),
    (bl.id('pkg_std'), 'website_pages', 'quota', true, 2);
  e := bl.try(format($q$insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
      values (%L, 'crm', 'feature', true, 3)$q$, bl.id('pkg_std')));
  perform bl.ok('N1 a feature carries no quantity', e like '23514%', e);
  e := bl.try(format($q$insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
      values (%L, 'gbp_posts', 'quota', true, null)$q$, bl.id('pkg_std')));
  perform bl.ok('N2 an included quota has a quantity', e like '23514%', e);
  e := bl.try(format($q$insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
      values (%L, 'gbp_posts', 'feature', true, null)$q$, bl.id('pkg_std')));
  perform bl.ok('N3 an entitlement cannot mislabel its service''s kind', e like '23503%', e);
  e := bl.try(format($q$insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
      values (%L, 'coffee', 'feature', true, null)$q$, bl.id('pkg_std')));
  perform bl.ok('N4 an entitlement names a catalog service', e like '23503%', e);
  e := bl.try(format($q$insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
      values (%L, 'social_posts', 'quota', true, -1)$q$, bl.id('pkg_std')));
  perform bl.ok('N5 a quantity is never negative', e like '23514%', e);

  -- Agreements.
  insert into plans (client_id, package_id, term_months, start_date) values
    (bl.id('c1'), bl.id('pkg_std'), 12, '2026-09-01'),
    (bl.id('c4'), bl.id('pkg_custom'), 12, '2026-09-01');
  e := bl.try(format($q$insert into plans (client_id, collection) values (%L, 'external')$q$, bl.id('c3')));
  perform bl.ok('G1 an external arrangement states its method, amount, currency and interval', e like '23514%', e);
  e := bl.try(format($q$insert into plans (client_id, collection, external_method) values (%L, 'stripe', 'check')$q$, bl.id('c3')));
  perform bl.ok('G2 a Stripe-collected agreement carries no external terms', e like '23514%', e);
  insert into plans (client_id, collection, external_method, external_amount_cents, external_currency, external_interval)
  values (bl.id('c3'), 'external', 'check', 120000, 'usd', 'month');
  perform bl.ok('G3 a teammate records an external (check) arrangement', true);
  perform bl.ok('G4 the agreement is stamped with the teammate who wrote it',
    (select updated_by = (select id from team_members where auth_user_id = auth.uid()) from plans where client_id = bl.id('c3')));

  insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason) values
    (bl.id('c1'), 'blog_posts', 'quota', true, 6, 'Two extra posts a month agreed Sept 2026'),
    (bl.id('c1'), 'paid_ads', 'feature', true, null, 'Paid ads added to the agreement');
  e := bl.try(format($q$insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
      values (%L, 'crm', 'feature', true, null, '  ')$q$, bl.id('c1')));
  perform bl.ok('N6 an override says why', e like '23514%', e);
  insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason) values
    (bl.id('c4'), 'seo', 'feature', true, null, 'Custom retainer: SEO'),
    (bl.id('c4'), 'website_pages', 'quota', true, 3, 'Custom retainer: 3 pages a month');
  perform bl.ok('N7 overrides are stamped with the teammate',
    (select bool_and(updated_by is not null) from client_entitlement_overrides where client_id in (bl.id('c1'), bl.id('c4'))));
end $$;

-- ── R. Read models, as a teammate ────────────────────────────────────────────
do $$
declare s jsonb;
begin
  perform bl.ok('R1 package entitlement: SEO enabled from the package',
    (bl.ent(bl.id('c1'), 'seo') ->> 'enabled')::boolean and bl.ent(bl.id('c1'), 'seo') ->> 'source' = 'package');
  perform bl.ok('R2 override replaces the package quantity (blogs 4 → 6) and keeps the package figure for display',
    (bl.ent(bl.id('c1'), 'blog_posts') ->> 'quantity')::int = 6
    and (bl.ent(bl.id('c1'), 'blog_posts') ->> 'package_quantity')::int = 4
    and bl.ent(bl.id('c1'), 'blog_posts') ->> 'source' = 'override');
  perform bl.ok('R3 override turns on a feature the package leaves off (paid ads)',
    (bl.ent(bl.id('c1'), 'paid_ads') ->> 'enabled')::boolean and not (bl.ent(bl.id('c1'), 'paid_ads') ->> 'package_enabled')::boolean);
  perform bl.ok('R4 a service neither package nor override mentions is off, source none',
    not (bl.ent(bl.id('c1'), 'crm') ->> 'enabled')::boolean and bl.ent(bl.id('c1'), 'crm') ->> 'source' = 'none');
  perform bl.ok('R5 a custom retainer client gets exactly its overrides',
    (select array_agg(service_key order by service_key) from client_entitlements where client_id = bl.id('c4') and enabled)
    = array['seo', 'website_pages']);
  perform bl.ok('R6 a client without an agreement has every service off',
    (select bool_and(not enabled) and count(*) = 14 from client_entitlements where client_id = bl.id('c2')));

  s := bl.status(bl.id('c1'));
  perform bl.ok('R7 c1 is active, test mode, with its customer and subscription',
    s ->> 'billing_state' = 'active' and s ->> 'livemode' = 'false' and s ->> 'stripe_customer_id' = 'cus_C1'
    and s ->> 'stripe_subscription_id' = 'sub_C1', s::text);
  perform bl.ok('R8 MRR is derived from the items (2 × $1,500 = $3,000/month), never stored',
    (s ->> 'mrr_cents')::bigint = 300000, s ->> 'mrr_cents');
  perform bl.ok('R9 next billing date is the period end', (s ->> 'next_billing_at')::timestamptz = '2026-10-01', s ->> 'next_billing_at');
  perform bl.ok('R10 no attention for a healthy subscription on its agreement''s package',
    not (s ->> 'billing_attention')::boolean and s -> 'attention_reasons' = '[]', s ->> 'attention_reasons');
  perform bl.ok('R11 the latest invoice is the newest non-draft one',
    s ->> 'latest_invoice_id' = 'in_C1Sep' and s ->> 'latest_invoice_status' = 'paid', s::text);
  perform bl.ok('R12 an external arrangement reads as external, not as unpaid',
    bl.status(bl.id('c3')) ->> 'billing_state' = 'external' and not (bl.status(bl.id('c3')) ->> 'billing_attention')::boolean);
  perform bl.ok('R13 no agreement and no Stripe records → none',
    bl.status(bl.id('c2')) ->> 'billing_state' = 'none');
  perform bl.ok('R14 billing_monthly_cents normalises a yearly price to a month and ignores one-time prices',
    billing_monthly_cents(1200000, 1, 'year', 1) = 100000 and billing_monthly_cents(500000, 1, null, null) is null
    and round(billing_monthly_cents(1000, 1, 'week', 1)) = 4333 and billing_monthly_cents(300000, 1, 'month', 3) = 100000);
end $$;
reset role;

-- Stripe changes things; the mirror follows (as the sync functions will, 0058).
\c - supabase_admin
do $$
begin
  -- c1 goes past due, with an open invoice Stripe has already retried.
  insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, stripe_subscription_id, livemode, status,
      collection_method, currency, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents,
      amount_remaining_cents, attempt_count, attempted, next_payment_attempt, hosted_invoice_url, stripe_created_at, stripe_synced_at)
  values (bl.id('c1'), 'cus_C1', 'in_C1Oct', 'sub_C1', false, 'open', 'charge_automatically', 'usd',
          300000, 300000, 300000, 0, 300000, 2, true, now() + interval '3 days',
          'https://invoice.stripe.com/i/test_C1Oct', now(), now());
  update subscriptions set status = 'past_due' where stripe_subscription_id = 'sub_C1';
  -- c4 (custom retainer) is on a price nobody mapped, under the wrong package.
  insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status,
      collection_method, currency, cancel_at_period_end, current_period_end, stripe_created_at, stripe_synced_at)
  values (bl.id('c4'), 'cus_C4', 'sub_C4', false, 'active', 'charge_automatically', 'usd', true, '2026-10-15', now(), now());
  insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_C4', 'price_CrmM', 1, now() from subscriptions where stripe_subscription_id = 'sub_C4';
  -- c3 (external) also has two live Stripe subscriptions someone made in the dashboard.
  insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status,
      collection_method, currency, stripe_created_at, stripe_synced_at) values
    (bl.id('c3'), 'cus_C3', 'sub_C3a', false, 'active', 'charge_automatically', 'usd', now() - interval '1 day', now()),
    (bl.id('c3'), 'cus_C3', 'sub_C3b', false, 'incomplete', 'charge_automatically', 'usd', now(), now());
  -- c2 has a Checkout link waiting.
  insert into checkout_sessions (client_id, stripe_customer_id, stripe_checkout_session_id, livemode, mode, status,
      url, expires_at, package_id, line_items, stripe_synced_at)
  values (bl.id('c2'), 'cus_C2b', 'cs_test_C2', false, 'subscription', 'open',
          'https://checkout.stripe.com/c/pay/cs_test_C2', now() + interval '23 hours', bl.id('pkg_std'),
          '[{"price": "price_StdM", "quantity": 1}]', now());
  perform bl.ok('W7 subscriptions, invoices and checkout sessions follow Stripe''s changes', true);
end $$;

\c - authenticator

set role authenticated;
select bl.as_user('authenticated', :'team');
do $$
declare s jsonb;
begin
  s := bl.status(bl.id('c1'));
  perform bl.ok('R15 Stripe''s past_due is mirrored as billing_state past_due with attention',
    s ->> 'billing_state' = 'past_due' and (s ->> 'billing_attention')::boolean
    and s -> 'attention_reasons' @> '["subscription_past_due", "invoice_overdue"]', s ->> 'attention_reasons');
  perform bl.ok('R16a an overdue open invoice with no payment in flight counts as overdue',
    (s ->> 'overdue_invoice_count')::int = 1 and (s ->> 'settling_invoice_count')::int = 0, s::text);
  perform bl.ok('R16 ...showing the outstanding amount and the open invoice link Stripe issued',
    s -> 'outstanding_cents_by_currency' = '{"usd": 300000}' and s ->> 'latest_invoice_url' = 'https://invoice.stripe.com/i/test_C1Oct', s::text);
  perform bl.ok('R17 billing state never changes entitlements: c1 keeps SEO and 6 blogs while past due',
    (bl.ent(bl.id('c1'), 'seo') ->> 'enabled')::boolean and (bl.ent(bl.id('c1'), 'blog_posts') ->> 'quantity')::int = 6);

  s := bl.status(bl.id('c4'));
  perform bl.ok('R18 cancel at period end reads as canceling with no next billing date',
    s ->> 'billing_state' = 'canceling' and s ->> 'next_billing_at' is null, s::text);
  perform bl.ok('R19 a subscription on a price mapped to another package is flagged package_mismatch',
    s -> 'attention_reasons' @> '["package_mismatch"]', s ->> 'attention_reasons');

  s := bl.status(bl.id('c3'));
  perform bl.ok('R20 two live subscriptions are flagged, not refused (the mirror accepts what Stripe holds)',
    s -> 'attention_reasons' @> '["multiple_live_subscriptions", "subscription_incomplete"]'
    and (s ->> 'live_subscription_count')::int = 2, s ->> 'attention_reasons');
  perform bl.ok('R21 ...and a live subscription on no mapped price is flagged unmapped_price / no_agreement_package',
    s -> 'attention_reasons' @> '["no_agreement_package"]', s ->> 'attention_reasons');

  s := bl.status(bl.id('c2'));
  perform bl.ok('R22 an open Checkout link reads as checkout_pending with its URL',
    s ->> 'billing_state' = 'checkout_pending' and s ->> 'checkout_url' like 'https://checkout.stripe.com/%', s::text);

  -- Live mode shows live rows only.
  insert into app_settings (key, value) values ('billing', '{"livemode": true}');
  s := bl.status(bl.id('c1'));
  perform bl.ok('R23 in live mode test-mode customers and subscriptions are not shown',
    s ->> 'livemode' = 'true' and s ->> 'stripe_customer_id' = 'cus_C1live' and s ->> 'stripe_subscription_id' is null
    and s ->> 'billing_state' = 'none', s::text);
  update app_settings set value = '{"livemode": "yes"}' where key = 'billing';
  perform bl.ok('R24 anything but exactly {"livemode": true} is test mode', not billing_livemode());
  delete from app_settings where key = 'billing';
  perform bl.ok('R25 no setting is test mode', not billing_livemode());
end $$;
reset role;

-- An ACH debit for the October invoice is settling: not overdue while it does.
\c - supabase_admin
insert into payments (client_id, source, stripe_customer_id, stripe_payment_intent_id, stripe_invoice_id, livemode, status,
    payment_method_type, amount_cents, currency, stripe_synced_at)
values (bl.id('c1'), 'stripe', 'cus_C1', 'pi_C1Oct', 'in_C1Oct', false, 'processing', 'us_bank_account', 300000, 'usd', now());
\c - authenticator
set role authenticated;
select bl.as_user('authenticated', :'team');
do $$
declare s jsonb := bl.status(bl.id('c1'));
begin
  perform bl.ok('R26 an open invoice whose ACH debit is still processing is settling, not overdue (no false invoice_overdue)',
    (s ->> 'settling_invoice_count')::int = 1 and (s ->> 'overdue_invoice_count')::int = 0
    and not (s -> 'attention_reasons' @> '["invoice_overdue"]'), s::text);
end $$;
reset role;

-- ── A. Admin-only financial configuration; a member edits agreements ─────────
set role authenticated;
select bl.as_user('authenticated', :'member');
do $$
declare e text; t text; n bigint;
begin
  perform bl.ok('A1 a member is on the team but not an admin', is_team() and not is_team_admin());
  perform bl.ok('A2 a member reads the catalog and its Stripe mapping',
    (select count(*) from billing_packages) = 3 and (select count(*) from billing_package_prices) = 4
    and (select count(*) from service_catalog) = 14);
  e := bl.try($q$insert into billing_packages (key, name, kind) values ('member_pkg', 'x', 'standard')$q$);
  perform bl.ok('A3 a member cannot create a package', e like '42501%', e);
  foreach t in array array['billing_packages', 'billing_package_prices', 'billing_one_time_items',
      'package_entitlements', 'service_catalog'] loop
    execute format('with u as (update %I set updated_at = updated_at returning 1) select count(*) from u', t) into n;
    perform bl.ok('A4 a member''s update of ' || t || ' touches nothing', n = 0, n::text);
    execute format('with d as (delete from %I returning 1) select count(*) from d', t) into n;
    perform bl.ok('A5 a member''s delete from ' || t || ' touches nothing', n = 0, n::text);
  end loop;
  e := bl.try($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id)
      select id, 'standard', 'prod_Crm', 'price_CrmY' from billing_packages where key = 'marketing_crm'$q$);
  perform bl.ok('A6 a member cannot map a Stripe price to a package', e like '42501%', e);
  e := bl.try($q$insert into service_catalog (key, name, kind) values ('member_svc', 'x', 'feature')$q$);
  perform bl.ok('A7 a member cannot add a catalog service', e like '42501%', e);
  e := bl.try($q$insert into app_settings (key, value) values ('billing', '{"livemode": true}')$q$);
  perform bl.ok('A8 a member cannot switch billing to live mode', e like '42501%', e);
  perform bl.ok('A9 ...and billing_livemode() still reads test mode for the member', not billing_livemode());
  e := bl.try($q$insert into app_settings (key, value) values ('member_note', '{}')$q$);
  perform bl.ok('A10 other settings are unchanged for a member', e is null, e);
  delete from app_settings where key = 'member_note';
  -- Agreements and overrides stay the team's.
  e := bl.try(format($q$update plans set term_months = 24 where client_id = %L$q$, bl.id('c1')));
  perform bl.ok('A11 a member edits a client''s agreement', e is null
    and (select term_months from plans where client_id = bl.id('c1')) = 24, e);
  e := bl.try(format($q$insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, reason)
      values (%L, 'hosting', 'feature', true, 'Hosting added')$q$, bl.id('c1')));
  perform bl.ok('A12 a member sets a client entitlement override (hosting)', e is null, e);
  -- Nobody makes themselves an admin.
  e := bl.try($q$update team_members set role = 'admin' where auth_user_id = auth.uid()$q$);
  perform bl.ok('A13 a member cannot make themselves an admin', e like '42501%', e);
  e := bl.try($q$update team_members set auth_user_id = auth.uid() where role = 'admin'$q$);
  perform bl.ok('A14 a member cannot take over an admin''s row', e like '42501%', e);
  e := bl.try($q$delete from team_members where role = 'admin'$q$);
  perform bl.ok('A15 a member cannot remove an admin', e like '42501%', e);
  e := bl.try($q$insert into team_members (name, email, role) values ('New', 'new-admin@compassmarketing.ai', 'admin')$q$);
  perform bl.ok('A16 a member cannot create an admin', e like '42501%', e);
  e := bl.try($q$update team_members set name = 'Sandbox Member (renamed)' where auth_user_id = auth.uid()$q$);
  perform bl.ok('A17 a member can still edit a member row''s details', e is null, e);
end $$;
reset role;

set role authenticated;
select bl.as_user('authenticated', :'team');
do $$
declare e text;
begin
  perform bl.ok('A18 the admin is an admin', is_team_admin());
  e := bl.try($q$insert into app_settings (key, value) values ('billing', '{"livemode": false}')$q$);
  perform bl.ok('A19 an admin sets the billing mode', e is null, e);
  delete from app_settings where key = 'billing';
  e := bl.try($q$update team_members set role = 'admin' where email = 'sandbox-member@compassmarketing.ai'$q$);
  perform bl.ok('A20 an admin can promote a member', e is null, e);
  e := bl.try($q$update team_members set role = 'member' where email = 'sandbox-member@compassmarketing.ai'$q$);
  perform bl.ok('A21 ...and demote them again', e is null, e);
end $$;
reset role;

-- ── P. Portal contact, stranger, anon: nothing ───────────────────────────────
set role authenticated;
select bl.as_user('authenticated', :'pa');
do $$
declare e text; t text; n bigint;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
      'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
      'stripe_events', 'service_catalog', 'billing_packages', 'billing_package_prices', 'billing_one_time_items',
      'package_entitlements', 'client_entitlement_overrides', 'plans', 'client_entitlements', 'client_billing_status'] loop
    execute format('select count(*) from %I', t) into n;
    perform bl.ok('P6 a portal contact reads nothing from ' || t || ' (not even their own client''s)', n = 0, n::text);
  end loop;
  e := bl.try($q$insert into billing_packages (key, name, kind) values ('portal', 'x', 'standard')$q$);
  perform bl.ok('P7 a portal contact cannot write the catalog', e like '42501%', e);
  e := bl.try($q$insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, reason)
      values ('00000000-0000-4000-b000-00000000000a', 'seo', 'feature', true, 'mine')$q$);
  perform bl.ok('P8 a portal contact cannot grant their client an entitlement', e like '42501%', e);
end $$;
reset role;

set role authenticated;
select bl.as_user('authenticated', :'strngr');
do $$
declare n bigint; e text;
begin
  select (select count(*) from subscriptions) + (select count(*) from stripe_customers) + (select count(*) from invoices)
       + (select count(*) from plans) + (select count(*) from client_billing_status) + (select count(*) from client_entitlements) into n;
  perform bl.ok('P9 a signed-in stranger reads nothing', n = 0, n::text);
  e := bl.try($q$update billing_packages set name = 'x'$q$);
  perform bl.ok('P10 a stranger''s catalog update touches nothing', e is null
    and (select count(*) from billing_packages) = 0);
end $$;
reset role;

set role anon;
select bl.as_user('anon', null);
do $$
declare e text; t text;
begin
  foreach t in array array['subscriptions', 'invoices', 'payments', 'stripe_customers', 'stripe_events', 'plans',
      'billing_packages', 'service_catalog', 'client_entitlements', 'client_billing_status'] loop
    e := bl.try(format('select * from %I', t));
    perform bl.ok('P11 anon is refused ' || t, e like '42501%', e);
  end loop;
  e := bl.try('select billing_livemode()');
  perform bl.ok('P12 anon cannot call billing_livemode()', e like '42501%', e);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── I. Isolation: Five Layer / Authority read none of it; history is kept ────
\c - postgres
do $$
declare e text;
begin
  perform bl.ok('I1 only the billing functions (0057 – 0060) mention billing, plans, invoices or Stripe',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname not like 'billing\_%'
       and (p.prosrc ilike '%stripe%' or p.prosrc ilike '%entitlement%' or p.prosrc ilike '%billing%'
            or p.prosrc ~* '\mplans\M' or p.prosrc ilike '%invoice%')),
    (select string_agg(proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname not like 'billing\_%' and (p.prosrc ilike '%stripe%' or p.prosrc ilike '%entitlement%'
       or p.prosrc ilike '%billing%' or p.prosrc ~* '\mplans\M' or p.prosrc ilike '%invoice%')));
  perform bl.ok('I2 only the billing read models (0057, 0060) are views over billing tables',
    (select array_agg(viewname::text order by viewname) from pg_views where schemaname = 'public'
       and (definition ilike '%stripe%' or definition ilike '%entitlement%' or definition ~* '\mplans\M'))
    = array['billing_sync_health', 'client_billing_reconciliation', 'client_billing_status', 'client_entitlements']);
  perform bl.ok('I3 no portal view reads billing', not exists (select 1 from pg_views where schemaname = 'public'
    and viewname like 'portal\_%' and (definition ilike '%stripe%' or definition ilike '%invoice%' or definition ~* '\mplans\M'
    or definition ilike '%entitlement%')));
  perform bl.ok('I4 no billing security-definer function is callable by a signed-in user or anon',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.proname like 'billing%'
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))));
  e := bl.try(format('delete from clients where id = %L', bl.id('c1')));
  perform bl.ok('I5 a client with billing history cannot be deleted (offboard it instead)', e like '23503%', e);
  e := bl.try(format('delete from clients where id = %L', bl.id('c2')));
  perform bl.ok('I6 ...nor a client with a linked Stripe customer', e like '23503%', e);
end $$;

\o
\pset footer off
select status, count(*) from bl.results group by status order by status;
select n, status, name, detail from bl.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from bl.results where status = 'fail';
  if f > 0 then raise exception '% billing foundation check(s) failed', f; end if;
end $$;
