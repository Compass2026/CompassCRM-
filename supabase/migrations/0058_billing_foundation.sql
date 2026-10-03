-- 0058 — Billing foundation (B1 of docs/billing-audit.md; decisions of Sept 28 2026).
--
-- Stripe is the financial source of truth; Compass is the operational one.
-- This migration is the schema only: nothing here calls Stripe, and nothing
-- changes what the worker, Authority or Client Intelligence read.
--
-- What it does
--   1. Retires 0008's Compass-side dunning: the `billing-daily-past-due` cron
--      job, mark_past_due_subscriptions() and subscriptions.paid_status.
--      Stripe owns retries, past_due and unpaid; Compass mirrors them.
--   2. Rebuilds the Stripe mirror (the 0001 / 0008 tables were never used:
--      the migration refuses to run if any of them holds a row):
--        stripe_customers  one row per Stripe customer, the durable client ↔
--                          customer link (created by Compass or an existing
--                          customer linked by a teammate); a customer belongs to
--                          one client forever, a client has one active link
--                          per mode (test / live)
--        stripe_products, stripe_prices   the Stripe catalog as Stripe says it is
--        checkout_sessions the Checkout links Compass generates
--        subscriptions, subscription_items, invoices, invoice_line_items,
--        payments, stripe_refunds  what Stripe billed, collected and refunded
--                          (every partial refund its own row); money in
--                          integer minor units with a currency on every row
--        stripe_events     the webhook ledger: received → processed | ignored,
--                          or failed (retried); never "done" before the work is
--      Every mirror table is team READ-only. Writes come from the Stripe Edge
--      Functions (service role) in B2 / B3; no teammate, portal contact or
--      anon can write financial state through the API.
--   3. The Compass catalog (team-readable; admin-only writes, like the billing
--      mode and team roles: team_members.role is the authorization model):
--        service_catalog        what Compass delivers (features and monthly quotas)
--        billing_packages       standard packages and custom-retainer products,
--                               each bound to one Stripe Product
--        billing_package_prices which Stripe Prices sell a package; a custom
--                               retainer price names its one client, a standard
--                               package's prices name none (constraint)
--        billing_one_time_items website projects, setup fees, special projects
--        package_entitlements   what a package includes
--   4. The client agreement: `plans` keeps its name and its one row per client
--      but now says which package the client is on and how it pays (Stripe, or
--      an external arrangement: check / wire / manually received ACH), with
--      client_entitlement_overrides for exactly what a custom client receives.
--      The per-plan quantity columns move into entitlements. A Stripe-collected
--      agreement states what the client contracted to pay (agreed amount,
--      currency, interval) and, once that Stripe Price is approved, the exact
--      package price it is sold at (billing_package_price_id): the agreement,
--      not the operator, decides which of a package's prices Checkout sells.
--   5. Three read models, all invoker rights (RLS applies):
--        client_entitlements    package ⊕ overrides, per client and service
--        client_agreement_price the agreed price against its bound Stripe Price
--                               (ready / unmapped / mismatch …)
--        client_billing_status  derived from the mirror (never stored):
--                               billing_state, next billing date, MRR, latest
--                               invoice, and billing_attention with its reasons
--      Billing state never disables an entitlement (decision 5).
--
-- Tenancy (technical debt, flagged in docs/billing-audit.md): Compass has no
-- organization model yet. Every client-owned billing row carries client_id,
-- and child rows carry it too with a composite foreign key to their parent,
-- so a row can never point at another client's customer, subscription or
-- invoice, and a future organization policy needs one predicate per table.
-- Catalog tables are agency-level and will take an organization_id when the
-- tenant model lands. Stripe test and live mode are kept apart by `livemode`
-- on every mirrored row; app_settings 'billing' {"livemode": true} switches the
-- read models to live (anything else, or no row, is test mode).

-- ── 0. Preconditions ─────────────────────────────────────────────────────────
do $$
declare t text; n bigint;
begin
  foreach t in array array['stripe_customers', 'subscriptions', 'payments', 'stripe_events', 'plans'] loop
    execute format('select count(*) from %I', t) into n;
    if n > 0 then
      raise exception '0058 rebuilds % but it holds % row(s); migrate them by hand first', t, n;
    end if;
  end loop;
end $$;

-- ── 1. Retire the Compass dunning sweep (0008) ───────────────────────────────
select cron.unschedule(jobname) from cron.job where jobname = 'billing-daily-past-due';
drop function if exists mark_past_due_subscriptions();

-- ── 2. Drop the unused 0001 / 0008 mirror ────────────────────────────────────
drop table payments;
drop table subscriptions;
drop table stripe_customers;
drop table stripe_events;
drop type paid_status_type;
drop type payment_method_type;
drop type payment_source;
drop type payment_method;

-- ── 3. Mode ──────────────────────────────────────────────────────────────────
-- Which Stripe mode the read models show. Test unless exactly {"livemode": true}.
create function billing_livemode() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select value ->> 'livemode' = 'true' from app_settings where key = 'billing'), false)
$$;
comment on function billing_livemode() is
  'Stripe mode the billing read models show: live only when app_settings ''billing'' is exactly {"livemode": true}.';

