-- SAMPLE DATA for the Citations pilot rehearsal (tests/citations-pilot.mjs), on
-- top of fixtures.sql. No citation rows: the rehearsal enters the identity and
-- imports through the UI. Never load into production.
update team_members set name = 'Sam Team', role = 'admin' where email = 'sandbox-team@compassmarketing.ai';
update clients set name = 'Sample Solar (sandbox)' where id = '00000000-0000-4000-b000-00000000000a';
