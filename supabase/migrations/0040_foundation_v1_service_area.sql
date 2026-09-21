-- Foundation v1 service-area support (Sept 21 2026).
--
-- The first Foundation build for a service-area client stopped dead: the
-- Foundation read `site.address` as required and rendered the street in the
-- footer, on the contact page and in the LocalBusiness JSON-LD with no way to
-- omit it. The worker refused to invent an address, which was right, and the
-- build blocked. The Foundation fixed it: `address.street` and `address.zip`
-- are nullable, and the footer, the contact card and the structured data omit
-- what is absent rather than print an empty line or an empty string.
--
--   Compass2026/showmeelectricalwebsite
--   f928381b3a81e20694571cefc5091392b2c84e86  (merge of PR #1 into
--   claude/template-completion; tree identical to e214dae)
--
-- Pinning the CRM to that commit is all this migration does. `v1` stays the
-- accepted version — the change is additive to the brand contract (a field
-- that was required is now optional; every existing brand config still type
-- checks) — so `foundation_releases` keeps one v1 row and moves its SHA.
--
-- Verified before pinning: FRESH=1 npm run verify at this commit, whole
-- (both brands, type checks, lint, crawl fixtures, provider suite, build,
-- crawl, mocked forms, browser, production guards). See
-- docs/compass-foundation-integration.md "Service-area support".

update foundation_releases
set source_sha = 'f928381b3a81e20694571cefc5091392b2c84e86',
    accepted_on = '2026-09-21',
    notes = 'Accepted Sept 20 2026; moved to f928381 on Sept 21 2026 for service-area support (address.street and address.zip nullable — a business that goes to the customer has no public street address and one is never invented). Reference client Show Me Electrical; Harbor Lane is a fictional demonstration brand whose facts, copy, assets and routes are never reused. Verify with FRESH=1 npm run verify.'
where version = 'v1';