-- Monthly-normalised amount of one price line, for MRR. NULL for one-time prices.
create function billing_monthly_cents(p_amount bigint, p_quantity int, p_interval text, p_interval_count int)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  -- periods per year / 12, kept as an exact fraction (a year is 1/12 of a month's rate).
  select p_amount::numeric * coalesce(p_quantity, 1)
         * case p_interval when 'month' then 12 when 'year' then 1 when 'week' then 52 when 'day' then 365 end
         / (12 * nullif(p_interval_count, 0))
$$;

-- Stamps updated_at and the signed-in teammate (NULL for a function or the worker).
create function billing_stamp_updated() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := (select id from team_members where auth_user_id = auth.uid());
  return new;
end $$;

-- A client-owned billing row never changes client, and its Stripe id never
-- changes (argument: the id column). A customer belongs to one client forever.
create function billing_owner_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.client_id is distinct from old.client_id
     or to_jsonb(new) ->> tg_argv[0] is distinct from to_jsonb(old) ->> tg_argv[0] then
    raise exception '% rows never change client or %', tg_table_name, tg_argv[0]
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ── 4. Stripe catalog mirror ─────────────────────────────────────────────────
create table stripe_products (
  stripe_product_id text primary key check (stripe_product_id ~ '^prod_[A-Za-z0-9]+$'),
  livemode boolean not null,
  name text not null,
  description text,
  active boolean not null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  stripe_created_at timestamptz,
  deleted_at timestamptz,               -- product.deleted
  stripe_synced_at timestamptz not null, -- when this row last read Stripe
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table stripe_prices (
  stripe_price_id text primary key check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  stripe_product_id text not null references stripe_products on delete restrict,
  livemode boolean not null,
  active boolean not null,
  type text not null check (type in ('recurring', 'one_time')),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  unit_amount_cents bigint check (unit_amount_cents >= 0), -- NULL for tiered / customer-chosen
  billing_scheme text not null default 'per_unit' check (billing_scheme in ('per_unit', 'tiered')),
  recurring_interval text check (recurring_interval in ('day', 'week', 'month', 'year')),
  recurring_interval_count int check (recurring_interval_count > 0),
  recurring_usage_type text check (recurring_usage_type in ('licensed', 'metered')),
  nickname text,
  lookup_key text,
  tax_behavior text check (tax_behavior in ('inclusive', 'exclusive', 'unspecified')),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  stripe_created_at timestamptz,
  deleted_at timestamptz,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_price_id, stripe_product_id, type),
  check ((type = 'recurring') = (recurring_interval is not null and recurring_interval_count is not null))
);
create index on stripe_prices (stripe_product_id);

-- ── 5. Compass catalog ───────────────────────────────────────────────────────
-- What Compass delivers. `key` is the contract code reads (entitlement keys);
-- a quota is a monthly quantity, a feature is on or off. The seed is the
-- initial catalog, not a closed list: an admin adds services as Compass sells them.
create table service_catalog (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null,
  description text,
  kind text not null check (kind in ('feature', 'quota')),
  unit text,
  period text check (period = 'month'),
  pipeline_key pipeline_key, -- the delivery pipeline it maps to, where one exists (not wired)
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key, kind),
  check ((kind = 'quota') = (unit is not null and period is not null))
);

insert into service_catalog (key, name, kind, unit, period, pipeline_key, sort_order, description) values
  ('seo',               'SEO',                           'feature', null,    null,    'seo',       10, 'Search engine optimisation programme'),
  ('website',           'Website Management',            'feature', null,    null,    'website',   20, 'Recurring website management (one-time website projects are billing_one_time_items)'),
  ('gbp',               'Google Business Profile',       'feature', null,    null,    null,        30, 'Business Profile management'),
  ('social',            'Social Media',                  'feature', null,    null,    'social',    40, 'Social media management'),
  ('paid_ads',          'Paid Advertising',              'feature', null,    null,    'paid_ads',  50, 'Paid advertising management'),
  ('crm',               'CRM',                           'feature', null,    null,    'crm',       60, 'CRM setup and management'),
  ('reporting',         'Monthly Reporting',             'feature', null,    null,    'reporting', 70, 'Monthly performance report'),
  ('client_portal',     'Client Portal',                 'feature', null,    null,    null,        80, 'Client portal access'),
  ('hosting',           'Website Hosting',               'feature', null,    null,    null,        90, 'Website hosting'),
  ('blog_posts',        'Blog Posts',                    'quota',   'posts', 'month', null,       110, 'Blog posts per month'),
  ('website_pages',     'New Website Pages',             'quota',   'pages', 'month', null,       120, 'New website pages per month'),
  ('website_refreshes', 'Website Page Refreshes',        'quota',   'pages', 'month', null,       130, 'Existing pages refreshed per month'),
  ('gbp_posts',         'Google Business Profile Posts', 'quota',   'posts', 'month', null,       140, 'Google Business Profile posts per month'),
  ('social_posts',      'Social Media Posts',            'quota',   'posts', 'month', null,       150, 'Social media posts per month');

-- Recurring agreements. `standard` packages have their own Stripe Product with
-- standard Prices; a `custom` package (e.g. "Compass Custom Retainer") is a
-- general Stripe Product whose Prices are each one client's agreement.
create table billing_packages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null,
  description text,
  kind text not null check (kind in ('standard', 'custom')),
  stripe_product_id text unique references stripe_products on delete restrict,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, stripe_product_id, kind)
);

