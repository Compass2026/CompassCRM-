-- Replay hook, run as postgres just before 0056 is applied: the nine clients
-- production holds (ids, names, statuses as of Sept 28 2026), so 0056's
-- backfill runs against the shape it will meet there instead of seeding
-- nothing. 0056.after.sql snapshots the result and removes these rows before
-- the suites run (portal_access counts exactly its two fixture clients).
-- Names and statuses only; no production data beyond that.
insert into clients (id, name, status) values
  ('3eaa3389-2a33-4004-837c-8aef90404410', 'BHG Safety Partners', 'active'),
  ('67f110bd-fb6e-4432-8536-7f192df92532', 'Compass Activation Test (fictional)', 'offboarded'),
  ('db9009c2-a04b-4e93-843f-e20c49263b5b', 'Ginger Huff Interiors', 'launching'),
  ('70211d71-d9f4-46ab-abe2-ef39c41591fb', 'Logic Solar', 'active'),
  ('102d3b20-2795-44ae-bd64-d1e43916291c', 'Lucas Construction', 'launching'),
  ('1e12fc47-731a-4d84-a4f1-4aed777db451', 'Pensacola Equipment Rentals', 'launching'),
  ('a88f5ce2-30ac-508b-b217-cf22d277b278', 'Shewmaker Brothers Masonry', 'launching'),
  ('d94cfde2-0751-4002-a149-c83b4c6c956d', 'Show Me Design', 'active'),
  ('9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'Show Me Electrical', 'active');
