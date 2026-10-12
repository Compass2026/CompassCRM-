-- CRM Lite rows for the generic portal checks (portal_access.test.sql):
-- each portal view must return the signed-in client's rows and nothing
-- else. Inserted as the cluster superuser (the functions are the only other
-- writers) and removed again by crm_lite_portal_teardown.sql.
insert into crm_lite_settings (client_id, enabled, portal_enabled) values
  ('00000000-0000-4000-b000-00000000000a', true, true),
  ('00000000-0000-4000-b000-00000000000b', true, true);
insert into inquiry_sources (id, client_id, source_key, label, enabled, secret_name) values
  ('00000000-0000-4000-f100-00000000000a', '00000000-0000-4000-b000-00000000000a', 'portal-fixture-a', 'Fixture A website', true, 'CRM_INTAKE_PORTAL_FIXTURE_A'),
  ('00000000-0000-4000-f100-00000000000b', '00000000-0000-4000-b000-00000000000b', 'portal-fixture-b', 'Fixture B website', true, 'CRM_INTAKE_PORTAL_FIXTURE_B');
insert into inquiries (id, client_id, source_id, submission_id, name, email, message, submitted_at, payload_sha256) values
  ('00000000-0000-4000-f200-00000000000a', '00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-f100-00000000000a',
   'fixture-sub-a', 'Visitor A', 'visitor-a@example.test', 'Fixture message A', now(), repeat('a', 64)),
  ('00000000-0000-4000-f200-00000000000b', '00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-f100-00000000000b',
   'fixture-sub-b', 'Visitor B', 'visitor-b@example.test', 'Fixture message B', now(), repeat('b', 64));
insert into inquiry_notes (client_id, inquiry_id, body, author_kind, author_name) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-f200-00000000000a', 'Called back', 'team', 'Fixture teammate'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-f200-00000000000b', 'Called back', 'team', 'Fixture teammate');
insert into inquiry_events (client_id, inquiry_id, kind, to_status, actor_kind, actor_name) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-f200-00000000000a', 'received', 'new', 'website', 'Fixture A website'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-f200-00000000000b', 'received', 'new', 'website', 'Fixture B website');