-- Website projects, setup fees, special projects: one-time Stripe Products.
create table billing_one_time_items (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null,
  description text,
  category text not null check (category in ('website_project', 'setup_fee', 'special_project', 'other')),
  stripe_product_id text unique references stripe_products on delete restrict,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A Stripe Product belongs to at most one Compass catalog entry.
create function billing_product_single_owner() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.stripe_product_id is not null and (
       (tg_table_name = 'billing_packages'
        and exists (select 1 from billing_one_time_items where stripe_product_id = new.stripe_product_id))
    or (tg_table_name = 'billing_one_time_items'
        and exists (select 1 from billing_packages where stripe_product_id = new.stripe_product_id))) then
    raise exception 'Stripe product % already belongs to another Compass catalog entry', new.stripe_product_id
      using errcode = '23505';
  end if;
  return new;
end $$;
create trigger billing_packages_single_owner before insert or update of stripe_product_id on billing_packages
  for each row execute function billing_product_single_owner();
create trigger billing_one_time_items_single_owner before insert or update of stripe_product_id on billing_one_time_items
  for each row execute function billing_product_single_owner();

-- Which recurring Stripe Prices sell a package. The composite keys make it
-- structural: the price's product is the package's product, the price is
-- recurring, and client_id is set exactly when the package is custom (so a
-- custom price never hides under a standard package, and a standard price is
-- never reserved for one client).
create table billing_package_prices (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null,
  package_kind text not null,
  stripe_product_id text not null,
  stripe_price_id text not null unique,
  price_type text not null default 'recurring' check (price_type = 'recurring'),
  client_id uuid references clients on delete restrict,
  is_default boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (package_id, stripe_product_id, package_kind)
    references billing_packages (id, stripe_product_id, kind),
  foreign key (stripe_price_id, stripe_product_id, price_type)
    references stripe_prices (stripe_price_id, stripe_product_id, type),
  check ((package_kind = 'custom') = (client_id is not null)),
  check (not is_default or client_id is null),
  unique (id, package_id)   -- an agreement binds to a price of its own package (plans_price_of_package)
);
create unique index billing_package_prices_one_default on billing_package_prices (package_id)
  where is_default and active;
create index on billing_package_prices (client_id) where client_id is not null;

-- What a package includes. A feature is on or off (no quantity); a quota is
-- included exactly when it has a quantity.
create table package_entitlements (
  package_id uuid not null references billing_packages on delete cascade,
  service_key text not null,
  service_kind text not null,
  enabled boolean not null,
  quantity int check (quantity >= 0),
  notes text,
  updated_at timestamptz not null default now(),
  primary key (package_id, service_key),
  foreign key (service_key, service_kind) references service_catalog (key, kind),
  check (case service_kind when 'feature' then quantity is null
                           else enabled = (quantity is not null) end)
);

-- ── 6. The client agreement ──────────────────────────────────────────────────
-- plans stays one row per client (the Clients list and tabs read it by that
-- name) and becomes the agreement: package, how it is paid, term, and what the
-- client contracted to pay. Stripe stays authoritative for what was actually
-- billed and paid; the agreement is authoritative for the contracted price.
--   Stripe collection: agreed_amount_cents / agreed_currency /
--     agreed_billing_interval / agreed_billing_interval_count are the
--     contracted recurring terms (all four or none), and
--     billing_package_price_id is the exact approved price of the client's own
--     package that Checkout sells — null until that Stripe Price is imported
--     and approved; it must match the agreed terms (plans_agreement_price_guard).
--   External collection: the external_* terms, as before; no agreed_* and no
--     Stripe Price.
alter table plans
  drop column package_name,
  drop column monthly_fee,
  drop column gbp_posts_per_month,
  drop column blog_posts_per_month,
  drop column social_posts_per_month,
  drop column ad_budget_managed,
  add column package_id uuid references billing_packages on delete restrict,
  add column collection text not null default 'stripe' check (collection in ('stripe', 'external')),
  add column external_method text check (external_method in ('check', 'wire', 'ach_manual', 'other')),
  add column external_amount_cents bigint check (external_amount_cents > 0),
  add column external_currency text check (external_currency ~ '^[a-z]{3}$'),
  add column external_interval text check (external_interval in ('month', 'year')),
  add column managed_ad_budget_cents bigint check (managed_ad_budget_cents >= 0),
  add column agreed_amount_cents bigint check (agreed_amount_cents > 0),
  add column agreed_currency text check (agreed_currency ~ '^[a-z]{3}$'),
  add column agreed_billing_interval text check (agreed_billing_interval in ('month', 'year')),
  add column agreed_billing_interval_count int check (agreed_billing_interval_count between 1 and 12),
  add column billing_package_price_id uuid,
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references team_members on delete set null,
  add constraint plans_external_terms check (
    case collection
      when 'external' then external_method is not null and external_amount_cents is not null
                       and external_currency is not null and external_interval is not null
      else external_method is null and external_amount_cents is null
       and external_currency is null and external_interval is null
    end),
  add constraint plans_agreed_terms check (
    (agreed_amount_cents is null) = (agreed_currency is null)
    and (agreed_amount_cents is null) = (agreed_billing_interval is null)
    and (agreed_amount_cents is null) = (agreed_billing_interval_count is null)),
  add constraint plans_agreed_terms_stripe_only check (
    collection = 'stripe' or (agreed_amount_cents is null and billing_package_price_id is null)),
  add constraint plans_price_needs_terms check (
    billing_package_price_id is null or (agreed_amount_cents is not null and package_id is not null)),
  -- The bound price is one of the agreement's own package's prices: an
  -- agreement can never point at another package's price, and the package
  -- cannot change under a bound price.
  add constraint plans_price_of_package foreign key (billing_package_price_id, package_id)
    references billing_package_prices (id, package_id) on update restrict on delete restrict;
create index on plans (billing_package_price_id) where billing_package_price_id is not null;
create trigger plans_stamp before insert or update on plans
  for each row execute function billing_stamp_updated();

-- The agreed price and the bound Stripe Price are financial configuration
-- (like the catalog): a signed-in non-admin cannot set or change them. The
-- binding must be exactly the agreement's terms, at the moment it is made:
-- an approved, active price of a live catalog entry, recurring, licensed,
-- fixed-amount, in the current Stripe mode, reserved for no other client,
-- with the agreed amount, currency, interval and interval count. Re-checked
-- whenever the binding, the agreed terms, the package or the collection
-- change; Checkout re-checks everything again against Stripe's current state.
-- Sessions with no signed-in user (migrations, the cutover kit, the service
-- role) are not admin-gated, but the binding rules hold for every caller.
create function plans_agreement_price_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_terms_changed boolean;
  m record;
begin
  v_terms_changed := case when tg_op = 'INSERT'
    then new.agreed_amount_cents is not null or new.billing_package_price_id is not null
    else new.agreed_amount_cents is distinct from old.agreed_amount_cents
      or new.agreed_currency is distinct from old.agreed_currency
      or new.agreed_billing_interval is distinct from old.agreed_billing_interval
      or new.agreed_billing_interval_count is distinct from old.agreed_billing_interval_count
      or new.billing_package_price_id is distinct from old.billing_package_price_id end;
  if v_terms_changed and auth.uid() is not null and not is_team_admin() then
    raise exception 'Only an admin can set an agreement''s price or its Stripe Price' using errcode = '42501';
  end if;
  if new.billing_package_price_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and not v_terms_changed
     and new.package_id is not distinct from old.package_id and new.collection = old.collection then
    return new;
  end if;

  select bpp.client_id, bpp.active, bp.active as package_active, sp.stripe_price_id, sp.active as price_active,
         sp.deleted_at, sp.type, sp.livemode, sp.billing_scheme, sp.recurring_usage_type,
         sp.unit_amount_cents, sp.currency, sp.recurring_interval, sp.recurring_interval_count
    into m
  from billing_package_prices bpp
  join billing_packages bp on bp.id = bpp.package_id
  left join stripe_prices sp on sp.stripe_price_id = bpp.stripe_price_id
  where bpp.id = new.billing_package_price_id;
  if not found then
    raise exception 'agreement price: no such approved package price' using errcode = 'foreign_key_violation';
  end if;
  if m.client_id is not null and m.client_id <> new.client_id then
    raise exception 'agreement price: that price is reserved for another client' using errcode = 'check_violation';
  end if;
  if not m.active or not m.package_active or m.stripe_price_id is null or not m.price_active or m.deleted_at is not null then
    raise exception 'agreement price: that price is retired or archived' using errcode = 'check_violation';
  end if;
  if m.type <> 'recurring' or m.recurring_usage_type = 'metered'
     or m.billing_scheme <> 'per_unit' or m.unit_amount_cents is null then
    raise exception 'agreement price: only a fixed-amount licensed recurring price can be bound' using errcode = 'check_violation';
  end if;
  if m.livemode is distinct from billing_livemode() then
    raise exception 'agreement price: that is a % price; billing is in % mode',
      case when m.livemode then 'live' else 'test' end, case when billing_livemode() then 'live' else 'test' end
      using errcode = 'check_violation';
  end if;
  if m.unit_amount_cents <> new.agreed_amount_cents or m.currency <> new.agreed_currency
     or m.recurring_interval <> new.agreed_billing_interval
     or m.recurring_interval_count <> new.agreed_billing_interval_count then
    raise exception 'agreement price: the price (% % every % %) differs from the agreement (% % every % %)',
      m.unit_amount_cents, m.currency, m.recurring_interval_count, m.recurring_interval,
      new.agreed_amount_cents, new.agreed_currency, new.agreed_billing_interval_count, new.agreed_billing_interval
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function plans_agreement_price_guard() from public, anon, authenticated;
create trigger plans_agreement_price_guard before insert or update on plans
  for each row execute function plans_agreement_price_guard();
comment on table plans is
  'The client''s agreement: package, collection (Stripe or an external arrangement), term, and the contracted recurring price (agreed_*) with the exact approved package price Checkout sells (billing_package_price_id). What was billed and paid comes from Stripe.';

-- What one client receives beyond (or instead of) its package, with the reason.
create table client_entitlement_overrides (
  client_id uuid not null references clients on delete cascade,
  service_key text not null,
  service_kind text not null,
  enabled boolean not null,
  quantity int check (quantity >= 0),
  reason text not null check (length(btrim(reason)) > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references team_members on delete set null,
  primary key (client_id, service_key),
  foreign key (service_key, service_kind) references service_catalog (key, kind),
  check (case service_kind when 'feature' then quantity is null
                           else enabled = (quantity is not null) end)
);
create trigger client_entitlement_overrides_stamp before insert or update on client_entitlement_overrides
  for each row execute function billing_stamp_updated();

-- ── 7. Stripe client mirror ──────────────────────────────────────────────────
create table stripe_customers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode boolean not null,
  -- created: Compass created it; linked_existing: a teammate linked a customer
  -- that already existed in Stripe (never re-created).
  link_source text not null check (link_source in ('created', 'linked_existing')),
  linked_by uuid references team_members on delete set null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  unlinked_by uuid references team_members on delete set null,
  unlink_reason text,
  email text,
  name text,
  currency text check (currency ~ '^[a-z]{3}$'),
  default_payment_method_type text check (default_payment_method_type in ('card', 'us_bank_account', 'other')),
  default_payment_method_brand text,
  default_payment_method_last4 text check (default_payment_method_last4 ~ '^[0-9]{4}$'),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  stripe_created_at timestamptz,
  deleted_at timestamptz,                -- customer.deleted in Stripe
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_customer_id, client_id),
  check ((unlinked_at is null) = (unlink_reason is null))
);
-- One usable customer per client per mode: no duplicate creation, no second link.
create unique index stripe_customers_one_active_link on stripe_customers (client_id, livemode)
  where unlinked_at is null and deleted_at is null;

