-- Billing rollback, step 1: back up everything the down script will drop.
-- Run as postgres (the worker's / MCP's SQL) BEFORE the down script and keep
-- the output with the incident notes. Read-only.
--
-- What is lost by the rollback and is not in Stripe: the agreements (plans,
-- overrides), the package catalog and its entitlements, the agreement and
-- planning history, external payments, the billing audit trail, the
-- reconciliation history. Everything under stripe_* / subscriptions /
-- invoices / payments(source = 'stripe') / stripe_refunds / checkout_sessions
-- is a mirror of Stripe and can be rebuilt from Stripe by re-applying and
-- reconciling; it is backed up anyway for the record.

\echo '== counts'
select 'plans' t, count(*) from plans union all
select 'client_entitlement_overrides', count(*) from client_entitlement_overrides union all
select 'billing_packages', count(*) from billing_packages union all
select 'package_entitlements', count(*) from package_entitlements union all
select 'billing_package_prices', count(*) from billing_package_prices union all
select 'billing_one_time_items', count(*) from billing_one_time_items union all
select 'client_agreement_events', count(*) from client_agreement_events union all
select 'automation_entitlement_log', count(*) from automation_entitlement_log union all
select 'billing_audit_events', count(*) from billing_audit_events union all
select 'payments (external)', count(*) from payments where source = 'external' union all
select 'stripe_customers', count(*) from stripe_customers union all
select 'subscriptions', count(*) from subscriptions union all
select 'invoices', count(*) from invoices union all
select 'payments (stripe)', count(*) from payments where source = 'stripe' union all
select 'stripe_refunds', count(*) from stripe_refunds union all
select 'checkout_sessions', count(*) from checkout_sessions union all
select 'stripe_events', count(*) from stripe_events union all
select 'billing_reconciliation_runs', count(*) from billing_reconciliation_runs;

\echo '== Compass-owned records (not recoverable from Stripe): one JSON document per table'
select 'plans', coalesce(jsonb_agg(to_jsonb(x)), '[]') from plans x;
select 'client_entitlement_overrides', coalesce(jsonb_agg(to_jsonb(x)), '[]') from client_entitlement_overrides x;
select 'billing_packages', coalesce(jsonb_agg(to_jsonb(x)), '[]') from billing_packages x;
select 'package_entitlements', coalesce(jsonb_agg(to_jsonb(x)), '[]') from package_entitlements x;
select 'billing_package_prices', coalesce(jsonb_agg(to_jsonb(x)), '[]') from billing_package_prices x;
select 'billing_one_time_items', coalesce(jsonb_agg(to_jsonb(x)), '[]') from billing_one_time_items x;
select 'client_agreement_events', coalesce(jsonb_agg(to_jsonb(x)), '[]') from client_agreement_events x;
select 'automation_entitlement_log', coalesce(jsonb_agg(to_jsonb(x)), '[]') from automation_entitlement_log x;
select 'billing_audit_events', coalesce(jsonb_agg(to_jsonb(x)), '[]') from billing_audit_events x;
select 'payments_external', coalesce(jsonb_agg(to_jsonb(x)), '[]') from payments x where source = 'external';
select 'app_settings_billing', coalesce(jsonb_agg(to_jsonb(x)), '[]') from app_settings x where key like 'billing%';

\echo '== Stripe mirror (rebuildable from Stripe; kept for the record)'
select 'stripe_customers', coalesce(jsonb_agg(to_jsonb(x)), '[]') from stripe_customers x;
select 'subscriptions', coalesce(jsonb_agg(to_jsonb(x)), '[]') from subscriptions x;
select 'invoices', coalesce(jsonb_agg(to_jsonb(x)), '[]') from invoices x;
select 'payments_stripe', coalesce(jsonb_agg(to_jsonb(x)), '[]') from payments x where source = 'stripe';
select 'stripe_refunds', coalesce(jsonb_agg(to_jsonb(x)), '[]') from stripe_refunds x;
select 'checkout_sessions', coalesce(jsonb_agg(to_jsonb(x)), '[]') from checkout_sessions x;
select 'billing_reconciliation_runs', coalesce(jsonb_agg(to_jsonb(x)), '[]') from billing_reconciliation_runs x;
