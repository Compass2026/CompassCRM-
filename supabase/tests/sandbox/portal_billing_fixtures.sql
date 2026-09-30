-- Billing rows for the portal fixtures' clients A and B, so portal_access's
-- generic checks (every portal view returns rows, all the contact's own) cover
-- the 0062 billing views too. Loaded as the cluster superuser (the Stripe
-- mirror is written only by the sync functions, 0059) before
-- portal_access.test.sql and removed after it by portal_billing_teardown.sql,
-- so the later billing suites start from the state they expect.
insert into billing_packages (id, key, name, kind) values
  ('00000000-0000-4000-e000-0000000000f1', 'portal_fixture', 'Portal Fixture Plan', 'standard');
insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  ('00000000-0000-4000-e000-0000000000f1', 'seo', 'feature', true, null),
  ('00000000-0000-4000-e000-0000000000f1', 'blog_posts', 'quota', true, 2);
insert into plans (client_id, package_id) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-e000-0000000000f1'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-e000-0000000000f1');
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values
  ('00000000-0000-4000-b000-00000000000a', 'cus_PortalFixA', false, 'created', now()),
  ('00000000-0000-4000-b000-00000000000b', 'cus_PortalFixB', false, 'created', now());
insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, status, collection_method, currency, number,
  subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, stripe_created_at, stripe_synced_at) values
  ('00000000-0000-4000-b000-00000000000a', 'cus_PortalFixA', 'in_PortalFixA', false, 'paid', 'charge_automatically', 'usd', 'FIX-A-1',
   1000, 1000, 1000, 1000, 0, now(), now()),
  ('00000000-0000-4000-b000-00000000000b', 'cus_PortalFixB', 'in_PortalFixB', false, 'paid', 'charge_automatically', 'usd', 'FIX-B-1',
   1000, 1000, 1000, 1000, 0, now(), now());