create table checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  stripe_customer_id text not null,
  stripe_checkout_session_id text not null unique check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  livemode boolean not null,
  mode text not null check (mode in ('subscription', 'payment', 'setup')),
  status text not null check (status in ('open', 'complete', 'expired')),
  payment_status text check (payment_status in ('paid', 'unpaid', 'no_payment_required')),
  url text check (url ~ '^https://'),
  expires_at timestamptz not null,
  package_id uuid references billing_packages on delete restrict,
  line_items jsonb not null default '[]' check (jsonb_typeof(line_items) = 'array'), -- [{price, quantity}] as requested
  stripe_subscription_id text,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  created_by uuid references team_members on delete set null,
  stripe_created_at timestamptz,
  completed_at timestamptz,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stripe_customer_id, client_id) references stripe_customers (stripe_customer_id, client_id)
);
create index on checkout_sessions (client_id, created_at desc);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  livemode boolean not null,
  -- Stripe's status verbatim. Stripe runs retries and dunning; Compass mirrors.
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active',
                                         'past_due', 'canceled', 'unpaid', 'paused')),
  collection_method text not null check (collection_method in ('charge_automatically', 'send_invoice')),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  ended_at timestamptz,
  cancellation_reason text,
  cancellation_feedback text,
  cancellation_comment text,
  pause_collection_behavior text check (pause_collection_behavior in ('keep_as_draft', 'mark_uncollectible', 'void')),
  pause_collection_resumes_at timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  start_date timestamptz,
  billing_cycle_anchor timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  days_until_due int,
  latest_stripe_invoice_id text check (latest_stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  default_payment_method_type text check (default_payment_method_type in ('card', 'us_bank_account', 'other')),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  stripe_created_at timestamptz,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stripe_customer_id, client_id) references stripe_customers (stripe_customer_id, client_id),
  unique (id, client_id),
  unique (stripe_subscription_id, client_id),
  check (pause_collection_resumes_at is null or pause_collection_behavior is not null)
);
-- No "one live subscription per client" constraint here on purpose: the mirror
-- must accept what Stripe holds (Stripe wins). Two live subscriptions are
-- surfaced as billing_attention 'multiple_live_subscriptions', and Compass's
-- own Checkout refuses to start a second one (B3).
create index on subscriptions (client_id);

create table subscription_items (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  client_id uuid not null,
  stripe_subscription_item_id text not null unique check (stripe_subscription_item_id ~ '^si_[A-Za-z0-9]+$'),
  stripe_price_id text not null references stripe_prices on delete restrict,
  quantity int check (quantity >= 0), -- NULL for metered prices
  stripe_created_at timestamptz,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (subscription_id, client_id) references subscriptions (id, client_id) on delete cascade
);
create index on subscription_items (subscription_id);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  stripe_customer_id text not null,
  stripe_invoice_id text not null unique check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  stripe_subscription_id text, -- NULL for one-time work
  livemode boolean not null,
  number text,
  status text not null check (status in ('draft', 'open', 'paid', 'uncollectible', 'void')),
  billing_reason text,
  collection_method text not null check (collection_method in ('charge_automatically', 'send_invoice')),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents bigint not null,
  total_cents bigint not null,
  amount_due_cents bigint not null check (amount_due_cents >= 0),
  amount_paid_cents bigint not null check (amount_paid_cents >= 0),
  amount_remaining_cents bigint not null check (amount_remaining_cents >= 0),
  attempt_count int not null default 0 check (attempt_count >= 0),
  attempted boolean not null default false,
  next_payment_attempt timestamptz,
  due_date timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  hosted_invoice_url text check (hosted_invoice_url ~ '^https://'),
  invoice_pdf text check (invoice_pdf ~ '^https://'),
  paid_out_of_band boolean not null default false,
  stripe_created_at timestamptz not null,
  finalized_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  marked_uncollectible_at timestamptz,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stripe_customer_id, client_id) references stripe_customers (stripe_customer_id, client_id),
  foreign key (stripe_subscription_id, client_id) references subscriptions (stripe_subscription_id, client_id),
  unique (id, client_id)
);
create index on invoices (client_id, stripe_created_at desc);
create index on invoices (stripe_subscription_id) where stripe_subscription_id is not null;

