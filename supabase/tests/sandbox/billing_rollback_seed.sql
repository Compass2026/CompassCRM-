-- Billing data for scripts/test-billing-rollback.sh: something in every table
-- the rollback drops, the billing mode, and the daily reconciliation schedule.
-- Loaded as the cluster superuser (0059's guard exempts it, as in the fixtures
-- of the other billing suites).
\set a '00000000-0000-4000-b000-00000000000a'
\set pkg '00000000-0000-4000-e000-0000000000b1'
insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values ('prod_Rb', false, 'Rollback Growth', true, now());
insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency, unit_amount_cents,
  recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at)
  values ('price_Rb', 'prod_Rb', false, true, 'recurring', 'usd', 100000, 'month', 1, 'licensed', now());
insert into billing_packages (id, key, name, kind, stripe_product_id) values (:'pkg', 'rb_growth', 'Rollback Growth', 'standard', 'prod_Rb');
insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default) values (:'pkg', 'standard', 'prod_Rb', 'price_Rb', true);
insert into billing_one_time_items (key, name, category) values ('rb_site', 'Rollback site build', 'website_project');
insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  (:'pkg', 'seo', 'feature', true, null), (:'pkg', 'blog_posts', 'quota', true, 4);
insert into plans (client_id, package_id) values (:'a', :'pkg');
insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
  values (:'a', 'blog_posts', 'quota', true, 6, 'Rollback test override');
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values (:'a', 'cus_Rb', false, 'created', now());
insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status, collection_method, currency, stripe_created_at, stripe_synced_at)
  values (:'a', 'cus_Rb', 'sub_Rb', false, 'active', 'charge_automatically', 'usd', now(), now());
insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_Rb', 'price_Rb', 1, now() from subscriptions where stripe_subscription_id = 'sub_Rb';
insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, status, collection_method, currency,
  subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, stripe_created_at, stripe_synced_at)
  values (:'a', 'cus_Rb', 'in_Rb', false, 'paid', 'charge_automatically', 'usd', 100000, 100000, 100000, 100000, 0, now(), now());
insert into invoice_line_items (invoice_id, client_id, stripe_line_item_id, amount_cents, currency, stripe_synced_at)
  select id, client_id, 'il_Rb', 100000, 'usd', now() from invoices where stripe_invoice_id = 'in_Rb';
insert into payments (client_id, source, stripe_customer_id, stripe_payment_intent_id, livemode, status, amount_cents, currency, paid_at, stripe_synced_at)
  values (:'a', 'stripe', 'cus_Rb', 'pi_Rb', false, 'succeeded', 100000, 'usd', now(), now());
insert into payments (client_id, source, status, external_method, notes, amount_cents, currency, paid_at)
  values (:'a', 'external', 'succeeded', 'check', 'Check 42', 5000, 'usd', now());
insert into stripe_refunds (client_id, payment_id, stripe_refund_id, stripe_payment_intent_id, livemode, amount_cents, currency, status, stripe_created_at, stripe_synced_at)
  select client_id, id, 're_Rb', 'pi_Rb', false, 1000, 'usd', 'succeeded', now(), now() from payments where stripe_payment_intent_id = 'pi_Rb';
insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id, status, processed_at) values ('evt_Rb', 'invoice.paid', false, now(), 'invoice', 'in_Rb', 'processed', now());
insert into billing_audit_events (client_id, action, actor_kind, livemode, subject) values (:'a', 'create_customer', 'team', false, 'cus_Rb');
insert into billing_reconciliation_runs (trigger, status, livemode, completed_at) values ('schedule', 'completed', false, clock_timestamp());
insert into automation_entitlement_log (client_id, automation, service_key, decision, reason, allocation, used)
  values (:'a', 'weekly_blog_post', 'blog_posts', 'created', 'within_allocation', 6, 1);
insert into app_settings (key, value) values ('billing', '{"livemode": false}'), ('billing_portal', '{"configuration_id": "bpc_Rb"}');
select cron.schedule('billing-reconcile-daily', '17 7 * * *', 'select billing_fire_reconciliation()');
