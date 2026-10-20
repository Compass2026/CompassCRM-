-- SAMPLE DATA for the Citations browser check (tests/citations-ui.mjs), on top
-- of fixtures.sql. Fictional businesses, 555 numbers and example.test domains
-- only. Never load into production.
update team_members set name = 'Sam Team', role = 'admin' where email = 'sandbox-team@compassmarketing.ai';
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-a000-000000000002', 'jess@compassmarketing.ai', now());
insert into team_members (name, email, role) values ('Jess Rivera', 'jess@compassmarketing.ai', 'member');
update clients set name = 'Sample Roofing (sample)' where id = '00000000-0000-4000-b000-00000000000a';
update clients set name = 'Summit Electric (sample)' where id = '00000000-0000-4000-b000-00000000000b';

insert into citation_locations (id, client_id, label, business_name, address_line1, address_line2, city, region, postal_code, phone, website_url, tracking_location_id) values
  ('00000000-0000-4000-e000-0000000000a1', '00000000-0000-4000-b000-00000000000a', 'Main office (sample)', 'Sample Roofing LLC', '100 North Main Street', '', 'Springfield', 'MO', '65806',
   '(417) 555-0100', 'https://sample-roofing.example.test', '00000000-0000-4000-c000-00000000000a');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone, hide_address) values
  ('00000000-0000-4000-e000-0000000000a2', '00000000-0000-4000-b000-00000000000a', 'North branch (sample)', 'Sample Roofing North', '22 Hidden Way', 'Ozark', 'MO', '65721', '(417) 555-0101', true);
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, phone) values
  ('00000000-0000-4000-e000-0000000000b1', '00000000-0000-4000-b000-00000000000b', 'Summit office (sample)', 'Summit Electric', '9 Elm Street', 'Columbia', 'MO', '(573) 555-0110');
insert into citation_listings (client_id, location_id, directory_id, listing_url, fulfillment_status, source_provider, observed_name) values
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-e000-0000000000b1', (select id from citation_directories where key = 'yelp'),
   'https://www.yelp.com/biz/summit-electric-sample', 'provider_complete', 'manual', 'Summit Electric');