create table invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  client_id uuid not null,
  stripe_line_item_id text not null check (stripe_line_item_id ~ '^(il|ii|sli)_[A-Za-z0-9]+$'),
  -- Soft references: an ad hoc price (price_data on a one-time charge) is never
  -- in the catalog mirror.
  stripe_price_id text,
  stripe_product_id text,
  stripe_subscription_item_id text,
  description text,
  quantity int,
  amount_cents bigint not null, -- negative for credits / prorations
  currency text not null check (currency ~ '^[a-z]{3}$'),
  period_start timestamptz,
  period_end timestamptz,
  proration boolean not null default false,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, stripe_line_item_id),
  foreign key (invoice_id, client_id) references invoices (id, client_id) on delete cascade
);

-- Money movements. `stripe` rows mirror PaymentIntents and their charge (card,
-- ACH debit); amount_refunded_cents is Stripe's own aggregate from the charge,
-- kept for display, and every individual refund is its own stripe_refunds row;
-- `external` rows are an externally paid
-- arrangement recorded by the team (check, wire, manually received ACH) —
-- the schema allows them, and B3 / B5 decide who records them and how.
create table payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  source text not null check (source in ('stripe', 'external')),
  stripe_customer_id text,
  stripe_payment_intent_id text unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  stripe_charge_id text unique check (stripe_charge_id ~ '^(ch|py)_[A-Za-z0-9]+$'),
  stripe_invoice_id text check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'), -- soft: the invoice may land later
  livemode boolean,
  status text not null check (status in ('requires_payment_method', 'requires_confirmation', 'requires_action',
                                         'processing', 'requires_capture', 'succeeded', 'canceled', 'failed')),
  payment_method_type text check (payment_method_type in ('card', 'us_bank_account', 'other')),
  failure_code text,
  failure_message text,
  external_method text check (external_method in ('check', 'wire', 'ach_manual', 'other')),
  reference text,
  recorded_by uuid references team_members on delete set null,
  notes text,
  amount_cents bigint not null check (amount_cents >= 0),
  amount_refunded_cents bigint not null default 0 check (amount_refunded_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  paid_at timestamptz,
  stripe_created_at timestamptz,
  stripe_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stripe_customer_id, client_id) references stripe_customers (stripe_customer_id, client_id),
  unique (id, client_id, source),
  check (amount_refunded_cents <= amount_cents),
  check (status <> 'succeeded' or paid_at is not null),
  check (case source
    when 'stripe' then stripe_payment_intent_id is not null and stripe_customer_id is not null
                   and livemode is not null and stripe_synced_at is not null
                   and external_method is null and recorded_by is null
    else stripe_payment_intent_id is null and stripe_charge_id is null and stripe_customer_id is null
     and stripe_invoice_id is null and livemode is null and stripe_synced_at is null
     and external_method is not null and status = 'succeeded'
  end)
);
create index on payments (client_id, paid_at desc);

-- Every Stripe refund, one row each: a payment may have several partial
-- refunds, and none of that history is folded into an aggregate. A refund
-- belongs to its payment and to the payment's client.
create table stripe_refunds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete restrict,
  payment_id uuid not null,
  payment_source text not null default 'stripe' check (payment_source = 'stripe'),
  stripe_refund_id text not null unique check (stripe_refund_id ~ '^(re|pyr)_[A-Za-z0-9]+$'),
  stripe_payment_intent_id text check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  stripe_charge_id text check (stripe_charge_id ~ '^(ch|py)_[A-Za-z0-9]+$'),
  livemode boolean not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  -- Stripe's refund status verbatim.
  status text not null check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  reason text,          -- duplicate, fraudulent, requested_by_customer, expired_uncaptured_charge, …
  failure_reason text,  -- set by Stripe when a refund fails
  stripe_created_at timestamptz not null,
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (payment_id, client_id, payment_source) references payments (id, client_id, source),
  check (stripe_payment_intent_id is not null or stripe_charge_id is not null)
);
create index on stripe_refunds (payment_id);

-- The webhook ledger. An event is `processed` (or `ignored`, with the reason)
-- only after its work committed; a failure stays `failed` with the error and
-- Stripe's retry (or reconciliation) runs it again. Processing is idempotent.
create table stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  type text not null,
  livemode boolean not null,
  api_version text,
  event_created_at timestamptz not null,
  object_type text,
  object_id text,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts int not null default 0 check (attempts >= 0),
  last_error text,
  ignored_reason text,
  received_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  processed_at timestamptz,
  check ((status in ('processed', 'ignored')) = (processed_at is not null)),
  check (status <> 'ignored' or ignored_reason is not null),
  check (status <> 'failed' or last_error is not null)
);
create index stripe_events_pending on stripe_events (received_at) where status in ('received', 'failed');
create index on stripe_events (object_id);

-- ── 8. updated_at ────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'service_catalog', 'billing_packages',
    'billing_one_time_items', 'billing_package_prices', 'package_entitlements', 'stripe_customers',
    'checkout_sessions', 'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments',
    'stripe_refunds'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_updated_at', t);
  end loop;
end $$;

create trigger stripe_customers_owner before update on stripe_customers
  for each row execute function billing_owner_immutable('stripe_customer_id');
create trigger checkout_sessions_owner before update on checkout_sessions
  for each row execute function billing_owner_immutable('stripe_checkout_session_id');
create trigger subscriptions_owner before update on subscriptions
  for each row execute function billing_owner_immutable('stripe_subscription_id');
