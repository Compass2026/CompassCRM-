-- Removes crm_lite_portal_fixtures.sql's rows (see there).
delete from inquiries where id in ('00000000-0000-4000-f200-00000000000a', '00000000-0000-4000-f200-00000000000b');
delete from inquiry_sources where id in ('00000000-0000-4000-f100-00000000000a', '00000000-0000-4000-f100-00000000000b');
delete from crm_lite_settings where client_id in ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-b000-00000000000b');
