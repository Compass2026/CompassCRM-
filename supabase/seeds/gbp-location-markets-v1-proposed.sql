-- PROVISIONAL — NOT APPLIED. Run only after migration 20261027160000 is
-- reviewed, accepted and applied (PR #192).
--
-- Business Profile location markets (gbp_location_markets): which city
-- keywords may be posted to which verified location. As of Oct 27 2026 every
-- active / launching client has exactly one verified location in the CRM, so
-- core_market_problem() refuses nothing today; these rows matter once a second
-- location is bound (Logic Overland Park, after its verification hold).
--
--   Logic Solar · Wichita (locations/6226831491529440170): its office market
--     only, so Kansas City / Overland Park keywords never go to the Wichita
--     profile while the Overland Park profile stays on hold. Austin is
--     excluded and gets no row.
--   BHG Safety Partners · shared Hannibal HQ (locations/8807181124955207538):
--     one profile shared by the three brand sites, whose city pages are
--     service markets (training travels to the client) — 'all', the existing
--     shared-profile arrangement, recorded rather than changed.
--
-- Not here, on purpose: Show Me Design's two studios and Ginger Huff's
-- profiles (not bound; Ginger's location structure is unresolved), and every
-- single-location client (no row needed). Nothing is bound, enabled or
-- un-held. Re-running is a no-op.
insert into gbp_location_markets (client_id, social_account_id, market, kind, source_ref)
select sa.client_id, sa.id, v.market, v.kind, v.source_ref
from (values
  ('ee84d86f-3ec4-49b7-95e2-5e98239737ca'::uuid, 'Wichita', 'office',
   'Wichita office (logic-solar.com/locations/kansas/wichita, 307 S Prescott Cir). Proposed for review: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'),
  ('99ec3c6d-aeb6-477e-8a22-d30eb81a83bf'::uuid, 'All BHG service markets', 'all',
   'Shared Hannibal HQ profile for the Safety, Forklift and Heavy Equipment sites; city pages are service markets. Proposed for review: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3')
) v(account_id, market, kind, source_ref)
join social_accounts sa on sa.id = v.account_id and sa.platform::text = 'google_business'
where not exists (select 1 from gbp_location_markets m where m.social_account_id = sa.id and lower(btrim(m.market)) = lower(btrim(v.market)));