create trigger subscription_items_owner before update on subscription_items
  for each row execute function billing_owner_immutable('stripe_subscription_item_id');
create trigger invoices_owner before update on invoices
  for each row execute function billing_owner_immutable('stripe_invoice_id');
create trigger invoice_line_items_owner before update on invoice_line_items
  for each row execute function billing_owner_immutable('stripe_line_item_id');
create trigger payments_owner before update on payments
  for each row execute function billing_owner_immutable('stripe_payment_intent_id');
create trigger stripe_refunds_owner before update on stripe_refunds
  for each row execute function billing_owner_immutable('stripe_refund_id');
create trigger billing_package_prices_owner before update on billing_package_prices
  for each row execute function billing_owner_immutable('stripe_price_id');

-- ── 9. Access ────────────────────────────────────────────────────────────────
-- Financial configuration is an admin's: the existing team_members.role
-- ('admin' | 'member', 0001) is the authorization model, read by
-- is_team_admin(). Invoker rights: a teammate can read team_members (so the
-- answer is theirs); anyone else reads nothing and is not an admin.
create function is_team_admin() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from team_members where auth_user_id = auth.uid() and role = 'admin')
$$;
revoke all on function is_team_admin() from public, anon;
grant execute on function is_team_admin() to authenticated, service_role;
comment on function is_team_admin() is
  'Whether the signed-in user is a Compass admin (team_members.role). Gates financial configuration: the Stripe catalog mapping, packages, billing mode.';

