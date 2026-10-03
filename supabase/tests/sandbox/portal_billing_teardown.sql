-- Removes portal_billing_fixtures.sql's rows (see there).
delete from invoices where stripe_invoice_id in ('in_PortalFixA', 'in_PortalFixB');
delete from stripe_customers where stripe_customer_id in ('cus_PortalFixA', 'cus_PortalFixB');
delete from plans where package_id = '00000000-0000-4000-e000-0000000000f1';
delete from package_entitlements where package_id = '00000000-0000-4000-e000-0000000000f1';
delete from billing_packages where id = '00000000-0000-4000-e000-0000000000f1';
delete from client_agreement_events;
