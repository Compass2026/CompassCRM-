-- Billing cutover, step 2: the Compass Standard package and the eight
-- confirmed client agreements (terms confirmed by Tom, October 2026;
-- docs/billing-agreement-inventory.md is the record).
--
-- One package, one entitlement definition, eight agreements. Every client is
-- on Compass Standard, month-to-month from 2026-10-01, collected by Stripe
-- (ACH debit). Two prices exist commercially for the same package: $650/month
-- (the default) and $500/month (legacy, grandfathered for BHG Safety Partners
-- and Shewmaker Brothers Masonry). The price is Stripe's, not the CRM's:
-- plans has no price column, so each agreement names its agreed price in
-- notes, and the two Stripe Prices are mapped to this one package later (see
-- "Stripe prices" at the end). Nothing here touches Stripe.
--
-- One statement, so all or nothing. Safe to re-run: every insert is on
-- conflict do nothing, and the check at the end raises (undoing everything
-- this run wrote) unless the package, its entitlements and all eight
-- agreements are exactly as confirmed. It never overwrites a different
-- existing package or agreement; it refuses instead.
--
-- Run as postgres (execute_sql / SQL editor) after 0058 – 0062 and before
-- 04_validate.sql. Run this way, client_agreement_events records the eight
-- inserts with no actor (the app would record the teammate).

do $$
declare
  -- The confirmed terms. price = the agreed monthly price in dollars.
  v_agreements constant jsonb := '[
    {"client_id": "3eaa3389-2a33-4004-837c-8aef90404410", "name": "BHG Safety Partners",         "price": 500},
    {"client_id": "a88f5ce2-30ac-508b-b217-cf22d277b278", "name": "Shewmaker Brothers Masonry",  "price": 500},
    {"client_id": "70211d71-d9f4-46ab-abe2-ef39c41591fb", "name": "Logic Solar",                 "price": 650},
    {"client_id": "d94cfde2-0751-4002-a149-c83b4c6c956d", "name": "Show Me Design",              "price": 650},
    {"client_id": "9a8e05f5-3d28-4839-9735-79bcdd0e277d", "name": "Show Me Electrical",          "price": 650},
    {"client_id": "102d3b20-2795-44ae-bd64-d1e43916291c", "name": "Lucas Construction",          "price": 650},
    {"client_id": "db9009c2-a04b-4e93-843f-e20c49263b5b", "name": "Ginger Huff Interiors",       "price": 650},
    {"client_id": "1e12fc47-731a-4d84-a4f1-4aed777db451", "name": "Pensacola Equipment Rentals", "price": 650}
  ]';
  -- One entitlement definition for the package, whichever price a client pays.
  -- Features: on, no quantity. Quotas: per month.
  v_entitlements constant jsonb := '[
    {"key": "website",           "kind": "feature", "qty": null},
    {"key": "hosting",           "kind": "feature", "qty": null},
    {"key": "seo",               "kind": "feature", "qty": null},
    {"key": "gbp",               "kind": "feature", "qty": null},
    {"key": "social",            "kind": "feature", "qty": null},
    {"key": "paid_ads",          "kind": "feature", "qty": null},
    {"key": "crm",               "kind": "feature", "qty": null},
    {"key": "reporting",         "kind": "feature", "qty": null},
    {"key": "client_portal",     "kind": "feature", "qty": null},
    {"key": "blog_posts",        "kind": "quota",   "qty": 8},
    {"key": "gbp_posts",         "kind": "quota",   "qty": 8},
    {"key": "social_posts",      "kind": "quota",   "qty": 8},
    {"key": "website_pages",     "kind": "quota",   "qty": 4},
    {"key": "website_refreshes", "kind": "quota",   "qty": 1}
  ]';
  v_pkg uuid;
  v_text text;
