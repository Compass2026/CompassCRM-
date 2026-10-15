-- PROVISIONAL — NOT APPLIED. Run only after migration 20261015040000 is
-- reviewed, accepted and applied (PR #160).
--
-- Adopt delivery standard 1 from October 2026: Tom, 2026-10-14 22:05
-- America/Chicago, "I want to apply them to October" (Executive OS task
-- 367bdeba-7b52-4ce2-adbd-b98347499223, decision message
-- 4f9b5b86-fac6-4b27-9b8d-632eddb572db). Continues every month after.
--
-- What October means, and what it does not:
--   - The full standard, no proration: 8 / 8 Facebook / 8 GBP / 1 refresh per
--     site; BHG's three sites 24 / 24 / 24 / 3.
--   - Work already delivered in October counts toward its site's October
--     target; existing planned work counts as planned, never as done.
--   - Nothing is backdated. Opening October's remaining slots afterwards
--     (plan_delivery_month, or the planner's "Open this month's slots") plans
--     them from that day to October 31 only. No delivery record is written.
--   - Nothing is drafted, scheduled or published by adoption.
--
-- Not included: Lucas Construction (102d3b20-…). The same business standard
-- applies to Lucas; Down and In own its implementation, recorded through
-- onboarding program b6021fd6-5406-481a-b8bd-7395c9f4815b.
--
-- Re-running is a no-op (one row per client and month). Billing, prices and
-- issued agreements are untouched.
insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c.id, s.id, date '2026-10-01',
  'executive_os:task/367bdeba-7b52-4ce2-adbd-b98347499223#message/4f9b5b86-fac6-4b27-9b8d-632eddb572db'
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
