-- The agreement binds the client to its exact recurring price (0058:
-- plans.agreed_* + billing_package_price_id, plans_agreement_price_guard,
-- client_agreement_price, the agreement_price_* attention signals; 0062: the
-- portal's plan price). One package with two prices — a $650 default and a
-- $500 legacy — sells each client exactly the price its agreement names.
-- Run by scripts/test-portal-sandbox.sh after the other billing suites. Own
-- harness schema (ap), fictional clients and Stripe ids. Mirror rows are
-- loaded as the cluster superuser (Stripe sync is billing_sync.test.sql).

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set member '00000000-0000-4000-a000-0000000000e7'

\o /dev/null
create schema agp;
create table agp.results (n serial, status text, name text, detail text);
create table agp.saved (k text primary key, v text);
grant usage on schema agp to anon, authenticated, service_role, authenticator;
grant insert, select on agp.results to anon, authenticated, service_role, authenticator;
grant usage on sequence agp.results_n_seq to anon, authenticated, service_role, authenticator;
create function agp.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into agp.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function agp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function agp.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function agp.id(p_k text) returns uuid language sql immutable as $$ select md5('ap:' || p_k)::uuid $$;
create function agp.status(p_client uuid) returns text language sql stable as $$
  select price_status from client_agreement_price where client_id = p_client
$$;
create function agp.reasons(p_client uuid) returns jsonb language sql stable as $$
  select to_jsonb(attention_reasons) from client_billing_status where client_id = p_client
$$;
grant execute on all functions in schema agp to anon, authenticated, service_role, authenticator;

-- ── Fixtures (fictional), as the worker ─────────────────────────────────────
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000e7', 'sandbox-price-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000e7', 'Price Member', 'sandbox-price-member@compassmarketing.ai', 'member');
insert into clients (id, name, city, state, status) values
  (agp.id('legacy'), 'Legacy Masonry (fictional)', 'Rolla', 'MO', 'active'),
  (agp.id('default'), 'Default Solar (fictional)', 'Columbia', 'MO', 'active'),
  (agp.id('other'), 'Other Electric (fictional)', 'Joplin', 'MO', 'active'),
  (agp.id('unbound'), 'Unbound Roofing (fictional)', 'Wentzville', 'MO', 'active');

\c - supabase_admin
insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values
  ('prod_ApStd', false, 'Standard package (fictional)', true, now()),
  ('prod_ApOther', false, 'Another package (fictional)', true, now()),
  ('prod_ApLive', true, 'Standard live (fictional)', true, now()),
  ('prod_ApCustom', false, 'Custom Retainer (fictional)', true, now());
insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency, unit_amount_cents,
    billing_scheme, recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at) values
  ('price_Ap650', 'prod_ApStd', false, true, 'recurring', 'usd', 65000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_Ap500', 'prod_ApStd', false, true, 'recurring', 'usd', 50000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_ApYear', 'prod_ApStd', false, true, 'recurring', 'usd', 65000, 'per_unit', 'year', 1, 'licensed', now()),
  ('price_ApQtr', 'prod_ApStd', false, true, 'recurring', 'usd', 65000, 'per_unit', 'month', 3, 'licensed', now()),
  ('price_ApCad', 'prod_ApStd', false, true, 'recurring', 'cad', 65000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_ApArchived', 'prod_ApStd', false, false, 'recurring', 'usd', 65000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_ApTiered', 'prod_ApStd', false, true, 'recurring', 'usd', null, 'tiered', 'month', 1, 'licensed', now()),
  ('price_ApOther650', 'prod_ApOther', false, true, 'recurring', 'usd', 65000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_ApLive650', 'prod_ApLive', true, true, 'recurring', 'usd', 65000, 'per_unit', 'month', 1, 'licensed', now()),
  ('price_ApCustomOther', 'prod_ApCustom', false, true, 'recurring', 'usd', 65000, 'per_unit', 'month', 1, 'licensed', now());
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values
  (agp.id('default'), 'cus_ApDefault', false, 'created', now()),
  (agp.id('unbound'), 'cus_ApUnbound', false, 'created', now());

\c - postgres
insert into billing_packages (id, key, name, kind, stripe_product_id) values
  (agp.id('std'), 'ap_standard', 'Standard package (fictional)', 'standard', 'prod_ApStd'),
  (agp.id('pkg_other'), 'ap_other', 'Another package (fictional)', 'standard', 'prod_ApOther'),
  (agp.id('pkg_live'), 'ap_live', 'Standard live (fictional)', 'standard', 'prod_ApLive'),
  (agp.id('pkg_custom'), 'ap_custom', 'Custom Retainer (fictional)', 'custom', 'prod_ApCustom');
insert into billing_package_prices (id, package_id, package_kind, stripe_product_id, stripe_price_id, client_id, is_default) values
  (agp.id('pp650'), agp.id('std'), 'standard', 'prod_ApStd', 'price_Ap650', null, true),
  (agp.id('pp500'), agp.id('std'), 'standard', 'prod_ApStd', 'price_Ap500', null, false),
  (agp.id('ppYear'), agp.id('std'), 'standard', 'prod_ApStd', 'price_ApYear', null, false),
  (agp.id('ppQtr'), agp.id('std'), 'standard', 'prod_ApStd', 'price_ApQtr', null, false),
  (agp.id('ppCad'), agp.id('std'), 'standard', 'prod_ApStd', 'price_ApCad', null, false),
  (agp.id('ppArchived'), agp.id('std'), 'standard', 'prod_ApStd', 'price_ApArchived', null, false),
  (agp.id('ppTiered'), agp.id('std'), 'standard', 'prod_ApStd', 'price_ApTiered', null, false),
  (agp.id('ppOther'), agp.id('pkg_other'), 'standard', 'prod_ApOther', 'price_ApOther650', null, true),
  (agp.id('ppLive'), agp.id('pkg_live'), 'standard', 'prod_ApLive', 'price_ApLive650', null, true),
  (agp.id('ppCustomOther'), agp.id('pkg_custom'), 'custom', 'prod_ApCustom', 'price_ApCustomOther', agp.id('other'), false);
insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  (agp.id('std'), 'seo', 'feature', true, null), (agp.id('std'), 'blog_posts', 'quota', true, 8);

-- ── S. Structure ─────────────────────────────────────────────────────────────
do $$
begin
  perform agp.ok('S1 plans carries the contracted recurring terms and the exact package price, in integer minor units',
    (select count(*) from information_schema.columns where table_name = 'plans' and column_name in
      ('agreed_amount_cents', 'agreed_currency', 'agreed_billing_interval', 'agreed_billing_interval_count', 'billing_package_price_id')) = 5
    and (select data_type from information_schema.columns where table_name = 'plans' and column_name = 'agreed_amount_cents') = 'bigint');
  perform agp.ok('S2 the bound price is constrained to the agreement''s own package (composite foreign key)',
    exists (select 1 from pg_constraint where conname = 'plans_price_of_package' and contype = 'f'
            and pg_get_constraintdef(oid) like '%(billing_package_price_id, package_id)%billing_package_prices(id, package_id)%'));
  perform agp.ok('S3 the guard is a trigger function nobody can call through the API',
    not has_function_privilege('authenticated', 'plans_agreement_price_guard()', 'execute')
    and not has_function_privilege('anon', 'plans_agreement_price_guard()', 'execute'));
  perform agp.ok('S4 client_agreement_price runs with the caller''s rights and is read-only through the API',
    (select coalesce(reloptions::text, '') like '%security_invoker=true%' from pg_class where oid = 'public.client_agreement_price'::regclass)
    and not has_table_privilege('anon', 'public.client_agreement_price', 'select')
    and not has_table_privilege('authenticated', 'public.client_agreement_price', 'insert,update,delete'));
end $$;

-- ── T. The agreed terms, as the database enforces them (no signed-in user) ──
do $$
declare e text;
begin
  e := agp.try(format($q$insert into plans (client_id, package_id, collection, agreed_amount_cents) values (%L, %L, 'stripe', 65000)$q$,
    agp.id('default'), agp.id('std')));
  perform agp.ok('T1 the agreed terms are all four or none', e like '23514%plans_agreed_terms%', e);
  e := agp.try(format($q$insert into plans (client_id, package_id, collection, external_method, external_amount_cents, external_currency,
      external_interval, agreed_amount_cents, agreed_currency, agreed_billing_interval, agreed_billing_interval_count)
      values (%L, %L, 'external', 'check', 65000, 'usd', 'month', 65000, 'usd', 'month', 1)$q$, agp.id('default'), agp.id('std')));
  perform agp.ok('T2 an external arrangement keeps its external terms and takes no agreed Stripe price', e like '23514%plans_agreed_terms_stripe_only%', e);
  e := agp.try(format($q$insert into plans (client_id, package_id, collection, billing_package_price_id) values (%L, %L, 'stripe', %L)$q$,
    agp.id('default'), agp.id('std'), agp.id('pp650')));
  perform agp.ok('T3 a Stripe Price cannot be bound without the agreed terms', e like '23514%plans_price_needs_terms%', e);
  e := agp.try(format($q$insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
      agreed_billing_interval_count) values (%L, %L, 'stripe', 0, 'usd', 'month', 1)$q$, agp.id('default'), agp.id('std')));
  perform agp.ok('T4 an agreed amount is positive', e like '23514%', e);
  e := agp.try(format($q$insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
      agreed_billing_interval_count) values (%L, %L, 'stripe', 65000, 'usd', 'week', 1)$q$, agp.id('default'), agp.id('std')));
  perform agp.ok('T5 an agreed interval is month or year', e like '23514%', e);

  -- The two real shapes: $500 legacy and $650 default, on the same package.
  insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
      agreed_billing_interval_count, start_date) values
    (agp.id('legacy'), agp.id('std'), 'stripe', 50000, 'usd', 'month', 1, '2026-10-01'),
    (agp.id('default'), agp.id('std'), 'stripe', 65000, 'usd', 'month', 1, '2026-10-01'),
    (agp.id('unbound'), agp.id('std'), 'stripe', 65000, 'usd', 'month', 1, '2026-10-01');
  perform agp.ok('T6 agreements with agreed terms and no price yet are unmapped, not ready',
    agp.status(agp.id('legacy')) = 'unmapped' and agp.status(agp.id('default')) = 'unmapped');
