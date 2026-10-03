-- LIVE MODE ONLY — not part of the test-mode cutover. Run only after:
--   1. Option B (the dedicated live billing runtime) is built and approved;
--   2. the live Compass Standard Product and its two monthly Prices exist in
--      Stripe ($650.00 default, $500.00 legacy) and an admin has mapped both
--      to the Compass Standard package (Settings › Billing catalog);
--   3. an admin has switched billing to live mode.
--
-- Binds each of the eight confirmed agreements (02_agreements.sql) to the one
-- live Compass Standard price that says exactly its agreed terms — BHG Safety
-- Partners and Shewmaker Brothers Masonry to the $500 legacy price, the other
-- six to the $650 default — found by amount, currency and interval. No Stripe
-- id is typed by hand. Only then may Checkout run for these clients.
--
-- All or nothing; refuses unless billing is live and each agreement has
-- exactly one matching approved price. plans_agreement_price_guard re-checks
-- every binding. Idempotent.
do $$
declare
  v_pkg uuid;
  v_missing text;
  v_ambiguous text;
  v_bad text;
begin
  if not billing_livemode() then
    raise exception 'live binding: billing is in test mode; the live Compass Standard prices are bound only in live mode (after Option B)';
  end if;
  select id into v_pkg from billing_packages where key = 'compass_standard' and active;
  if v_pkg is null then
    raise exception 'live binding: no active compass_standard package (run 02_agreements.sql first)';
  end if;

  create temporary table live_bind on commit drop as
  select pl.client_id, c.name, pl.agreed_amount_cents,
         (select array_agg(bpp.id) from billing_package_prices bpp
            join stripe_prices sp on sp.stripe_price_id = bpp.stripe_price_id
           where bpp.package_id = v_pkg and bpp.active and bpp.client_id is null
             and sp.livemode and sp.active and sp.deleted_at is null and sp.type = 'recurring'
             and sp.billing_scheme = 'per_unit' and coalesce(sp.recurring_usage_type, 'licensed') = 'licensed'
             and sp.unit_amount_cents = pl.agreed_amount_cents and sp.currency = pl.agreed_currency
             and sp.recurring_interval = pl.agreed_billing_interval
             and sp.recurring_interval_count = pl.agreed_billing_interval_count) as matches
  from plans pl join clients c on c.id = pl.client_id
  where pl.package_id = v_pkg and pl.collection = 'stripe' and pl.agreed_amount_cents is not null
    and c.status <> 'offboarded';

  select string_agg(name || ' ($' || (agreed_amount_cents / 100) || ')', ', ' order by name) into v_missing
  from live_bind where matches is null;
  if v_missing is not null then
    raise exception 'live binding: no approved live Compass Standard price matches: %', v_missing;
  end if;
  select string_agg(name, ', ' order by name) into v_ambiguous from live_bind where cardinality(matches) > 1;
  if v_ambiguous is not null then
    raise exception 'live binding: more than one approved live price matches (retire the duplicate first): %', v_ambiguous;
  end if;

  update plans pl set billing_package_price_id = lb.matches[1]
  from live_bind lb
  where pl.client_id = lb.client_id and pl.billing_package_price_id is distinct from lb.matches[1];

  select string_agg(c.name || ' (' || ap.price_status || ')', ', ' order by c.name) into v_bad
  from live_bind lb join client_agreement_price ap on ap.client_id = lb.client_id join clients c on c.id = lb.client_id
  where ap.price_status <> 'ready';
  if v_bad is not null then
    raise exception 'live binding: not ready after binding: %', v_bad;
  end if;
end $$;

select c.name, ap.agreed_amount_cents, ap.price_amount_cents, ap.price_livemode, ap.price_status
from client_agreement_price ap join clients c on c.id = ap.client_id
join plans pl on pl.client_id = ap.client_id join billing_packages bp on bp.id = pl.package_id
where bp.key = 'compass_standard'
order by c.name;
