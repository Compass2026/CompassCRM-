-- Extra synthetic data for the tasks browser check (tests/tasks-ui.mjs), on
-- top of fixtures.sql. Fictional names and example.test addresses only.
-- The team account from bootstrap.sql is renamed so screenshots read well.

update team_members set name = 'Sam Team' where email = 'sandbox-team@compassmarketing.ai';
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-000000000002', 'jess@compassmarketing.ai', now());
insert into team_members (name, email, role) values ('Jess Rivera', 'jess@compassmarketing.ai', 'member');

update clients set name = 'Harbor Lane Plumbing' where id = '00000000-0000-4000-b000-00000000000a';
update clients set name = 'Summit Electric' where id = '00000000-0000-4000-b000-00000000000b';

-- Written with no JWT, like the worker and the pipeline triggers.
insert into tasks (client_id, title, owner, due_date, notes) values
  ('00000000-0000-4000-b000-00000000000a', 'Collect job-site photos from the client', 'TOM', current_date - 3, null),
  ('00000000-0000-4000-b000-00000000000b', 'Confirm holiday hours for the GBP', 'TOM', current_date + 5, null),
  ('00000000-0000-4000-b000-00000000000b', 'Draft September blog post', 'CLAUDE', current_date + 1, null);
insert into tasks (client_id, title, owner, autonomy_level, recommendation) values
  ('00000000-0000-4000-b000-00000000000b', 'Approve the GBP primary category', 'CLAUDE_APPROVAL', 'hold', 'Switch to Electrician');
insert into tasks (client_id, title, owner, key) values
  ('00000000-0000-4000-b000-00000000000a', 'Client review of the staging site', 'TOM', 'client_review');
update tasks set assignee_id = (select id from team_members where email = 'jess@compassmarketing.ai')
where title = 'Confirm holiday hours for the GBP';

select vault.create_secret('https://routine.example.test/fire', 'ROUTINE_FIRE_URL');
select vault.create_secret('not-a-real-token', 'ROUTINE_FIRE_TOKEN');