end $$;

-- ── B. Binding: exactly the agreed price of the agreement's own package ─────
do $$
declare e text;
begin
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('pp650'), agp.id('legacy')));
  perform agp.ok('B1 the $500 legacy agreement cannot be bound to the $650 price', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('pp500'), agp.id('default')));
  perform agp.ok('B2 the $650 default agreement cannot be bound to the $500 price', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppCad'), agp.id('default')));
  perform agp.ok('B3 a price in another currency is refused', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppYear'), agp.id('default')));
  perform agp.ok('B4 a price with another interval is refused', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppQtr'), agp.id('default')));
  perform agp.ok('B5 a price with another interval count is refused', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppArchived'), agp.id('default')));
  perform agp.ok('B6 an archived Stripe Price is refused', e like '23514%retired or archived%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppTiered'), agp.id('default')));
  perform agp.ok('B7 a tiered (not fixed-amount) price is refused', e like '23514%fixed-amount%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('ppOther'), agp.id('default')));
  perform agp.ok('B8 a price of another package is refused by the foreign key', e like '23503%plans_price_of_package%', e);
  e := agp.try(format($q$update plans set package_id = %L, billing_package_price_id = %L where client_id = %L$q$,
    agp.id('pkg_live'), agp.id('ppLive'), agp.id('default')));
  perform agp.ok('B9 a live price is refused while billing is in test mode', e like '23514%live price; billing is in test mode%', e);
  e := agp.try(format($q$update plans set package_id = %L, billing_package_price_id = %L where client_id = %L$q$,
    agp.id('pkg_custom'), agp.id('ppCustomOther'), agp.id('default')));
  perform agp.ok('B10 a custom price reserved for another client is refused', e like '23514%reserved for another client%', e);
  perform agp.ok('B11 every refusal left both agreements unbound and unchanged',
    (select count(*) from plans where client_id in (agp.id('legacy'), agp.id('default')) and billing_package_price_id is null
       and package_id = agp.id('std')) = 2);

  update plans set billing_package_price_id = agp.id('pp500') where client_id = agp.id('legacy');
  update plans set billing_package_price_id = agp.id('pp650') where client_id = agp.id('default');
  perform agp.ok('B12 the $500 legacy agreement binds the $500 price; the $650 default agreement binds the $650 price; both ready',
    agp.status(agp.id('legacy')) = 'ready' and agp.status(agp.id('default')) = 'ready'
    and (select stripe_price_id from client_agreement_price where client_id = agp.id('legacy')) = 'price_Ap500'
    and (select stripe_price_id from client_agreement_price where client_id = agp.id('default')) = 'price_Ap650');
  perform agp.ok('B13 one package, one entitlement definition: both clients receive exactly the same, whatever they pay',
    (select jsonb_agg(to_jsonb(x) - 'client_id' order by x.service_key) from client_entitlements_for(agp.id('legacy')) x)
    = (select jsonb_agg(to_jsonb(x) - 'client_id' order by x.service_key) from client_entitlements_for(agp.id('default')) x));

  e := agp.try(format($q$update plans set agreed_amount_cents = 65000 where client_id = %L$q$, agp.id('legacy')));
  perform agp.ok('B14 the agreed amount cannot drift from the bound price', e like '23514%differs from the agreement%', e);
  e := agp.try(format($q$update plans set package_id = %L where client_id = %L$q$, agp.id('pkg_other'), agp.id('legacy')));
  perform agp.ok('B15 the package cannot change under a bound price', e like '23503%', e);
  e := agp.try(format($q$delete from billing_package_prices where id = %L$q$, agp.id('pp500')));
  perform agp.ok('B16 a bound package price cannot be deleted', e like '23503%', e);
  e := agp.try(format($q$update plans set notes = 'Contract signed.', term_months = null where client_id = %L$q$, agp.id('legacy')));
  perform agp.ok('B17 editing anything else of a bound agreement needs no re-binding', e is null, e);
end $$;

-- ── R. Readiness and attention (configuration, never financial state) ───────
do $$
begin
  update billing_package_prices set active = false where id = agp.id('pp650');
  perform agp.ok('R1 a retired mapping makes the agreement inactive (Checkout refuses)', agp.status(agp.id('default')) = 'inactive');
  update billing_package_prices set active = true where id = agp.id('pp650');
  perform agp.ok('R2 ...and ready again once restored', agp.status(agp.id('default')) = 'ready');
  insert into app_settings (key, value) values ('billing', '{"livemode": true}') on conflict (key) do update set value = excluded.value;
  perform agp.ok('R3 in live mode a binding to a test price is wrong_mode', agp.status(agp.id('default')) = 'wrong_mode');
  delete from app_settings where key = 'billing';
  perform agp.ok('R4a a client with no agreement is not_applicable',
    (select price_status from client_agreement_price where client_id = agp.id('other')) = 'not_applicable');
  insert into plans (client_id, package_id, collection) values (agp.id('other'), agp.id('std'), 'stripe');
  perform agp.ok('R4b a Stripe-collected agreement with no agreed price is terms_missing', agp.status(agp.id('other')) = 'terms_missing');
  update plans set collection = 'external', external_method = 'check', external_amount_cents = 65000, external_currency = 'usd',
    external_interval = 'month' where client_id = agp.id('other');
  perform agp.ok('R4c an external arrangement is not_applicable (its terms are the external ones)', agp.status(agp.id('other')) = 'not_applicable');
  update plans set collection = 'stripe', external_method = null, external_amount_cents = null, external_currency = null,
    external_interval = null, agreed_amount_cents = 65000, agreed_currency = 'usd', agreed_billing_interval = 'month',
    agreed_billing_interval_count = 1 where client_id = agp.id('other');
  perform agp.ok('R5 a linked customer with no bound price raises agreement_price_unmapped',
    agp.reasons(agp.id('unbound')) @> '["agreement_price_unmapped"]');
  perform agp.ok('R6 ...a bound, matching agreement raises nothing',
    not (agp.reasons(agp.id('default')) @> '["agreement_price_unmapped"]')
    and not (agp.reasons(agp.id('default')) @> '["agreement_price_mismatch"]'));
  perform agp.ok('R7 ...and an unbound agreement with no billing under way is not flagged (the test-mode cutover state)',
    agp.status(agp.id('other')) = 'unmapped'
    and not (agp.reasons(agp.id('other')) ?| array['agreement_price_unmapped', 'agreement_price_mismatch']));
end $$;

\c - supabase_admin
-- The live subscription Stripe holds sells $500 while the agreement says $650.
insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status,
    collection_method, currency, current_period_start, current_period_end, stripe_created_at, stripe_synced_at)
values (agp.id('default'), 'cus_ApDefault', 'sub_ApDefault', false, 'active', 'charge_automatically', 'usd',
        '2026-10-01', '2026-11-01', '2026-10-01', now());
insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
select id, client_id, 'si_ApDefault', 'price_Ap500', 1, now() from subscriptions where stripe_subscription_id = 'sub_ApDefault';
\c - postgres
do $$
begin
  perform agp.ok('R8 a live subscription selling a price other than the agreement''s raises agreement_price_mismatch',
    agp.reasons(agp.id('default')) @> '["agreement_price_mismatch"]');
  perform agp.ok('R9 ...without changing the agreement, its price or the entitlements',
    (select agreed_amount_cents from plans where client_id = agp.id('default')) = 65000
    and agp.status(agp.id('default')) = 'ready'
    and (select quantity from client_entitlements_for(agp.id('default')) where service_key = 'blog_posts') = 8);
end $$;
\c - supabase_admin
update subscription_items set stripe_price_id = 'price_Ap650' where stripe_subscription_item_id = 'si_ApDefault';
-- A price that stopped saying what the agreement says (Stripe prices are
-- immutable; this stands for a mirror that disagrees).
update stripe_prices set unit_amount_cents = 50000 where stripe_price_id = 'price_Ap650';
\c - postgres
do $$
begin
  perform agp.ok('R10 a bound price whose amount no longer matches is mismatch, and flagged',
    agp.status(agp.id('default')) = 'mismatch' and agp.reasons(agp.id('default')) @> '["agreement_price_mismatch"]');
end $$;
\c - supabase_admin
update stripe_prices set unit_amount_cents = 65000 where stripe_price_id = 'price_Ap650';
\c - postgres
do $$
begin
  perform agp.ok('R11 the subscription now sells the agreement''s price: no agreement signal',
    agp.status(agp.id('default')) = 'ready'
    and not (agp.reasons(agp.id('default')) ?| array['agreement_price_unmapped', 'agreement_price_mismatch']));
end $$;

-- ── P. People: the price and its binding are an admin's ─────────────────────
\c - authenticator
set role authenticated;
select agp.as_user('authenticated', :'member');
do $$
declare e text;
begin
  e := agp.try(format($q$update plans set agreed_amount_cents = 70000 where client_id = %L$q$, agp.id('unbound')));
  perform agp.ok('P1 a member cannot change an agreed price', e like '42501%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('pp650'), agp.id('unbound')));
  perform agp.ok('P2 a member cannot bind a Stripe Price', e like '42501%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = null where client_id = %L$q$, agp.id('legacy')));
  perform agp.ok('P3 a member cannot unbind one', e like '42501%', e);
  e := agp.try(format($q$update plans set notes = 'Member note.' where client_id = %L$q$, agp.id('legacy')));
  perform agp.ok('P4 a member still edits the rest of an agreement', e is null, e);
  perform agp.ok('P5 a member reads the agreement''s price and its readiness',
    (select price_status from client_agreement_price where client_id = agp.id('legacy')) = 'ready');
end $$;
reset role;
set role authenticated;
select agp.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('pp500'), agp.id('unbound')));
  perform agp.ok('P6 an admin cannot bind a price that differs from the agreement either', e like '23514%differs%', e);
  e := agp.try(format($q$update plans set billing_package_price_id = %L where client_id = %L$q$, agp.id('pp650'), agp.id('unbound')));
  perform agp.ok('P7 an admin binds the exact agreed price', e is null and agp.status(agp.id('unbound')) = 'ready', e);
  perform agp.ok('P8 the binding is in the agreement history, with who made it',
    exists (select 1 from client_agreement_events ev join team_members tm on tm.id = ev.actor_team_member_id
            where ev.client_id = agp.id('unbound') and ev.subject = 'plan' and ev.action = 'update'
              and ev.after ->> 'billing_package_price_id' = agp.id('pp650')::text and tm.auth_user_id = '00000000-0000-4000-a000-000000000001'));
end $$;
reset role;

-- ── Q. The portal: the agreed price, the client's own, nothing internal ─────
\c - postgres
insert into agp.saved values ('prior_plan', coalesce((select to_jsonb(p)::text from plans p where client_id = :'ca'), ''));
do $$
begin
  if exists (select 1 from plans where client_id = '00000000-0000-4000-b000-00000000000a') then
    update plans set agreed_amount_cents = 65000, agreed_currency = 'usd', agreed_billing_interval = 'month',
                     agreed_billing_interval_count = 1, billing_package_price_id = null, collection = 'stripe',
                     external_method = null, external_amount_cents = null, external_currency = null, external_interval = null
      where client_id = '00000000-0000-4000-b000-00000000000a';
  else
    insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval, agreed_billing_interval_count)
    values ('00000000-0000-4000-b000-00000000000a', agp.id('std'), 'stripe', 65000, 'usd', 'month', 1);
  end if;
end $$;
\c - authenticator
set role authenticated;
select agp.as_user('authenticated', :'pa');
do $$
declare s record; e text;
begin
  select * into s from portal_billing_summary;
  perform agp.ok('Q1 the portal shows its own agreed plan price (amount, currency, interval)',
    s.agreed_amount_cents = 65000 and s.agreed_currency = 'usd' and s.agreed_interval = 'month' and s.agreed_interval_count = 1,
    row_to_json(s)::text);
  perform agp.ok('Q2 ...and no other client''s', (select count(*) from portal_billing_summary) = 1);
  e := agp.try('select billing_package_price_id from portal_billing_summary');
  perform agp.ok('Q3 the portal view carries no price binding or Stripe id', e like '42703%', e);
  e := agp.try('select * from client_agreement_price');
  perform agp.ok('Q4 a portal contact cannot read the agreement-price read model''s rows',
    e is null and (select count(*) from client_agreement_price) = 0, e);
end $$;
reset role;
\c - postgres
do $$
declare v_prior text := (select v from agp.saved where k = 'prior_plan');
begin
  if v_prior = '' then
    delete from plans where client_id = '00000000-0000-4000-b000-00000000000a';
  else
    update plans p set agreed_amount_cents = (v_prior::jsonb ->> 'agreed_amount_cents')::bigint,
      agreed_currency = v_prior::jsonb ->> 'agreed_currency', agreed_billing_interval = v_prior::jsonb ->> 'agreed_billing_interval',
      agreed_billing_interval_count = (v_prior::jsonb ->> 'agreed_billing_interval_count')::int,
      collection = v_prior::jsonb ->> 'collection', external_method = v_prior::jsonb ->> 'external_method',
      external_amount_cents = (v_prior::jsonb ->> 'external_amount_cents')::bigint,
      external_currency = v_prior::jsonb ->> 'external_currency', external_interval = v_prior::jsonb ->> 'external_interval'
    where p.client_id = '00000000-0000-4000-b000-00000000000a';
  end if;
end $$;

-- Leave nothing behind that the later suites count.
delete from app_settings where key = 'billing';

\o
\pset footer off
select status, count(*) from agp.results group by status order by status;
select n, status, name, detail from agp.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from agp.results where status = 'fail';
  if f > 0 then raise exception '% agreement price check(s) failed', f; end if;
end $$;
