-- Replay hook, run as postgres right after 0056 is applied: keep what the
-- backfill wrote on the production-shaped clients (checked by
-- client_canva_folders.test.sql, section M), then remove them.
create schema cf_replay;
create table cf_replay.seeded as
  select c.id, c.name, c.status::text as status, c.canva_folder_id, c.canva_used_folder_id
  from clients c
  where c.id in ('3eaa3389-2a33-4004-837c-8aef90404410', '67f110bd-fb6e-4432-8536-7f192df92532',
                 'db9009c2-a04b-4e93-843f-e20c49263b5b', '70211d71-d9f4-46ab-abe2-ef39c41591fb',
                 '102d3b20-2795-44ae-bd64-d1e43916291c', '1e12fc47-731a-4d84-a4f1-4aed777db451',
                 'a88f5ce2-30ac-508b-b217-cf22d277b278', 'd94cfde2-0751-4002-a149-c83b4c6c956d',
                 '9a8e05f5-3d28-4839-9735-79bcdd0e277d');
delete from clients where id in (select id from cf_replay.seeded);
