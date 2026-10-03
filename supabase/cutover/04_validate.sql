-- Billing cutover, step 4: prove every active client is represented before
-- automation resumes. After 02_agreements.sql all eight current clients (four
-- active, four launching) are on Compass Standard with structured agreed
-- terms, so this passes with no exclusions.
--
-- Raises (stops the cutover) when an active client has no agreement, or when
-- any non-offboarded client's Stripe-collected agreement has no structured
-- agreed price (amount, currency, interval). Checkout readiness (an exact
-- approved Stripe Price bound to that price) is reported, never raised: in a
-- TEST MODE cutover Compass Standard stays unmapped and no real client's
-- Checkout is allowed; the fictional test client is bound afterwards
-- (06_bind_test_client_price.sql) before its lifecycle runs. Raises (and stops the cutover) if an active client has
-- no agreement — unless it is deliberately excluded by listing its id in the
-- session setting first:
--   set compass.cutover_excluded = '{<uuid>,<uuid>}';
do $$
declare v_missing text; v_excluded uuid[];
begin
  v_excluded := coalesce(nullif(current_setting('compass.cutover_excluded', true), '')::uuid[], '{}');
  select string_agg(c.name || ' (' || c.id || ')', ', ' order by c.name) into v_missing
  from clients c
  where c.status = 'active'
    and not exists (select 1 from plans p where p.client_id = c.id and p.package_id is not null)
    and not exists (select 1 from client_entitlement_overrides o where o.client_id = c.id)
    and c.id <> all (v_excluded);
  if v_missing is not null then
    raise exception 'cutover: active client(s) with no agreement: %', v_missing;
  end if;
  select string_agg(c.name || ' (' || c.id || ')', ', ' order by c.name) into v_missing
  from clients c join plans p on p.client_id = c.id
  where c.status <> 'offboarded' and p.package_id is not null and p.collection = 'stripe'
    and (p.agreed_amount_cents is null or p.agreed_currency is null or p.agreed_billing_interval is null
         or p.agreed_billing_interval_count is null)
    and c.id <> all (v_excluded);
  if v_missing is not null then
    raise exception 'cutover: Stripe-collected agreement(s) with no agreed price: %', v_missing;
  end if;
  if exists (select 1 from client_entitlements_for(null) limit 1) is not true then
    raise exception 'cutover: client_entitlements_for() returned nothing';
  end if;
end $$;

-- Launching clients with no agreement (not planned for yet; they will be
-- planned for only within an agreement once they become active).
select c.name as launching_without_agreement
from clients c
where c.status = 'launching' and not exists (select 1 from plans p where p.client_id = c.id and p.package_id is not null)
order by c.name;

-- Checkout readiness per Stripe-collected agreement (reports, never raises):
-- the agreed price, and whether an exact approved Stripe Price of the
-- agreement's own package, in the current mode, is bound to it. 'unmapped' is
-- expected for the eight real clients in a TEST MODE cutover (their live
-- prices do not exist yet); Checkout refuses them until 07 binds them in live
-- mode.
select c.name, c.status, bp.name as package,
       ap.agreed_amount_cents, ap.agreed_currency, ap.agreed_billing_interval, ap.agreed_billing_interval_count,
       ap.price_status,
       case when ap.price_status = 'ready' then 'checkout ready'
            else 'checkout refused (' || ap.price_status || ')' end as checkout
from client_agreement_price ap
join clients c on c.id = ap.client_id
join billing_packages bp on bp.id = ap.package_id
where ap.collection = 'stripe' and c.status <> 'offboarded'
order by c.name;

-- Compass Standard: the agreements at each agreed price, and the live prices
-- mapped for them (none until the live $650 / $500 Prices exist).
select bp.name as package,
       count(*) filter (where pl.agreed_amount_cents = 65000) as agreements_at_650,
       count(*) filter (where pl.agreed_amount_cents = 50000) as agreements_at_500,
       count(*) filter (where pl.billing_package_price_id is not null) as agreements_bound,
       coalesce(bp.stripe_product_id, 'no Stripe product mapped') as stripe_product,
       (select string_agg(sp.stripe_price_id || ' ' || sp.currency || ' ' || (sp.unit_amount_cents / 100.0)::numeric(10,2)
                          || '/' || sp.recurring_interval || case when bpp.is_default then ' (default)' else '' end
                          || case when sp.livemode then ' live' else ' test' end, '; ' order by bpp.is_default desc, sp.unit_amount_cents desc)
          from billing_package_prices bpp join stripe_prices sp on sp.stripe_price_id = bpp.stripe_price_id
         where bpp.package_id = bp.id and bpp.active and sp.active) as approved_prices
from billing_packages bp
left join plans pl on pl.package_id = bp.id
where bp.key = 'compass_standard'
group by bp.id, bp.name, bp.stripe_product_id;

-- Every non-offboarded client: what is included.
select c.name, c.status, e.service_key, e.kind, e.enabled, e.quantity, e.source
from clients c cross join lateral client_entitlements_for(c.id) e
where c.status <> 'offboarded' and (e.enabled or e.kind = 'quota')
order by c.name, e.sort_order;

-- This month's allocation, and what the planners will do next.
select c.name, u.service_key, u.allocation, u.completed, u.planned, u.remaining, u.over_allocation
from clients c cross join lateral client_quota_usage(c.id) u
where c.status = 'active'
order by c.name, u.service_key;

select c.name,
       case when b.allocation = 0 then 'weekly blog: not in agreement'
            when b.remaining = 0 then 'weekly blog: allocation used this month'
            else 'weekly blog: will plan (' || b.remaining || ' left)' end as weekly_blog,
       case when not coalesce(w.enabled, false) then 'website updates: website not included'
            when coalesce(pg.allocation, 0) + coalesce(rf.allocation, 0) = 0 then 'website updates: no pages or refreshes'
            else 'website updates: will fire (' || (coalesce(pg.remaining, 0) + coalesce(rf.remaining, 0)) || ' left)' end as website_updates
from clients c
left join lateral (select * from client_quota_usage(c.id) where service_key = 'blog_posts') b on true
left join lateral (select * from client_quota_usage(c.id) where service_key = 'website_pages') pg on true
left join lateral (select * from client_quota_usage(c.id) where service_key = 'website_refreshes') rf on true
left join lateral (select enabled from client_entitlements_for(c.id) where service_key = 'website') w on true
where c.status = 'active'
order by c.name;
