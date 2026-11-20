-- Replay hook, run right after 20261120190000 is applied: keep what the
-- backfill did to the seeded posts (checked by no_image_reason.test.sql,
-- section NI5), then remove the seed (triggers off, as it was written).
\c - supabase_admin
create schema ni_replay;
create table ni_replay.posts as
  select p.id, p.review_status::text as review_status, p.no_image_reason,
         (select count(*) from post_assets pa where pa.post_id = p.id) as media
    from social_posts p where p.client_id = '0c000000-0000-4000-b000-0000000000c1';
create table ni_replay.events as
  select e.post_id, e.actor_kind, e.actor_id, e.kind, e.from_value, e.to_value, e.detail
    from post_events e where e.client_id = '0c000000-0000-4000-b000-0000000000c1';
grant usage on schema ni_replay to postgres;
grant select on all tables in schema ni_replay to postgres;
set session_replication_role = replica;
delete from post_events where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from post_assets where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from social_posts where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from brand_assets where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from social_accounts where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from services where client_id = '0c000000-0000-4000-b000-0000000000c1';
delete from clients where id = '0c000000-0000-4000-b000-0000000000c1';
set session_replication_role = origin;
