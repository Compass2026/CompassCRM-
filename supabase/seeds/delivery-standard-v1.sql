-- Adopt delivery standard 1 (migration 20261015040000) for the current
-- clients, from the first full month after Tom's decision of 2026-10-14.
-- A data script, not a migration: run once after the migration is applied and
-- reviewed. Re-running is a no-op (one row per client and month).
--
-- Not included: Lucas Construction (102d3b20-…). Down and In owns Lucas; the
-- standard applies to Lucas too, and is recorded for it through onboarding
-- program b6021fd6-5406-481a-b8bd-7395c9f4815b when they are ready.
--
-- No backfill: October 2026 keeps its existing plan. Nothing here schedules,
-- drafts or publishes; billing, prices and issued agreements are untouched.
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c.id, s.id, date '2026-11-01',
  'executive_os:task/367bdeba-7b52-4ce2-adbd-b98347499223#message/7251fd3a-1326-4a79-81c0-1b13afa69c0c'
from clients c cross join (select id from delivery_standards where version = 1) s
where c.id in (
  '3eaa3389-2a33-4004-837c-8aef90404410',  -- BHG Safety Partners LLC (three brand sites)
  'db9009c2-a04b-4e93-843f-e20c49263b5b',  -- Ginger Huff Interiors
  '70211d71-d9f4-46ab-abe2-ef39c41591fb',  -- Logic Solar
  '1e12fc47-731a-4d84-a4f1-4aed777db451',  -- Pensacola Equipment Rentals
  '20bf08d1-d341-4236-bd4c-d46396948993',  -- Resilient Boxing
  'a88f5ce2-30ac-508b-b217-cf22d277b278',  -- Shewmaker Brothers Masonry
  'd94cfde2-0751-4002-a149-c83b4c6c956d',  -- Show Me Design
  '9a8e05f5-3d28-4839-9735-79bcdd0e277d'   -- Show Me Electrical
) and c.status in ('active', 'launching')
on conflict (client_id, effective_month) do nothing;