begin
  -- ── Guard: every client exists and is not offboarded ──────────────────────
  select string_agg(a.name || ' (' || a.client_id || ')', ', ' order by a.name) into v_text
  from jsonb_to_recordset(v_agreements) a(client_id uuid, name text, price int)
  where not exists (select 1 from clients c where c.id = a.client_id and c.status <> 'offboarded');
  if v_text is not null then
    raise exception 'agreements: client(s) missing or offboarded: %', v_text;
  end if;

  -- ── The package ───────────────────────────────────────────────────────────
  -- Unmapped to Stripe here (stripe_product_id null): the live Compass
  -- Standard product and its two prices do not exist yet. The Stripe TEST
  -- product is mapped to the test client's own package (03), never this one.
  insert into billing_packages (key, name, kind, description, sort_order)
  values ('compass_standard', 'Compass Standard', 'standard',
          'The standard Compass retainer. Default price $650/month; legacy price $500/month '
          || '(grandfathered). Same entitlements at either price. Month-to-month.', 0)
  on conflict (key) do nothing;
  select id into v_pkg from billing_packages
  where key = 'compass_standard' and name = 'Compass Standard' and kind = 'standard' and active;
  if v_pkg is null then
    raise exception 'agreements: a compass_standard package exists but is renamed, not standard or inactive';
  end if;

  -- ── What it includes ──────────────────────────────────────────────────────
  insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity)
  select v_pkg, e.key, e.kind, true, e.qty
  from jsonb_to_recordset(v_entitlements) e(key text, kind text, qty int)
  on conflict (package_id, service_key) do nothing;

  -- ── The eight agreements ──────────────────────────────────────────────────
  -- term_months null = month-to-month (no fixed term, no renewal date).
  -- No overrides: every client receives exactly the package.
  insert into plans (client_id, package_id, collection, term_months, start_date, notes)
  select a.client_id, v_pkg, 'stripe', null, date '2026-10-01',
         case a.price
           when 650 then 'Compass Standard at the default price, $650.00/month. '
           else 'Compass Standard at the legacy price, $500.00/month (grandfathered; '
                || 'same package and entitlements as the $650 default). '
         end
         || 'Month-to-month from 2026-10-01. Collected by Stripe (ACH debit). '
         || 'Terms confirmed by Tom, October 2026.'
  from jsonb_to_recordset(v_agreements) a(client_id uuid, name text, price int)
  on conflict (client_id) do nothing;

  -- ── Check: exactly as confirmed, or nothing is kept ───────────────────────
  select string_agg(x, ', ') into v_text from (
    select e.key || coalesce(' has ' || case when pe.enabled then coalesce(pe.quantity::text, 'on') else 'off' end, ' is missing') x
    from jsonb_to_recordset(v_entitlements) e(key text, kind text, qty int)
    left join package_entitlements pe on pe.package_id = v_pkg and pe.service_key = e.key
    where pe.service_key is null or not pe.enabled or pe.quantity is distinct from e.qty
    union all
    select pe.service_key || ' is not in the confirmed definition'
    from package_entitlements pe
    where pe.package_id = v_pkg
      and pe.service_key not in (select e.key from jsonb_to_recordset(v_entitlements) e(key text, kind text, qty int))) d;
  if v_text is not null then
    raise exception 'agreements: compass_standard entitlements differ from the confirmed definition (left unchanged; resolve by hand): %', v_text;
  end if;

  select string_agg(a.name, ', ' order by a.name) into v_text
  from jsonb_to_recordset(v_agreements) a(client_id uuid, name text, price int)
  left join plans pl on pl.client_id = a.client_id
  where pl.id is null
     or pl.package_id is distinct from v_pkg
     or pl.collection <> 'stripe'
     or pl.external_method is not null
     or pl.term_months is not null
     or pl.renewal_date is not null
     or pl.start_date is distinct from date '2026-10-01'
     or pl.notes is null
     or pl.notes not like 'Compass Standard at the '
          || case a.price when 650 then 'default price, $650.00/month' else 'legacy price, $500.00/month' end || '%'
     or exists (select 1 from client_entitlement_overrides o where o.client_id = a.client_id);
  if v_text is not null then
    raise exception 'agreements: existing agreement differs from the confirmed terms (left unchanged; resolve by hand): %', v_text;
  end if;
end $$;

-- What was recorded.
select c.name, c.status, bp.name as package, pl.collection, pl.start_date,
       coalesce(pl.term_months::text, 'month-to-month') as term, pl.notes
from plans pl join clients c on c.id = pl.client_id join billing_packages bp on bp.id = pl.package_id
where bp.key = 'compass_standard'
order by c.name;

-- ── Stripe prices (NOT done here; production preconditions) ──────────────────
-- The live Compass Standard Product and its two Prices do not exist yet. Once
-- they are created in the Stripe LIVE account (only after the Option B billing
-- runtime exists — docs/billing-readiness.md), an admin maps them in the app,
-- Settings › Billing catalog, which writes billing_packages.stripe_product_id
-- and billing_package_prices through the Stripe mirror:
--
--   Compass Standard (LIVE) product   <<LIVE_STANDARD_PRODUCT_ID — not created>>
--     default price  $650.00 / month  <<LIVE_STANDARD_650_PRICE_ID — not created>>  is_default = true
--     legacy price   $500.00 / month  <<LIVE_STANDARD_500_PRICE_ID — not created>>  is_default = false
--
-- Both prices map to this one package, so both give the same entitlements.
-- Checkout lets the teammate choose an approved price of the client's package;
-- BHG Safety Partners and Shewmaker Brothers Masonry must be sent the $500
-- legacy price, everyone else the $650 default (the agreement's notes say
-- which). Do not invent these ids and do not map the TEST product here.
