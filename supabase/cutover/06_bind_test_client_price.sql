-- Billing cutover, step 6 (TEST MODE): bind the fictional test client's
-- agreement to the exact Stripe TEST Price, so its Checkout lifecycle runs
-- through the same agreement-price enforcement live billing will use.
--
-- Run after § 17 step 11 has imported Tom's TEST product onto the test
-- client's package in the app (Settings › Billing catalog: import
-- prod_VMxmkG052epGVU onto "Test Standard (TEST)" and approve
-- price_1UMDr54Zq9yMk653B7jdneFm). Test-mode object ids, not secrets.
-- Equivalent in the app: the test client's Plan tab › Agreed price › Bind price.
--
-- Refuses (writing nothing) unless billing is in test mode and that exact
-- price is an approved, active, $2,500.00/month USD price of the test
-- client's package; plans_agreement_price_guard re-checks all of it.
-- Idempotent.
do $$
declare
  v_client constant uuid := 'c0ffee00-0000-4000-b000-00000000b111';
  v_package constant uuid := 'c0ffee00-0000-4000-c000-00000000b111';
  v_price constant text := 'price_1UMDr54Zq9yMk653B7jdneFm';
  v_mapping uuid;
  v_status text;
begin
  if billing_livemode() then
    raise exception 'test client price: billing is in live mode; this binds a TEST price only';
  end if;
  select bpp.id into v_mapping
  from billing_package_prices bpp
  join stripe_prices sp on sp.stripe_price_id = bpp.stripe_price_id
  where bpp.stripe_price_id = v_price and bpp.package_id = v_package and bpp.active
    and sp.active and not sp.livemode and sp.unit_amount_cents = 250000 and sp.currency = 'usd'
    and sp.recurring_interval = 'month' and sp.recurring_interval_count = 1;
  if v_mapping is null then
    raise exception 'test client price: % is not yet an approved $2,500.00/month TEST price of Test Standard (TEST); import and approve it first (Settings › Billing catalog)', v_price;
  end if;
  update plans set billing_package_price_id = v_mapping
  where client_id = v_client and billing_package_price_id is distinct from v_mapping;
  select price_status into v_status from client_agreement_price where client_id = v_client;
  if v_status is distinct from 'ready' then
    raise exception 'test client price: the agreement is % after binding, not ready', v_status;
  end if;
end $$;

select c.name, ap.agreed_amount_cents, ap.agreed_currency, ap.agreed_billing_interval, ap.stripe_price_id, ap.price_status
from client_agreement_price ap join clients c on c.id = ap.client_id
where ap.client_id = 'c0ffee00-0000-4000-b000-00000000b111';