-- Admin rights mean nothing if a member can grant them: a signed-in
-- non-admin cannot create an admin, change anyone's role, or edit or remove
-- an admin's row (re-pointing its auth_user_id would take the role over).
-- Sessions with no signed-in user (Supabase Auth's own linking trigger, the
-- service role, the worker's SQL, migrations) are not gated here.
create function team_members_admin_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or is_team_admin() then
    return coalesce(new, old);
  end if;
  if (tg_op in ('INSERT', 'UPDATE') and new.role = 'admin')
     or (tg_op in ('UPDATE', 'DELETE') and old.role = 'admin')
     or (tg_op = 'UPDATE' and new.role is distinct from old.role) then
    raise exception 'Only an admin can grant, change or remove an admin''s access' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function team_members_admin_guard() from public, anon, authenticated;
create trigger team_members_admin_guard before insert or update or delete on team_members
  for each row execute function team_members_admin_guard();

-- The billing mode (app_settings 'billing…' keys): everyone on the team reads
-- it (the read models depend on it), only an admin writes it.
create policy "billing settings: admin writes" on app_settings as restrictive for insert to authenticated
  with check (key not like 'billing%' or (select is_team_admin()));
create policy "billing settings: admin updates" on app_settings as restrictive for update to authenticated
  using (key not like 'billing%' or (select is_team_admin()))
  with check (key not like 'billing%' or (select is_team_admin()));
create policy "billing settings: admin deletes" on app_settings as restrictive for delete to authenticated
  using (key not like 'billing%' or (select is_team_admin()));

-- Financial mirror: team reads, only the service role (Stripe functions) writes.
do $$
declare t text;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "team read" on %I for select to authenticated using ((select is_team()))', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  -- The catalog (services, packages, their Stripe product / price mapping,
  -- one-time items, what a package includes): the team reads, an admin edits.
  foreach t in array array['service_catalog', 'billing_packages', 'billing_package_prices',
    'billing_one_time_items', 'package_entitlements'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "team read" on %I for select to authenticated using ((select is_team()))', t);
    execute format('create policy "admin manages" on %I for all to authenticated using ((select is_team()) and (select is_team_admin())) with check ((select is_team()) and (select is_team_admin()))', t);
  end loop;
  -- A client's agreement and its entitlement overrides: the team edits them.
  alter table client_entitlement_overrides enable row level security;
  create policy "team full access" on client_entitlement_overrides for all to authenticated
    using ((select is_team())) with check ((select is_team()));
  foreach t in array array['service_catalog', 'billing_packages', 'billing_package_prices',
    'billing_one_time_items', 'package_entitlements', 'client_entitlement_overrides', 'plans'] loop
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

revoke all on function billing_livemode() from public, anon;
grant execute on function billing_livemode() to authenticated, service_role;
revoke all on function billing_monthly_cents(bigint, int, text, int) from public, anon;
grant execute on function billing_monthly_cents(bigint, int, text, int) to authenticated, service_role;
revoke all on function billing_stamp_updated() from public, anon, authenticated;
revoke all on function billing_product_single_owner() from public, anon, authenticated;
revoke all on function billing_owner_immutable() from public, anon, authenticated;

-- ── 10. Read models ──────────────────────────────────────────────────────────
-- Effective entitlements: the client's package, with its overrides on top.
create view client_entitlements with (security_invoker = true) as
select
  c.id as client_id,
  s.key as service_key,
  s.name as service_name,
  s.kind as service_kind,
  s.unit,
  s.period,
  s.sort_order,
  case when o.client_id is not null then o.enabled else coalesce(pe.enabled, false) end as enabled,
  case when o.client_id is not null then o.quantity else pe.quantity end as quantity,
  case when o.client_id is not null then 'override' when pe.package_id is not null then 'package' else 'none' end as source,
  p.package_id,
  pe.enabled as package_enabled,
  pe.quantity as package_quantity,
  o.reason as override_reason
from clients c
cross join service_catalog s
left join plans p on p.client_id = c.id
left join package_entitlements pe on pe.package_id = p.package_id and pe.service_key = s.key
left join client_entitlement_overrides o on o.client_id = c.id and o.service_key = s.key
where s.active;

-- The agreement's price against the Stripe Price it is bound to, per client.
-- price_status: not_applicable (no Stripe-collected package agreement),
-- terms_missing (no agreed amount), unmapped (no exact price bound yet),
-- inactive (the bound mapping, package or Stripe Price is retired / archived),
-- wrong_mode (bound to a price of the other Stripe mode), mismatch (the price
-- no longer says what the agreement says, or is not a fixed licensed recurring
-- price of this client's package), ready (Checkout may sell it). The same
-- rules Checkout applies (stripe-billing checkCheckoutPrice), read from the
-- mirror; Checkout re-reads the price from Stripe first.
create view client_agreement_price with (security_invoker = true) as
select
  c.id as client_id,
  pl.collection,
  pl.package_id,
  pl.agreed_amount_cents,
  pl.agreed_currency,
  pl.agreed_billing_interval,
  pl.agreed_billing_interval_count,
  pl.billing_package_price_id,
  bpp.stripe_price_id,
  sp.unit_amount_cents as price_amount_cents,
  sp.currency as price_currency,
  sp.recurring_interval as price_interval,
  sp.recurring_interval_count as price_interval_count,
  sp.livemode as price_livemode,
  case
    when pl.client_id is null or pl.package_id is null or pl.collection <> 'stripe' then 'not_applicable'
    when pl.agreed_amount_cents is null then 'terms_missing'
    when pl.billing_package_price_id is null then 'unmapped'
    when not bpp.active or not bp.active or sp.stripe_price_id is null or not sp.active
         or sp.deleted_at is not null then 'inactive'
    when sp.livemode <> billing_livemode() then 'wrong_mode'
    when bpp.package_id <> pl.package_id
         or (bpp.client_id is not null and bpp.client_id <> pl.client_id)
         or sp.type <> 'recurring' or sp.recurring_usage_type = 'metered' or sp.billing_scheme <> 'per_unit'
         or sp.unit_amount_cents is null
         or sp.unit_amount_cents <> pl.agreed_amount_cents or sp.currency <> pl.agreed_currency
         or sp.recurring_interval <> pl.agreed_billing_interval
         or sp.recurring_interval_count <> pl.agreed_billing_interval_count then 'mismatch'
    else 'ready'
  end as price_status
from clients c
left join plans pl on pl.client_id = c.id
left join billing_package_prices bpp on bpp.id = pl.billing_package_price_id
left join billing_packages bp on bp.id = bpp.package_id
left join stripe_prices sp on sp.stripe_price_id = bpp.stripe_price_id;

-- Billing state per client, derived from the Stripe mirror in the current mode.
-- Nothing here is stored, so nothing here goes stale. billing_attention is an
-- operational flag Compass derives from Stripe's own state; it never changes
-- an entitlement.
create view client_billing_status with (security_invoker = true) as
with mode as (
  select billing_livemode() as live
),
customer as (
  select sc.client_id, sc.stripe_customer_id, sc.default_payment_method_type,
         sc.default_payment_method_brand, sc.default_payment_method_last4
  from stripe_customers sc, mode
  where sc.livemode = mode.live and sc.unlinked_at is null and sc.deleted_at is null
),
subs as (
  select s.*, s.status not in ('canceled', 'incomplete_expired') as is_live
  from subscriptions s, mode
  where s.livemode = mode.live
),
live_count as (
  select client_id, count(*) as n from subs where is_live group by client_id
),
current_sub as (
  select distinct on (client_id) *
  from subs
  order by client_id, is_live desc, coalesce(stripe_created_at, created_at) desc
),
sub_money as (
  select si.subscription_id,
         round(sum(billing_monthly_cents(pr.unit_amount_cents, si.quantity,
                                         pr.recurring_interval, pr.recurring_interval_count)))::bigint as mrr_cents,
         bool_or(pr.unit_amount_cents is null or pr.recurring_usage_type = 'metered') as mrr_incomplete,
         array_agg(distinct bpp.package_id) filter (where bpp.package_id is not null) as package_ids,
         array_agg(distinct si.stripe_price_id) as price_ids,
         bool_or(bpp.id is null) as has_unmapped_price
  from subscription_items si
  join stripe_prices pr on pr.stripe_price_id = si.stripe_price_id
  left join billing_package_prices bpp on bpp.stripe_price_id = si.stripe_price_id and bpp.active
  group by si.subscription_id
),
-- An open invoice is overdue once its due date passed or a collection
-- attempt failed — but not while a payment for it is still settling (an ACH
-- debit sits in `processing` for days with the invoice open and attempted).
open_invoices as (
  select i.client_id,
         count(*) as open_count,
         count(*) filter (where (i.due_date < now() or i.attempt_count > 0) and not x.settling) as overdue_count,
         count(*) filter (where x.settling) as settling_count
  from invoices i
  cross join mode
  cross join lateral (select exists (select 1 from payments p where p.stripe_invoice_id = i.stripe_invoice_id
                                     and p.status = 'processing') as settling) x
  where i.livemode = mode.live and i.status = 'open'
  group by i.client_id
),
outstanding as (
  select i.client_id, i.currency, sum(i.amount_remaining_cents)::bigint as cents
  from invoices i, mode
  where i.livemode = mode.live and i.status = 'open'
  group by i.client_id, i.currency
),
latest_invoice as (
  select distinct on (i.client_id) i.*
  from invoices i, mode
  where i.livemode = mode.live and i.status <> 'draft'
  order by i.client_id, i.stripe_created_at desc
),
open_checkout as (
  select distinct on (cs.client_id) cs.client_id, cs.url, cs.expires_at, cs.mode
  from checkout_sessions cs, mode
  where cs.livemode = mode.live and cs.status = 'open' and cs.expires_at > now()
  order by cs.client_id, cs.created_at desc
),
base as (
  select
    c.id as client_id,
    (select live from mode) as livemode,
    pl.collection,
    pl.package_id as agreement_package_id,
    cu.stripe_customer_id,
    cu.default_payment_method_type,
    cu.default_payment_method_brand,
    cu.default_payment_method_last4,
    cs.stripe_subscription_id,
    cs.status as subscription_status,
    cs.is_live,
    cs.cancel_at_period_end,
    cs.cancel_at,
    cs.canceled_at,
    cs.pause_collection_behavior,
    cs.current_period_start,
    cs.current_period_end,
    cs.currency as subscription_currency,
    sm.mrr_cents,
    sm.mrr_incomplete,
    sm.package_ids as subscription_package_ids,
    sm.price_ids as subscription_price_ids,
    sm.has_unmapped_price,
    ap.price_status as agreement_price_status,
    ap.stripe_price_id as agreement_stripe_price_id,
    coalesce(lc.n, 0) as live_subscription_count,
    coalesce(oi.open_count, 0) as open_invoice_count,
    coalesce(oi.overdue_count, 0) as overdue_invoice_count,
    coalesce(oi.settling_count, 0) as settling_invoice_count,
    li.stripe_invoice_id as latest_invoice_id,
    li.status as latest_invoice_status,
    li.total_cents as latest_invoice_total_cents,
    li.amount_remaining_cents as latest_invoice_remaining_cents,
    li.currency as latest_invoice_currency,
    li.due_date as latest_invoice_due_date,
    li.hosted_invoice_url as latest_invoice_url,
    oc.url as checkout_url,
    oc.expires_at as checkout_expires_at
  from clients c
  left join plans pl on pl.client_id = c.id
  left join customer cu on cu.client_id = c.id
  left join current_sub cs on cs.client_id = c.id
  left join sub_money sm on sm.subscription_id = cs.id
  left join live_count lc on lc.client_id = c.id
  left join open_invoices oi on oi.client_id = c.id
  left join latest_invoice li on li.client_id = c.id
  left join open_checkout oc on oc.client_id = c.id
  left join client_agreement_price ap on ap.client_id = c.id
)
select
  b.client_id,
  b.livemode,
  b.collection,
  b.agreement_package_id,
  b.stripe_customer_id,
  b.default_payment_method_type,
  b.default_payment_method_brand,
  b.default_payment_method_last4,
  b.stripe_subscription_id,
  b.subscription_status,
  b.cancel_at_period_end,
  b.cancel_at,
  b.canceled_at,
  b.pause_collection_behavior,
  b.current_period_start,
  b.current_period_end,
  case when b.is_live and b.subscription_status in ('trialing', 'active', 'past_due')
            and not b.cancel_at_period_end and b.cancel_at is null and b.pause_collection_behavior is null
       then b.current_period_end end as next_billing_at,
  case when b.is_live then b.mrr_cents end as mrr_cents,
  case when b.is_live then coalesce(b.mrr_incomplete, false) end as mrr_incomplete,
  b.subscription_currency as currency,
  b.subscription_package_ids,
  b.live_subscription_count,
  b.open_invoice_count,
  b.overdue_invoice_count,
  b.settling_invoice_count,
  (select coalesce(jsonb_object_agg(o.currency, o.cents), '{}') from outstanding o
    where o.client_id = b.client_id) as outstanding_cents_by_currency,
  b.latest_invoice_id,
  b.latest_invoice_status,
  b.latest_invoice_total_cents,
  b.latest_invoice_remaining_cents,
  b.latest_invoice_currency,
  b.latest_invoice_due_date,
  b.latest_invoice_url,
  b.checkout_url,
  b.checkout_expires_at,
  case
    when b.is_live then
      case when b.pause_collection_behavior is not null then 'collection_paused'
           when b.subscription_status in ('active', 'trialing')
                and (b.cancel_at_period_end or b.cancel_at is not null) then 'canceling'
           else b.subscription_status end
    when b.checkout_url is not null then 'checkout_pending'
    when b.collection = 'external' then 'external'
    when b.subscription_status is not null then 'canceled'
    else 'none'
  end as billing_state,
  r.reasons as attention_reasons,
  cardinality(r.reasons) > 0 as billing_attention
from base b
cross join lateral (
  select array_remove(array[
    case when b.is_live and b.subscription_status = 'past_due' then 'subscription_past_due' end,
    case when b.is_live and b.subscription_status = 'unpaid' then 'subscription_unpaid' end,
    case when b.is_live and b.subscription_status = 'incomplete' then 'subscription_incomplete' end,
    case when b.overdue_invoice_count > 0 then 'invoice_overdue' end,
    case when b.live_subscription_count > 1 then 'multiple_live_subscriptions' end,
    case when b.is_live and b.has_unmapped_price then 'unmapped_price' end,
    case when b.is_live and b.agreement_package_id is null then 'no_agreement_package' end,
    case when b.is_live and b.agreement_package_id is not null
              and not (b.agreement_package_id = any (coalesce(b.subscription_package_ids, '{}'))) then 'package_mismatch' end,
    -- Configuration, not financial state: billing is under way for a client
    -- (a live subscription, a linked customer or an open link) while its
    -- agreement has no exact price; or the bound price no longer says what
    -- the agreement says; or the live subscription sells a different price.
    case when b.agreement_price_status in ('terms_missing', 'unmapped')
              and (b.is_live or b.stripe_customer_id is not null or b.checkout_url is not null) then 'agreement_price_unmapped' end,
    case when b.agreement_price_status = 'mismatch'
              or (b.is_live and b.agreement_stripe_price_id is not null
                  and not (b.agreement_stripe_price_id = any (coalesce(b.subscription_price_ids, '{}')))) then 'agreement_price_mismatch' end
  ], null) as reasons
) r;

revoke all on client_entitlements, client_agreement_price, client_billing_status from public, anon, authenticated;
grant select on client_entitlements, client_agreement_price, client_billing_status to authenticated, service_role;

comment on view client_entitlements is
  'Effective service entitlements per client: the agreement''s package with client overrides on top. Billing state never changes them.';
comment on view client_agreement_price is
  'Per client: the agreement''s contracted recurring price and the exact approved Stripe Price bound to it, with price_status (ready / unmapped / mismatch …). Configuration only; never financial state.';
comment on view client_billing_status is
  'Billing state per client derived from the Stripe mirror in the current mode (billing_livemode()). Stripe is authoritative; nothing here is stored.';

-- ── 11. Verify ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events', 'service_catalog', 'billing_packages', 'billing_package_prices', 'billing_one_time_items',
    'package_entitlements', 'client_entitlement_overrides', 'plans'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0058: RLS is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger') then
      raise exception '0058: anon holds a privilege on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
               and (coalesce(qual, '') not like '%is_team()%' or coalesce(with_check, qual) not like '%is_team()%')) then
      raise exception '0058: a policy on % does not read is_team()', t;
    end if;
  end loop;
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete,truncate,references,trigger')
       or exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
      raise exception '0058: the financial mirror % is writable through the API', t;
    end if;
  end loop;
  foreach t in array array['client_entitlements', 'client_agreement_price', 'client_billing_status'] loop
    if (select coalesce(reloptions::text, '') not like '%security_invoker=true%' from pg_class
        where oid = ('public.' || t)::regclass) then
      raise exception '0058: view % must run with the caller''s rights', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete') then
      raise exception '0058: view % grants more than authenticated SELECT', t;
    end if;
  end loop;
  foreach t in array array['service_catalog', 'billing_packages', 'billing_package_prices',
    'billing_one_time_items', 'package_entitlements'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT'
               and coalesce(with_check, qual) not like '%is_team_admin()%') then
      raise exception '0058: the catalog table % is writable by a non-admin', t;
    end if;
  end loop;
  if exists (select 1 from cron.job where jobname = 'billing-daily-past-due') then
    raise exception '0058: the Compass past-due sweep is still scheduled';
  end if;
end $$;
