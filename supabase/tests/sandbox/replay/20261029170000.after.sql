-- Replay hook, run as postgres right after 20261029170000: keep what the
-- migration did to the legacy fixtures (checked by client_onboarding.test.sql,
-- section L), then remove them.
create schema ob_replay;
create table ob_replay.tasks as
  select t.id, t.client_id, t.title, t.status::text as status, t.key, t.completed_at, t.notes
  from tasks t where t.client_id in ('0b000000-0000-4000-b000-00000000000a', '0b000000-0000-4000-b000-00000000000b')
    and (t.key in ('brightlocal_lrt', 'brightlocal_lsg') or t.title like '%Metricool%');
create table ob_replay.enrolled as
  select count(*)::int as n from client_onboarding_items
  where client_id in ('0b000000-0000-4000-b000-00000000000a', '0b000000-0000-4000-b000-00000000000b');
delete from clients where id in ('0b000000-0000-4000-b000-00000000000a', '0b000000-0000-4000-b000-00000000000b');
