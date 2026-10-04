-- Billing cutover, step 3: the fictional test client for the Stripe TEST MODE
-- lifecycle (docs/billing-readiness.md § 9). Idempotent (fixed ids).
--
-- It is PAUSED: the worker never works a paused client and the planners only
-- plan for active ones. Its insert disables the client-insert automation for
-- this one row (no worker fire, no Drive / GitHub provisioning, no brand-board,
-- baseline or pipeline tasks), inside this transaction only.
-- Test values below are fixtures for testing, not Compass product decisions.

begin;
alter table clients disable trigger clients_created;
alter table clients disable trigger clients_fire_worker;
alter table clients disable trigger clients_foundation_enrollment;
alter table clients disable trigger clients_provision;
alter table clients disable trigger clients_reporting_baseline;
alter table clients disable trigger clients_zz_seo_enrollment;
alter table clients disable trigger clients_zz_website_enrollment;

insert into clients (id, name, status, industry, city, state, notes)
values ('c0ffee00-0000-4000-b000-00000000b111', 'Compass Billing Test Client (TEST)', 'paused',
        'FICTIONAL billing test client — not a real business', 'Springfield', 'MO',
        'TEST DATA for the Stripe test-mode billing cutover. Never bill in live mode; offboard after go-live.')
on conflict (id) do nothing;

alter table clients enable trigger clients_created;
alter table clients enable trigger clients_fire_worker;
alter table clients enable trigger clients_foundation_enrollment;
alter table clients enable trigger clients_provision;
alter table clients enable trigger clients_reporting_baseline;
alter table clients enable trigger clients_zz_seo_enrollment;
alter table clients enable trigger clients_zz_website_enrollment;

insert into billing_packages (id, key, name, kind, description)
values ('c0ffee00-0000-4000-c000-00000000b111', 'test_standard', 'Test Standard (TEST)', 'standard',
        'TEST fixture for the Stripe test-mode cutover. Not a Compass product.')
on conflict (id) do nothing;

insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  ('c0ffee00-0000-4000-c000-00000000b111', 'website',           'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'hosting',           'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'seo',               'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'gbp',               'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'social',            'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'reporting',         'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'client_portal',     'feature', true, null),
  ('c0ffee00-0000-4000-c000-00000000b111', 'blog_posts',        'quota',   true, 4),
  ('c0ffee00-0000-4000-c000-00000000b111', 'gbp_posts',         'quota',   true, 8),
  ('c0ffee00-0000-4000-c000-00000000b111', 'social_posts',      'quota',   true, 30),
  ('c0ffee00-0000-4000-c000-00000000b111', 'website_pages',     'quota',   true, 2),
  ('c0ffee00-0000-4000-c000-00000000b111', 'website_refreshes', 'quota',   true, 2)
on conflict (package_id, service_key) do nothing;

-- Its agreed price is the TEST price Tom created in Stripe test mode
-- (price_1UMDr54Zq9yMk653B7jdneFm, $2,500.00/month — a fixture amount, not
-- Compass pricing). It is bound by 06_bind_test_client_price.sql once that
-- price is imported, so the sandbox Checkout runs the same agreement-price
-- enforcement live billing will.
insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
                   agreed_billing_interval_count, notes)
values ('c0ffee00-0000-4000-b000-00000000b111', 'c0ffee00-0000-4000-c000-00000000b111', 'stripe', 250000, 'usd', 'month', 1,
        'TEST agreement (fixture): $2,500.00/month, Stripe test mode only.')
on conflict (client_id) do nothing;
commit;

-- The test portal contact: invite a test inbox Tom controls from the test
-- client's Overview tab (Client portal card), or create the sign-in in
-- Supabase Auth and then:
--   insert into portal_users (client_id, email, is_active)
--   values ('c0ffee00-0000-4000-b000-00000000b111', '<<test inbox, not a team address>>', true);
