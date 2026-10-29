-- Fixtures for tests/onboarding-ui.mjs (scripts/test-tasks-ui.sh), run as
-- postgres after every migration and fixtures.sql. Fictional clients and
-- example.test domains only.
--   U: enrolled on insert; a site and a business location recorded later
--      (their rows arrive through the triggers).
--   V: an existing client from before the checklist (its rows removed here),
--      no site and no location: Start, re-run and the two scope gaps.
--   W: map-tracking only (excluded from automatic enrollment).
insert into clients (id, name, status, website_url) values
  ('0c000000-0000-4000-b000-00000000000a', 'Onboarding UI Sample U', 'active', 'https://ui-sample.example.test'),
  ('0c000000-0000-4000-b000-00000000000b', 'Onboarding UI Sample V', 'active', null);
insert into clients (id, name, status, service_scope) values
  ('0c000000-0000-4000-b000-00000000000c', 'Onboarding UI Map Only W', 'paused', 'map_tracking');
insert into sites (id, client_id, url, stack) values
  ('0c000000-0000-4000-c000-0000000000a1', '0c000000-0000-4000-b000-00000000000a', 'https://ui-sample.example.test', 'other');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone) values
  ('0c000000-0000-4000-d000-0000000000a1', '0c000000-0000-4000-b000-00000000000a', 'Main office (sample)', 'Onboarding UI Sample U LLC', '1 Sample St', 'Springfield', 'MO', '65806', '(417) 555-0190');
delete from client_onboarding_items where client_id = '0c000000-0000-4000-b000-00000000000b';
