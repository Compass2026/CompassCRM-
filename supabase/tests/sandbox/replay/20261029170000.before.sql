-- Replay hook, run as postgres just before 20261029170000 (New Client
-- Onboarding) is applied: two fictional clients carrying the legacy tasks the
-- migration relabels, one open and one done of each, so the suite can prove
-- open tasks are labelled and completed ones are left exactly as they were.
-- 20261029170000.after.sql snapshots them and removes the clients.
insert into clients (id, name, status) values
  ('0b000000-0000-4000-b000-00000000000a', 'Onboarding Legacy Sample A (fictional)', 'launching'),
  ('0b000000-0000-4000-b000-00000000000b', 'Onboarding Legacy Sample B (fictional)', 'launching');
insert into client_pipelines (client_id, pipeline_id)
select c.id, p.id from clients c cross join pipelines p
where p.key = 'social' and c.id in ('0b000000-0000-4000-b000-00000000000a', '0b000000-0000-4000-b000-00000000000b');
-- create_stage_tasks copies templates at enrollment; make sure both have the Metricool task.
insert into tasks (client_id, client_stage_id, title, owner, status)
select cp.client_id, cs.id, 'Connect Metricool', 'TOM', 'open'
from client_pipelines cp join client_stages cs on cs.client_pipeline_id = cp.id
join stages s on s.id = cs.stage_id and s.name = 'Brand & Content Setup'
join pipelines p on p.id = cp.pipeline_id and p.key = 'social'
where cp.client_id in ('0b000000-0000-4000-b000-00000000000a', '0b000000-0000-4000-b000-00000000000b')
  and not exists (select 1 from tasks t where t.client_stage_id = cs.id and t.title = 'Connect Metricool');
update tasks set status = 'done', completed_at = '2026-09-20 15:00:00+00', notes = 'Connected (sample)'
where client_id = '0b000000-0000-4000-b000-00000000000b' and title = 'Connect Metricool';
insert into tasks (client_id, title, owner, status, key, completed_at, notes) values
  ('0b000000-0000-4000-b000-00000000000a', 'BrightLocal Local Rank Tracker report created for the tracked list (billable); id stored on the location', 'TOM', 'open', 'brightlocal_lrt', null, null),
  ('0b000000-0000-4000-b000-00000000000a', 'BrightLocal Local Search Grid report created from the geo-grid config (billable); id stored on the grid config', 'TOM', 'done', 'brightlocal_lsg', '2026-09-21 15:00:00+00', 'LSG 123 (sample)');
